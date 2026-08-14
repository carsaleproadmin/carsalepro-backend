import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderContract, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { renderContractPdf } from './contract-pdf.renderer';
import { CONTRACT_TEMPLATES, ContractKey } from './legal-contracts.content';

/**
 * Render attempts after which the backfill gives up on a contract. A template
 * that cannot be rendered will not start working on the hundredth try, and an
 * unbounded retry turns one bad row into a permanent hourly job.
 */
const MAX_PDF_ATTEMPTS = 5;

/** Public projection of an order's contract, returned to either party or an admin. */
export interface ContractView {
  orderId: string;
  templateKey: string;
  templateVersion: number;
  locale: string;
  html: string;
  pdfReady: boolean;
  createdAt: string;
}

@Injectable()
export class LegalContractService {
  private readonly logger = new Logger(LegalContractService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  /**
   * Give the contract template key for an order.
   *
   * Every order gets `contract_en`. The country code is not used.
   *
   * Before 2026-08-12 this mapped DE to `contract_de` and other EU member
   * states to `contract_eu`. The owner decided that all orders use one
   * agreement, in English, because English is the language both parties can
   * read when the customer, the inspector and the vehicle are in different
   * countries. The `contract_de` and `contract_eu` rows stay in the database:
   * contracts rendered before this date point to them, and an admin can still
   * see them.
   *
   * The parameter stays in the signature. The callers give the country code,
   * and a later decision can make this a mapping again.
   */
  resolveTemplateKey(_countryCode: string): ContractKey {
    return 'contract_en';
  }

  /**
   * Render (and persist) the inspection brokerage contract for an order.
   * Idempotent: if the order already has a contract, the existing OrderContract is
   * returned untouched. Otherwise the ACTIVE template for the resolved key is loaded
   * (falling back to contract_en's active template), placeholders are substituted
   * from the order/customer/inspector data, the result is converted to a self-
   * contained HTML document, best-effort stored to R2, and an OrderContract row is
   * created and linked to the order.
   */
  async renderContractForOrder(orderId: string): Promise<OrderContract> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }

    // Idempotency: a contract already exists for this order → return it.
    if (order.contractId) {
      const existing = await this.prisma.orderContract.findUnique({
        where: { id: order.contractId },
      });
      if (existing) return existing;
    }

    const customer = await this.prisma.user.findUnique({
      where: { id: order.customerId },
      select: { name: true, email: true },
    });

    let inspectorName: string | null = null;
    let inspectorCompany: string | null = null;
    let inspectorTaxId: string | null = null;
    let inspectorVatId: string | null = null;
    if (order.inspectorId) {
      const profile = await this.prisma.inspectorProfile.findUnique({
        where: { userId: order.inspectorId },
        select: {
          companyName: true,
          taxId: true,
          vatId: true,
          user: { select: { name: true } },
        },
      });
      inspectorName = profile?.user?.name ?? null;
      inspectorCompany = profile?.companyName ?? null;
      inspectorTaxId = profile?.taxId ?? null;
      inspectorVatId = profile?.vatId ?? null;
    }

    const key = this.resolveTemplateKey(order.countryCode);
    const template = await this.loadActiveTemplate(key);

    const placeholders: Record<string, string> = {
      orderNumber: order.number,
      contractDate: formatDate(new Date()),
      customerName: customer?.name ?? customer?.email ?? '—',
      inspectorName: inspectorName ?? '—',
      inspectorCompany: inspectorCompany ? ` (${inspectorCompany})` : '',
      vehicle: `${order.make} ${order.model}`.trim(),
      vin: order.vin ?? '—',
      address: order.address,
      scheduledAt: formatDate(order.scheduledAt),
      totalEur: centsToEur(order.totalCents),
      platformFeeEur: centsToEur(order.platformFeeCents),
      inspectorShareEur: centsToEur(order.inspectorShareCents),
      inspectorTaxId: inspectorTaxId ?? '—',
      inspectorVatId: inspectorVatId ?? '—',
    };

    const substituted = substitutePlaceholders(template.bodyMd, placeholders);
    const html = markdownToHtmlDocument(substituted, template.title, template.locale);

    // Best-effort storage to R2 — never break the flow if storage is unavailable.
    const htmlKey = `contracts/${orderId}/v${template.version}.html`;
    let htmlS3Key: string | null = null;
    if (this.r2.isConfigured()) {
      try {
        await this.r2.putObject(htmlKey, html, 'text/html; charset=utf-8');
        htmlS3Key = htmlKey;
      } catch (err) {
        this.logger.warn(
          `Failed to store contract HTML for order ${orderId}: ${(err as Error).message}`,
        );
      }
    }

