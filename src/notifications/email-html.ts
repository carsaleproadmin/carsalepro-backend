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
 * Wrap a rendered notification (subject + plain-text body) in a minimal,
 * client-safe HTML document. Inline styles only — Gmail strips `<style>` blocks
 * in some contexts and no email client can be relied on for external CSS.
 */
export function renderEmailHtml(subject: string, body: string): string {
  const safeSubject = escapeHtml(subject);
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
${paragraphs(escapeHtml(body))}
<p style="margin:32px 0 0;font-size:12px;color:#6b7280;">CarSalePro</p>
</div>
</body>
</html>`;
}
