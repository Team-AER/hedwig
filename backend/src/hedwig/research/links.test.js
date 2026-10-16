import { describe, it, expect } from 'vitest';
import { extractLinks, extractTextLinks, unwrapLink, classifyLink, emailLinks } from './links.js';

const INFOQ = 'https://www.infoq.com/news/2026/10/pizza-bot/';
const safelinks = (url) => `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}&data=05%7C02%7Cme%40example.com&sdata=abcDEF&reserved=0`;
const OPAQUE = 'ZmFrZS10cmFja2luZy1pZC0xMjM0NTY3ODkw';

describe('unwrapLink', () => {
  it('unwraps Outlook SafeLinks', () => {
    expect(unwrapLink(safelinks(INFOQ))).toBe(INFOQ);
  });

  it('unwraps Proofpoint urldefense v2 and v3', () => {
    const v2 = 'https://urldefense.proofpoint.com/v2/url?u=https-3A__www.example.com_path_page-3Fid-3D7&d=DwMFaQ&c=abc&r=def&m=ghi&s=jkl&e=';
    expect(unwrapLink(v2)).toBe('https://www.example.com/path/page?id=7');
    expect(unwrapLink('https://urldefense.com/v3/__https://www.example.com/a/b?x=1__;!!ABC!xyz$')).toBe('https://www.example.com/a/b?x=1');
    // `*` stands for one removed character, `**A` for a run of two; they travel base64url-encoded after `__;`.
    const encoded = Buffer.from('&ab').toString('base64url');
    expect(unwrapLink(`https://urldefense.com/v3/__https://example.com/p?a=1*b=2**Az__;${encoded}!!ABC!xyz$`))
      .toBe('https://example.com/p?a=1&b=2abz');
  });

  it('unwraps Google, Facebook and LinkedIn redirects', () => {
    expect(unwrapLink('https://www.google.com/url?q=https://example.com/page&sa=D&usg=AOvVaw')).toBe('https://example.com/page');
    expect(unwrapLink(`https://l.facebook.com/l.php?u=${encodeURIComponent('https://example.com/fb')}&h=AT0x`)).toBe('https://example.com/fb');
    expect(unwrapLink(`https://www.linkedin.com/redir/redirect?url=${encodeURIComponent('https://example.com/li')}&urlhash=x`)).toBe('https://example.com/li');
  });

  it('unwraps nested wrappers', () => {
    const google = `https://www.google.com/url?q=${encodeURIComponent('https://example.com/deep')}`;
    expect(unwrapLink(safelinks(google))).toBe('https://example.com/deep');
  });

  it('leaves unwrapped links and non-http destinations alone', () => {
    expect(unwrapLink(INFOQ)).toBe(INFOQ);
    const js = 'https://www.google.com/url?q=javascript:alert(1)';
    expect(unwrapLink(js)).toBe(js);
    expect(unwrapLink('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

describe('classifyLink', () => {
  const kind = (url, opts) => {
    const c = classifyLink(url, opts);
    return `${c.kind}:${c.reason}`;
  };

  it('skips anything that is not http(s)', () => {
    expect(classifyLink('mailto:news@example.com')).toEqual({ kind: 'skip', url: 'mailto:news@example.com', reason: 'scheme' });
    expect(kind('tel:+4930123456')).toBe('skip:scheme');
    expect(kind('javascript:void(0)')).toBe('skip:scheme');
    expect(kind('cid:image001.png')).toBe('skip:scheme');
    expect(kind('not a url')).toBe('skip:scheme');
  });

  it('treats List-Unsubscribe targets as unsubscribe actions, wrapped or not', () => {
    const header = ['mailto:u@news.example', 'https://news.example/u/abc123'];
    expect(kind('https://www.news.example/u/abc123/', { listUnsubscribe: header })).toBe('action:unsubscribe');
    expect(kind(safelinks('https://news.example/u/abc123'), { listUnsubscribe: '<mailto:u@news.example>, <https://news.example/u/abc123>' }))
      .toBe('action:unsubscribe');
    expect(kind('https://news.example/u/other')).toBe('open:null');
  });

  it('recognises actions by URL', () => {
    expect(kind('https://news.example/unsubscribe?id=1')).toBe('action:unsubscribe');
    expect(kind('https://news.example/email-preferences')).toBe('action:unsubscribe');
    expect(kind('https://app.example.com/account/verify?token=abcdefghijklmnop1234')).toBe('action:confirm');
    expect(kind(`https://app.example.com/auth/magic?code=${'a1'.repeat(16)}`)).toBe('action:sign-in');
    expect(kind('https://app.example.com/users/sign_in')).toBe('action:sign-in');
    expect(kind('https://app.example.com/resetPassword?u=7')).toBe('action:password');
    expect(kind('https://calendar.google.com/calendar/event?action=RESPOND&eid=abc&rst=1&tok=xyz')).toBe('action:respond');
    expect(kind('https://outlook.office365.com/owa/meeting/accept?id=42')).toBe('action:respond');
    expect(kind('https://billing.example.com/invoice/123/pay')).toBe('action:payment');
    expect(kind('https://docs.example.com/share/9?sig=abcdefghijklmnopqrstuvwxyz')).toBe('action:token');
    expect(kind('https://files.example.com/x.pdf#access_token=abcdefghijklmnopqrstuvwxyz')).toBe('action:token');
  });

  it('recognises actions by anchor text, on whole words', () => {
    expect(kind('https://news.example/p/xyz', { text: 'Unsubscribe' })).toBe('action:unsubscribe');
    expect(kind('https://news.example/p/xyz', { text: 'Verify your email' })).toBe('action:confirm');
    expect(kind('https://news.example/p/xyz', { text: 'Sign in' })).toBe('action:sign-in');
    expect(kind('https://news.example/p/xyz', { text: 'CONFIRM' })).toBe('action:confirm');
    expect(kind('https://news.example/p/xyz', { text: 'Confirmed: the pizza bot ships' })).toBe('open:null');
  });

  it('does not mistake ordinary links for actions', () => {
    expect(classifyLink(INFOQ)).toEqual({ kind: 'open', url: INFOQ, reason: null });
    expect(kind('https://www.infoq.com/articles/designing-distributed-systems/')).toBe('open:null');
    expect(kind('https://example.com/changelog/introduction')).toBe('open:null');
    expect(kind('https://1password.com/blog/passkeys')).toBe('open:null');
    expect(kind('https://example.com/post?utm_campaign=payment-reminder&utm_source=email')).toBe('open:null');
    expect(kind('https://docs.example.com/share/9?sig=short')).toBe('open:null');
  });

  it('marks click-tracking redirects as tracked', () => {
    expect(kind(`https://click.infoq.com/${OPAQUE}/abc`)).toBe('tracked:tracker');
    expect(kind(`https://links.example.co.uk/ls?id=${'x'.repeat(30)}`)).toBe('tracked:tracker');
    expect(kind('https://mailchi.mp/x')).toBe('tracked:tracker');
    expect(kind('https://example.us1.list-manage.com/track/click?u=abc&id=def&e=ghi')).toBe('tracked:tracker');
    expect(kind('https://t.co/AbC123')).toBe('tracked:tracker');
    expect(kind('https://u123.ct.sendgrid.net/ls/click?upn=x')).toBe('tracked:tracker');
    expect(kind('https://jane.substack.com/redirect/2/eyJlIjoiaHR0cHM')).toBe('tracked:tracker');
    // The tracker after unwrapping is what counts.
    expect(classifyLink(safelinks('https://mailchi.mp/x'))).toEqual({ kind: 'tracked', url: 'https://mailchi.mp/x', reason: 'tracker' });
    // A prefix host with a readable path is just a site.
    expect(kind('https://go.microsoft.com/fwlink/?LinkId=1234')).toBe('open:null');
    expect(kind('https://click.example.com/about')).toBe('open:null');
  });

  it('lets actions win over tracking', () => {
    expect(kind(`https://click.example.com/unsubscribe/${OPAQUE}`)).toBe('action:unsubscribe');
    expect(kind(`https://click.example.com/${OPAQUE}`, { text: 'Sign in' })).toBe('action:sign-in');
    expect(kind(`https://example.us1.list-manage.com/track/click?u=abc&id=def`, { text: 'Unsubscribe' })).toBe('action:unsubscribe');
    const wrapped = classifyLink(safelinks('https://app.example.com/confirm?id=1'));
    expect(wrapped).toEqual({ kind: 'action', url: 'https://app.example.com/confirm?id=1', reason: 'confirm' });
  });
});

describe('extractLinks / extractTextLinks', () => {
  it('collects http(s) anchors, deduplicated, keeping the first non-empty text', () => {
    const html = `<p><a href=" https://a.example/x "><img src="logo.png"></a>
      <a href="https://a.example/x">Read   <b>more</b></a> <a href="https://a.example/x">Again</a>
      <a href="mailto:a@b.c">Mail</a> <a href="/relative">Rel</a> <a>No href</a>
      <a href="https://b.example/">B<script>bad()</script></a></p>`;
    expect(extractLinks(html)).toEqual([
      { url: 'https://a.example/x', text: 'Read more' },
      { url: 'https://b.example/', text: 'B' },
    ]);
    expect(extractLinks('')).toEqual([]);
  });

  it('caps the number of links', () => {
    const html = Array.from({ length: 150 }, (_, i) => `<a href="https://a.example/${i}">${i}</a>`).join(' ');
    expect(extractLinks(html)).toHaveLength(100);
  });

  it('finds bare URLs in plain text and strips trailing punctuation', () => {
    const text = 'Visit https://example.com/a, and https://example.com/b). Also (https://en.wikipedia.org/wiki/Foo_(bar)). <https://x.example/y> https://example.com/a';
    expect(extractTextLinks(text).map((l) => l.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://x.example/y',
    ]);
  });
});

describe('emailLinks', () => {
  it('numbers the thread\'s links, deduplicated by unwrapped URL, without skips', () => {
    const messages = [
      {
        id: 101,
        body_html: `<a href="${INFOQ}">Pizza bot</a> <a href="mailto:x@y.z">Mail us</a>
          <a href="${safelinks('https://infoq.com/news/2026/10/pizza-bot')}">Same story</a>
          <a href="https://news.example/unsubscribe?u=1">Unsubscribe</a>
          <a href="https://click.infoq.com/${OPAQUE}"></a>`,
        body_text: 'ignored when there is HTML https://ignored.example/',
      },
      { id: 102, body_text: 'Report: https://reports.example/q3.pdf. Also https://news.example/p/abc' },
      { id: 103, body_html: '<a href="https://news.example/p/abc">Unsubscribe</a>' },
    ];
    expect(emailLinks(messages)).toEqual([
      { id: 'L1', url: INFOQ, text: 'Pizza bot', kind: 'open', reason: null, messageId: 101 },
      { id: 'L2', url: 'https://news.example/unsubscribe?u=1', text: 'Unsubscribe', kind: 'action', reason: 'unsubscribe', messageId: 101 },
      { id: 'L3', url: `https://click.infoq.com/${OPAQUE}`, text: '', kind: 'tracked', reason: 'tracker', messageId: 101 },
      { id: 'L4', url: 'https://reports.example/q3.pdf', text: '', kind: 'open', reason: null, messageId: 102 },
      // Plain in one message, an unsubscribe button in another: it stays an action.
      { id: 'L5', url: 'https://news.example/p/abc', text: 'Unsubscribe', kind: 'action', reason: 'unsubscribe', messageId: 102 },
    ]);
  });

  it('passes List-Unsubscribe through', () => {
    const out = emailLinks([{ id: 1, body_html: '<a href="https://news.example/u/abc123">Manage</a>' }], { listUnsubscribe: ['https://news.example/u/abc123'] });
    expect(out[0]).toMatchObject({ kind: 'action', reason: 'unsubscribe' });
  });

  it('keeps at most 40, preferring links with anchor text, in thread order', () => {
    const bare = Array.from({ length: 50 }, (_, i) => `<a href="https://a.example/${i}"></a>`).join('');
    const named = [0, 1, 2].map((i) => `<a href="https://b.example/${i}">Named ${i}</a>`).join('');
    const out = emailLinks([{ id: 1, body_html: bare + named }]);
    expect(out).toHaveLength(40);
    expect(out.map((l) => l.id)).toEqual(Array.from({ length: 40 }, (_, i) => `L${i + 1}`));
    expect(out.slice(-3).map((l) => l.text)).toEqual(['Named 0', 'Named 1', 'Named 2']);
    expect(out[0].url).toBe('https://a.example/0');
    expect(emailLinks(null)).toEqual([]);
  });
});
