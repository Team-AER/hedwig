import { describe, it, expect, vi } from 'vitest';
import { extractMainText, readPage } from './page.js';

const FILLER = 'The bot takes orders over chat, checks the menu, and confirms the delivery window with the shop. ';

const NEWS_PAGE = `<!doctype html><html><head><title> Pizza bot &amp; friends </title>
<style>p { color: red }</style><script>var x = "<p>script text</p>";</script></head>
<body>
<header><nav><a href="/">Home</a> <a href="/news">News</a></nav><h1>Site banner</h1></header>
<aside><article><p>Sidebar teaser that is an article too</p></article></aside>
<main>
  <article class="teaser"><h2>Other story</h2><p>Short teaser.</p></article>
  <article>
    <header><h1>The pizza bot</h1><p>By Jane</p></header>
    <p>First paragraph with a <a href="related#top">related   link</a>. ${FILLER}</p>
    <figure><img src="x.png" alt=""><figcaption>A pizza</figcaption></figure>
    <p>Second   paragraph
       spans lines.</p>


    <ul><li>One</li><li>Two</li></ul>
    <p><a href="https://other.example/a">Other</a> <a href="https://other.example/a#again">Other again</a>
       <a href="mailto:x@y.z">mail</a> <a href="javascript:void(0)">js</a> <a href="/news/">News</a></p>
    <form><label>Email</label><button>Subscribe</button></form>
    <footer>Tags: pizza</footer>
    <noscript>Enable JavaScript</noscript>
    <svg><title>icon</title></svg>
  </article>
</main>
<footer><a href="/privacy">Privacy</a> Copyright</footer>
</body></html>`;

describe('extractMainText', () => {
  it('keeps the article and drops chrome, scripts and the other regions', () => {
    const { title, text, links } = extractMainText(NEWS_PAGE, 'https://site.example/news/2026/10/pizza-bot/');
    expect(title).toBe('Pizza bot & friends');
    expect(text.startsWith('The pizza bot\n\nBy Jane\n\nFirst paragraph')).toBe(true);
    expect(text).toContain('First paragraph with a related link.');
    expect(text).toContain('A pizza');
    expect(text).toContain('Second paragraph spans lines.');
    expect(text).toContain('- One\n- Two');
    for (const gone of ['Site banner', 'Home', 'Sidebar teaser', 'Other story', 'Subscribe', 'Email', 'Tags: pizza',
      'Enable JavaScript', 'icon', 'Privacy', 'script text', 'color: red']) {
      expect(text).not.toContain(gone);
    }
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/[ \t]{2,}/);
    expect(links).toEqual([
      { url: 'https://site.example/news/2026/10/pizza-bot/related', text: 'related link' },
      { url: 'https://other.example/a', text: 'Other' },
      { url: 'https://site.example/news/', text: 'News' },
    ]);
  });

  it('picks the longest article', () => {
    const html = `<body><article><p>Short one. ${FILLER.repeat(2)}</p></article>
      <article><p>Long one. ${FILLER.repeat(4)}</p></article></body>`;
    const { text } = extractMainText(html, 'https://x.example/');
    expect(text.startsWith('Long one.')).toBe(true);
    expect(text).not.toContain('Short one.');
  });

  it('falls back to <main>, then [role=main], then the whole body', () => {
    const main = extractMainText(`<body><div>Promo</div><main><p>Main text. ${FILLER.repeat(2)}</p></main></body>`, 'https://x.example/');
    expect(main.text.startsWith('Main text.')).toBe(true);
    expect(main.text).not.toContain('Promo');

    const role = extractMainText(`<body><div>Promo</div><div role="Main"><p>Role text. ${FILLER.repeat(2)}</p></div></body>`, 'https://x.example/');
    expect(role.text.startsWith('Role text.')).toBe(true);

    const body = extractMainText('<body><nav>Menu</nav><h1>Hello</h1><p>World <a href="/a">a</a></p><footer>Foot</footer></body>', 'https://x.example/');
    expect(body.text).toBe('Hello\n\nWorld a');
    expect(body.links).toEqual([{ url: 'https://x.example/a', text: 'a' }]);
  });

  it('ignores teaser-sized articles on a listing page', () => {
    const html = `<body><h1>Archive</h1><article><p>Teaser one</p></article><article><p>Teaser two</p></article></body>`;
    expect(extractMainText(html, 'https://x.example/').text).toBe('Archive\n\nTeaser one\n\nTeaser two');
  });

  it('skips relative links when there is no base URL and caps link text', () => {
    const { links } = extractMainText(`<p><a href="/rel">rel</a><a href="https://a.example/">${'w '.repeat(300)}</a></p>`);
    expect(links).toHaveLength(1);
    expect(links[0].text.length).toBe(200);
  });
});

const ok = (body, headers = { 'content-type': 'text/html; charset=utf-8' }, status = 200) => new Response(body, { status, headers });