    const contract = await this.prisma.orderContract.create({
      data: {
        templateKey: template.key,
        templateVersion: template.version, // FROZEN — the template version at render time
        renderedHtml: html,
        // Frozen source for BOTH renderings, so the PDF cannot say something
        // different from the HTML, now or on a later re-render.
        bodyMd: substituted,
        // The key used to be computed and then thrown away, leaving the archived
        // object unreachable. Persist it only when the upload actually happened.
        htmlS3Key,
        pdfS3Key: null,
      },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { contractId: contract.id },
    });

    // Inline, best-effort. ~80 ms, and a PDF failure must leave the HTML
    // contract and the assignment untouched — the hourly backfill picks it up.
    await this.renderPdfForContract(contract.id);

    return this.prisma.orderContract.findUniqueOrThrow({ where: { id: contract.id } });
  }

  /**
   * Render and archive the PDF for a contract. Idempotent — a contract that
   * already has a `pdfS3Key` is left alone. Never throws: the caller is either
   * the ASSIGNED transition (which must not be undone by a rendering problem) or
   * a cron batch (which must not stop on one bad row).
   *
   * @returns true when a PDF exists after this call.
   */
  async renderPdfForContract(contractId: string): Promise<boolean> {
    const contract = await this.prisma.orderContract.findUnique({
      where: { id: contractId },
      include: { order: { select: { id: true, number: true } } },
    });
    if (!contract) return false;
    if (contract.pdfS3Key) return true;
    if (!this.r2.isConfigured()) return false;
    if (!contract.bodyMd) {
      // Pre-dates the frozen-markdown column. Re-substituting from today's order
      // data could produce a document that differs from the signed HTML, so
      // refuse rather than archive something misleading.
      this.logger.warn(
        `Contract ${contractId} has no frozen markdown — skipping PDF (created before body_md)`,
      );
      return false;
    }

    const orderId = contract.order?.id ?? contractId;
    try {
      const template = await this.prisma.legalTemplate.findFirst({
        where: { key: contract.templateKey, version: contract.templateVersion },
        select: { title: true, locale: true },
      });
      const fallback = CONTRACT_TEMPLATES[contract.templateKey as ContractKey];

      const pdf = await renderContractPdf(contract.bodyMd, {
        title: template?.title ?? fallback?.title ?? 'Contract',
        orderNumber: contract.order?.number ?? '—',
        locale: template?.locale ?? fallback?.locale ?? 'en',
        renderedAt: new Date(),
      });

      const key = `contracts/${orderId}/v${contract.templateVersion}.pdf`;
      await this.r2.putObject(key, pdf, 'application/pdf');
      await this.prisma.orderContract.update({
        where: { id: contractId },
        data: {
          pdfS3Key: key,
          pdfRenderedAt: new Date(),
          pdfLastError: null,
        },
      });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.orderContract
        .update({
          where: { id: contractId },
          data: {
            pdfAttempts: { increment: 1 },
            pdfLastError: message.slice(0, 500),
          },
        })
        .catch(() => undefined);
      this.logger.warn(`Contract PDF render failed for ${contractId}: ${message}`);
      return false;
    }
  }

  /**
   * Re-render contracts whose PDF is missing. Driven by the hourly cron.
   * Skips anything past the attempt cap so a permanently broken template does
   * not get retried forever.
   */
  async backfillMissingPdfs(limit = 50): Promise<{ attempted: number; rendered: number }> {
    if (!this.r2.isConfigured()) return { attempted: 0, rendered: 0 };

    const pending = await this.prisma.orderContract.findMany({
      where: {
        pdfS3Key: null,
        pdfAttempts: { lt: MAX_PDF_ATTEMPTS },
        // Contracts predating the frozen-markdown column can never render (see
        // renderPdfForContract). Excluding them is not just an optimisation:
        // they are the OLDEST rows, so with `orderBy: createdAt asc` they would
        // fill every batch forever and starve contracts that could succeed.
        bodyMd: { not: null },
        // Give the inline attempt a chance to have finished first.
        createdAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    let rendered = 0;
    for (const { id } of pending) {
      if (await this.renderPdfForContract(id)) rendered += 1;
    }
    return { attempted: pending.length, rendered };
  }

  /**
   * A short-lived signed URL for the archived PDF. Uses the PRIVATE signer: a
   * contract names both parties and their addresses, so it must never be served
   * from the bucket's public URL even if one is configured.
   */
  async getContractPdfUrl(
    orderId: string,
    userId: string,
    role?: Role,
  ): Promise<{ signedUrl: string; expiresAt: string }> {
    // Reuse the access check — customer, assigned inspector or admin only.
    const view = await this.getContractForOrder(orderId, userId, role);
    if (!view.pdfReady) {
      throw new NotFoundException({
        error: { code: 'pdf_not_ready', message: 'The contract PDF is not available yet' },
      });
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { contractId: true },
    });
    const contract = await this.prisma.orderContract.findUniqueOrThrow({
      where: { id: order.contractId! },
      select: { pdfS3Key: true },
    });

    const { url, expiresAt } = await this.r2.createPrivateSignedUrl(contract.pdfS3Key!);
    return { signedUrl: url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Access-controlled view of an order's contract. Allowed for the order's customer,
   * the assigned inspector, or an admin; otherwise 403. 404 (contract_not_ready) if
   * the order has no contract yet.
   */
  async getContractForOrder(
    orderId: string,
    userId: string,
    role?: Role,
  ): Promise<ContractView> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }

    const isCustomer = order.customerId === userId;
    const isInspector = order.inspectorId === userId;
    const isAdmin = role === Role.ADMIN;
    if (!isCustomer && !isInspector && !isAdmin) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }

    if (!order.contractId) {
      throw new NotFoundException({
        error: { code: 'contract_not_ready', message: 'Contract has not been generated yet' },
      });
    }

    const contract = await this.prisma.orderContract.findUnique({
      where: { id: order.contractId },
    });
    if (!contract) {
      throw new NotFoundException({
        error: { code: 'contract_not_ready', message: 'Contract has not been generated yet' },
      });
    }

    const template = await this.prisma.legalTemplate.findFirst({
      where: { key: contract.templateKey, version: contract.templateVersion },
      select: { locale: true },
    });

    return {
      orderId,
      templateKey: contract.templateKey,
      templateVersion: contract.templateVersion,
      locale: template?.locale ?? CONTRACT_TEMPLATES[contract.templateKey as ContractKey]?.locale ?? 'en',
      html: contract.renderedHtml,
      pdfReady: contract.pdfS3Key !== null,
      createdAt: contract.createdAt.toISOString(),
    };
  }

  /**
   * Load the active template for a key, falling back to the active contract_en
   * template if the resolved key has none. Throws a clear error if neither exists.
   */
  private async loadActiveTemplate(
    key: ContractKey,
  ): Promise<{ key: string; version: number; title: string; bodyMd: string; locale: string }> {
    let template = await this.prisma.legalTemplate.findFirst({
      where: { key, active: true },
      orderBy: { version: 'desc' },
    });
    if (!template && key !== 'contract_en') {
      template = await this.prisma.legalTemplate.findFirst({
        where: { key: 'contract_en', active: true },
        orderBy: { version: 'desc' },
      });
    }
    if (!template) {
      throw new NotFoundException({
        error: {
          code: 'no_contract_template',
          message: `No active legal template for ${key} (and no contract_en fallback)`,
        },
      });
    }
    return {
      key: template.key,
      version: template.version,
      title: template.title,
      bodyMd: template.bodyMd,
      locale: template.locale,
    };
  }
}

