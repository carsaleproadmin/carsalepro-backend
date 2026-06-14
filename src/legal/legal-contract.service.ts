import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderContract, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { CONTRACT_TEMPLATES, ContractKey } from './legal-contracts.content';

/** ISO codes of the EU member states (used to resolve the EU contract template). */
const EU_MEMBER_STATES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

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
   * Map an order's country code to the contract template key.
   * DE → contract_de; any other EU member state → contract_eu; otherwise →
   * contract_en. DE is checked first so it never falls through to the EU template.
   */
  resolveTemplateKey(countryCode: string): ContractKey {
    const code = (countryCode ?? '').toUpperCase();
    if (code === 'DE') return 'contract_de';
    if (EU_MEMBER_STATES.has(code)) return 'contract_eu';
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
    const s3Key = `contracts/${orderId}/v${template.version}.html`;
    if (this.r2.isConfigured()) {
      try {
        await this.r2.putObject(s3Key, html, 'text/html; charset=utf-8');
      } catch (err) {
        this.logger.warn(
          `Failed to store contract HTML for order ${orderId}: ${(err as Error).message}`,
        );
      }
    }

    // TODO(E11): render PDF in worker (set pdfS3Key once the PDF exists).
    const contract = await this.prisma.orderContract.create({
      data: {
        templateKey: template.key,
        templateVersion: template.version, // FROZEN — the template version at render time
        renderedHtml: html,
        pdfS3Key: null,
      },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { contractId: contract.id },
    });

    return contract;
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
