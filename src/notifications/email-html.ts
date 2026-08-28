/**
 * Dependency-free plain-text → HTML rendering for transactional email.
 *
 * Deliberately tiny: a rendered notification body (see notification-templates.ts)
 * is plain text with blank-line-separated paragraphs and the occasional bare URL.
 * Every provider wants a `html` part alongside `text` — without one, deliverability
 * scoring suffers and some clients render the mail as an attachment.
 *
 * The same escape-then-wrap shape is used by `LegalContractService`'s
 * markdown→HTML renderer; this is a separate, intentionally simpler copy because
 * `src/legal` owns contract rendering and must not become a notifications
 * dependency (that direction would create a module cycle — notifications is
 * @Global and legal already emits notifications).
 */

/** Escape the five characters that can break out of HTML text/attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s) URLs only — never `javascript:` / `data:` — already-escaped input. */
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g;

/**
 * Turn already-escaped text into paragraphs, linkifying bare http(s) URLs.
 * Single newlines become `<br />`, blank lines start a new `<p>`.
 */
function paragraphs(escaped: string): string {
  return escaped
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const linked = block.replace(
        URL_RE,
        (url) => `<a href="${url}" style="color:#1a56db">${url}</a>`,
      );
      return `<p>${linked.replace(/\n/g, '<br />')}</p>`;
    })
    .join('\n');
}

/**
 * The letter's one action, as a button (DEN-200).
 *
 * A table and not a `<div>`: Outlook on Windows renders through Word, which
 * ignores padding on a block element, and the button would collapse to bare
 * underlined text. The table is the shape every email framework converges on
 * for the same reason.
 *
 * The URL is escaped like any other attribute value and is only ever emitted
 * when it is an http(s) URL - the same rule the linkifier applies, enforced
 * here separately because this one lands in an `href` the reader is being
 * invited to click.
 */
function ctaButton(cta: { url: string; label: string }): string {
  if (!/^https?:\/\//i.test(cta.url)) return '';
  const href = escapeHtml(cta.url);
  const label = escapeHtml(cta.label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
<tr><td style="border-radius:8px;background:#1a56db;">
<a href="${href}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
</td></tr>
</table>`;
}

/**
 * Wrap a rendered notification (subject + plain-text body, and optionally one
 * call to action) in a minimal, client-safe HTML document. Inline styles only -
 * Gmail strips `<style>` blocks in some contexts and no email client can be
 * relied on for external CSS.
 *
 * The button does NOT replace the plain link in the body: both are rendered, so
 * a reader whose client blocks the button - or who is reading the text part -
 * still has a URL they can copy.
 */
export function renderEmailHtml(message: {
  subject: string;
  body: string;
  cta?: { url: string; label: string };
}): string {
  const { subject, body, cta } = message;
  const safeSubject = escapeHtml(subject);
  const button = cta ? ctaButton(cta) : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;">
<div style="max-width:600px;margin:0 auto;padding:24px 20px 40px;color:#1a1a1a;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Arial,sans-serif;font-size:15px;line-height:1.55;">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${safeSubject}</h1>
${button}
${paragraphs(escapeHtml(body))}
<p style="margin:32px 0 0;font-size:12px;color:#6b7280;">CarSalePro</p>
</div>
</body>
</html>`;
}