// ============================================================
// Pure helpers
// ============================================================

/** Integer cents → "€X.XX". */
export function centsToEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

/** Date → a readable "YYYY-MM-DD". */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Replace every {{token}} with its value (missing tokens → empty string). */
function substitutePlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => values[name] ?? '');
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESCAPE[c]);
}

/** Inline formatting: **bold**, *italic*. Operates on already-escaped text. */
function inlineFormat(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/**
 * Minimal markdown → HTML converter (no external dependency). Supports headings
 * (#, ##, ###), unordered lists (- / *), **bold**, *italic*, paragraphs and line
 * breaks. Deliberately small — sufficient for the structured contract templates.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listOpen = false;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(inlineFormat).join('<br />')}</p>`);
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = /^[-*]\s+(.*)$/.exec(line.trim());
    if (listItem) {
      flushParagraph();
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inlineFormat(listItem[1])}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  return out.join('\n');
}

/** Wrap rendered markdown in a minimal, print-friendly HTML document. */
export function markdownToHtmlDocument(md: string, title: string, locale: string): string {
  const body = markdownToHtml(md);
  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: #1a1a1a; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    line-height: 1.55; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 24px; margin: 0 0 16px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  h3 { font-size: 15px; margin: 20px 0 6px; }
  p { margin: 0 0 12px; }
  ul { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 0 0 4px; }
  strong { font-weight: 600; }
  @media print { main { max-width: none; padding: 0; } }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
