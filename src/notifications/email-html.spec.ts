import { renderEmailHtml } from './email-html';

/*
 * DEN-200. The HTML part of a letter.
 *
 * The plain-text part is what the template writes and is asserted where the
 * template lives. What is asserted here is the two things this file adds and
 * can get wrong on its own: that a hostile string cannot break out of the
 * document, and that the button never becomes the ONLY way to act on a letter.
 */

describe('renderEmailHtml', () => {
  it('renders the button and the plain link, never one instead of the other', () => {
    const html = renderEmailHtml({
      subject: 'Confirm your email address',
      body: 'Open this: https://carsalepro.de/verify?token=abc\n\nThanks.',
      cta: { url: 'https://carsalepro.de/verify?token=abc', label: 'Confirm my email address' },
    });

    // Twice: once in the button, once in the linkified body. A client that
    // strips the button, or a reader on the text part, still has a URL.
    expect(html.match(/href="https:\/\/carsalepro\.de\/verify\?token=abc"/g)).toHaveLength(2);
    expect(html).toContain('Confirm my email address');
  });

  it('puts the button ABOVE the text it is asking about', () => {
    const html = renderEmailHtml({
      subject: 'Confirm your email address',
      body: 'Some words first.',
      cta: { url: 'https://example.com/x', label: 'Do the thing' },
    });
    expect(html.indexOf('Do the thing')).toBeLessThan(html.indexOf('Some words first.'));
  });

  it('renders nothing extra when there is no call to action', () => {
    // Every other notification type takes this path and must be unchanged.
    const html = renderEmailHtml({ subject: 'Order placed', body: 'Your order is placed.' });
    expect(html).not.toContain('<table');
    expect(html).toContain('<p>Your order is placed.</p>');
  });

  it('drops a button whose URL is not http(s)', () => {
    /*
     * A `javascript:` or `data:` href in an email is the one place where a
     * templating mistake becomes an attack the reader is being INVITED to
     * click. The letter still carries its text, so nothing silently vanishes
     * except the button.
     */
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x', '/verify?token=abc']) {
      const html = renderEmailHtml({
        subject: 'Confirm',
        body: 'Body.',
        cta: { url, label: 'Click' },
      });
      expect(html).not.toContain('<table');
      expect(html).toContain('Body.');
    }
  });

  it('escapes a subject, a body and a label that try to leave their context', () => {
    const html = renderEmailHtml({
      subject: '<script>bad()</script>',
      body: 'a & b <img src=x>',
      cta: { url: 'https://example.com/"><script>x</script>', label: '<b>Go</b>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Go</b>');
    expect(html).toContain('&amp;');
    // The quote in the URL is escaped, so it cannot close the href attribute.
    expect(html).not.toMatch(/href="[^"]*"><script/);
  });
});