describe('readPage', () => {
  it('fetches through the guarded fetcher and returns the main text', async () => {
    const fetcher = vi.fn(async () => {
      const res = ok(NEWS_PAGE);
      Object.defineProperty(res, 'url', { value: 'https://site.example/news/2026/10/pizza-bot/' });
      return res;
    });
    const out = await readPage('https://t.example/r/abc', { fetcher });
    expect(out.ok).toBe(true);
    expect(out.url).toBe('https://site.example/news/2026/10/pizza-bot/');
    expect(out.title).toBe('Pizza bot & friends');
    expect(out.text).toContain('Second paragraph spans lines.');
    expect(out.links[0].url).toBe('https://site.example/news/2026/10/pizza-bot/related');

    const [url, init, guard] = fetcher.mock.calls[0];
    expect(url).toBe('https://t.example/r/abc');
    expect(init.headers['User-Agent']).toBe('Mozilla/5.0 (compatible; Hedwig/1.0)');
    expect(init.headers.Accept).toBe('text/html,application/xhtml+xml,text/plain;q=0.8');
    expect(init.headers.Cookie).toBeUndefined();
    expect(init.redirect).toBe('follow');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(guard).toEqual({ allowPrivate: false });
  });

  it('reads text/plain as is, without links', async () => {
    const fetcher = async () => ok('Line one   here.\r\n\r\n\r\n  Line two https://x.example/', { 'content-type': 'text/plain' });
    const out = await readPage('https://x.example/notes.txt', { fetcher });
    expect(out).toEqual({ ok: true, url: 'https://x.example/notes.txt', title: '', text: 'Line one here.\n\nLine two https://x.example/', links: [] });
  });

  it('refuses other content types and non-2xx statuses', async () => {
    expect(await readPage('https://x.example/a.pdf', { fetcher: async () => ok('%PDF', { 'content-type': 'application/pdf' }) }))
      .toEqual({ ok: false, url: 'https://x.example/a.pdf', reason: 'type' });
    expect((await readPage('https://x.example/gone', { fetcher: async () => ok('<p>Not found</p>', {}, 404) })).reason).toBe('status');
  });

  it('stops reading and cancels the stream once the body passes maxBytes', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls > 1000) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(97));
      },
      cancel() { cancelled = true; },
    });
    const out = await readPage('https://x.example/huge', { maxBytes: 4096, fetcher: async () => ok(stream, { 'content-type': 'text/html' }) });
    expect(out).toEqual({ ok: false, url: 'https://x.example/huge', reason: 'size' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('refuses an oversize Content-Length without reading', async () => {
    const out = await readPage('https://x.example/big', { maxBytes: 10, fetcher: async () => ok('<p>hello world</p>', { 'content-type': 'text/html', 'content-length': '999' }) });
    expect(out.reason).toBe('size');
  });

  it('reports blocked targets from the SSRF guard', async () => {
    const blocked = Object.assign(new Error('Host resolves to a private or reserved IP address'), { code: 'ERR_BLOCKED_PRIVATE_IP' });
    expect((await readPage('https://internal.example/', { fetcher: async () => { throw blocked; } })).reason).toBe('blocked');
    // A redirect hop refused by the connector surfaces as fetch's TypeError with the guard error as cause.
    const hop = new TypeError('fetch failed', { cause: blocked });
    expect((await readPage('https://x.example/', { fetcher: async () => { throw hop; } })).reason).toBe('blocked');
    // The real safeFetch refuses these before any network access.
    expect((await readPage('not a url')).reason).toBe('blocked');
    expect((await readPage('ftp://x.example/file')).reason).toBe('blocked');
    expect((await readPage('http://x.example/plaintext')).reason).toBe('blocked');
  });

  it('reports timeouts, other errors and empty pages', async () => {
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    expect((await readPage('https://slow.example/', { timeoutMs: 20, fetcher: hang })).reason).toBe('timeout');
    expect((await readPage('https://x.example/', { fetcher: async () => { throw new Error('ECONNRESET'); } })).reason).toBe('error');
    expect((await readPage('https://x.example/', { fetcher: async () => ok('<nav>Menu only</nav><script>x()</script>') })).reason).toBe('empty');
  });

  it('rethrows an AbortError when the caller aborts', async () => {
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const ctrl = new AbortController();
    const pending = readPage('https://slow.example/', { fetcher: hang, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readPage('https://x.example/', { fetcher: hang, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('truncates at a word boundary', async () => {
    const fetcher = async () => ok(`<p>${'alpha beta gamma delta '.repeat(20)}</p>`);
    const out = await readPage('https://x.example/', { maxChars: 50, fetcher });
    expect(out.text.length).toBeLessThanOrEqual(50);
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.text.slice(0, -1)).toMatch(/(alpha|beta|gamma|delta)$/);
  });

  it('decodes the charset from Content-Type, or from a <meta> tag', async () => {
    const latin1 = Buffer.from('<p>Café crème brûlée</p>', 'latin1');
    const declared = await readPage('https://x.example/', { fetcher: async () => ok(latin1, { 'content-type': 'text/html; charset=ISO-8859-1' }) });
    expect(declared.text).toBe('Café crème brûlée');

    const sniffed = Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>Naïve \u0080 price</p></body></html>', 'latin1');
    const meta = await readPage('https://x.example/', { fetcher: async () => ok(sniffed, { 'content-type': 'text/html' }) });
    expect(meta.text).toBe('Naïve € price');
  });
});
