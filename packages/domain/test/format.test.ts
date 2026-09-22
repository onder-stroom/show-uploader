import { describe, it, expect } from 'vitest';
import { baseTitle, appendHashtags, tagsToHashtags, htmlToText, sanitizeForYoutube, capTitle } from '../src/format';

describe('baseTitle — plain title for PocketBase, no convention suffix', () => {
  it('strips a "<date> @ coming soon" suffix as one unit', () => {
    expect(baseTitle('Misharog 10.07.2026 @ coming soon')).toBe('Misharog');
  });

  it('strips "@ coming soon" even without a date', () => {
    expect(baseTitle('Some Show @ coming soon')).toBe('Some Show');
  });

  it('keeps a bare trailing date that is part of the real name', () => {
    expect(baseTitle('New Year 31.12.2025')).toBe('New Year 31.12.2025');
  });

  it('leaves a plain title untouched', () => {
    expect(baseTitle('RADIO DADA')).toBe('RADIO DADA');
  });

  it('is idempotent (no double-strip)', () => {
    expect(baseTitle(baseTitle('X 01.02.2026 @ coming soon'))).toBe('X');
  });
});

describe('tags → hashtags', () => {
  it('renders tags as hashtags, stripping spaces/punctuation', () => {
    expect(tagsToHashtags(['deep house', 'techno'])).toBe('#deephouse #techno');
  });

  it('drops single-char/empty tags and caps at 10', () => {
    const many = ['!', ...Array.from({ length: 15 }, (_, i) => `tag${i}`)];
    const out = tagsToHashtags(many);
    expect(out.startsWith('#tag0')).toBe(true);
    expect(out.split(' ')).toHaveLength(10);
  });

  it('appends hashtags to a description', () => {
    expect(appendHashtags('hello', ['house'])).toBe('hello\n\n#house');
  });

  it('returns the description unchanged when there are no usable tags', () => {
    expect(appendHashtags('hello', [])).toBe('hello');
    expect(appendHashtags('hello', ['!'])).toBe('hello');
  });
});

describe('htmlToText — rich-text description → plain text for platforms', () => {
  it('strips the react-admin-style paragraph/span wrapper', () => {
    expect(htmlToText('<p><span style="color: rgb(107, 114, 128);">A summer hangout.</span></p>')).toBe(
      'A summer hangout.'
    );
  });

  it('turns <br> and block ends into newlines, collapsing runs', () => {
    expect(htmlToText('<p>line one</p><p>line two</p>')).toBe('line one\nline two');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('renders list items with bullets', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('• one\n• two');
  });

  it('decodes the common HTML entities', () => {
    expect(htmlToText('<p>rock &amp; roll &lt;3 &quot;x&quot; it&#39;s</p>')).toBe('rock & roll <3 "x" it\'s');
  });

  it('passes plain text through unchanged', () => {
    expect(htmlToText('just plain text')).toBe('just plain text');
    expect(htmlToText('')).toBe('');
  });

  // Platform descriptions are plain text, so a link's address has to be written
  // out — otherwise "our mixcloud" arrives as dead words on YouTube.
  describe('links', () => {
    it('writes the address out after the anchor text', () => {
      expect(htmlToText('<p>find us on <a href="https://mixcloud.com/cs">mixcloud</a></p>')).toBe(
        'find us on mixcloud (https://mixcloud.com/cs)'
      );
    });

    it("doesn't repeat an address that is already the anchor text", () => {
      expect(htmlToText('<p><a href="https://mixcloud.com/cs">https://mixcloud.com/cs</a></p>')).toBe(
        'https://mixcloud.com/cs'
      );
      expect(htmlToText('<p><a href="https://mixcloud.com/cs">mixcloud.com/cs</a></p>')).toBe(
        'https://mixcloud.com/cs'
      );
    });

    it('keeps query strings intact through entity decoding', () => {
      expect(htmlToText('<p><a href="https://x.be/a?b=1&amp;c=2">tickets</a></p>')).toBe(
        'tickets (https://x.be/a?b=1&c=2)'
      );
    });

    it('handles several links and markup inside the anchor', () => {
      expect(
        htmlToText('<p><a href="https://a.be">A</a> and <a href="https://b.be"><strong>B</strong></a></p>')
      ).toBe('A (https://a.be) and B (https://b.be)');
    });

    it('falls back to the text when there is no address', () => {
      expect(htmlToText('<p><a href="">nothing</a></p>')).toBe('nothing');
    });
  });
});

describe('sanitizeForYoutube — YouTube rejects < and > in title/description', () => {
  it('swaps a "<3" heart for the look-alike guillemet', () => {
    expect(sanitizeForYoutube('morning show. <3')).toBe('morning show. \u20393');
  });
  it('replaces both angle brackets', () => {
    expect(sanitizeForYoutube('a <b> c')).toBe('a \u2039b\u203a c');
  });
  it('leaves text without brackets untouched', () => {
    expect(sanitizeForYoutube('plain description')).toBe('plain description');
  });
  it('handles empty/undefined safely', () => {
    expect(sanitizeForYoutube('')).toBe('');
  });
});

describe('capTitle — platform 100-char limit, keep the @ coming soon suffix', () => {
  const long =
    'ONDA listening sessions: with: Aaron | Luis & Joke | Thomas Gram @ coming soon 24.04.2025';
  it('leaves a short title untouched', () => {
    expect(capTitle('Short show @ coming soon 01.01.2026')).toBe('Short show @ coming soon 01.01.2026');
  });
  it('caps to at most 100 characters', () => {
    const padded = 'X'.repeat(90) + ' @ coming soon 24.04.2025';
    expect(capTitle(padded).length).toBeLessThanOrEqual(100);
  });
  it('preserves the @ coming soon suffix when trimming', () => {
    const padded = 'A very very very long show name that just runs on and on and on and on and on and on and on @ coming soon 24.04.2025';
    const out = capTitle(padded);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/@ coming soon 24\.04\.2025$/);
    expect(out).toContain('\u2026');
  });
  it('plain-caps when there is no suffix', () => {
    const out = capTitle('Z'.repeat(140));
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('\u2026')).toBe(true);
  });
});
