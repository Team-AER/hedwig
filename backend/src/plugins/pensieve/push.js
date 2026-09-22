// Pure helpers for the Pensieve bridge: newsletter detection, finding the issue's web address, and
// the POST /api/v1/save payload Pensieve's saved-links API takes.

const PLATFORM = /@(?:[a-z0-9-]+\.)*(substack\.com|beehiiv\.com|convertkit\.com|ck\.page|buttondown\.email|ghost\.io|mcsv\.net|list-manage\.com|mailerlite\.com|medium\.com|every\.to)$/i;
const SENDER = /^(newsletters?|digest|news|weekly|daily|updates?|editors?|briefing|letters?|dispatch|bulletin)[._+-]?[a-z0-9]*@/i;
const TRANSACTIONAL = /\b(receipt|invoice|order|payment|password|verify|security alert|sign[- ]?in|log[- ]?in|code|reset|shipped|delivery)\b/i;

export function looksLikeNewsletter(msg) {
  const from = String(msg?.from_email || '').toLowerCase();
  let score = 0;
  if (msg?.category === 'newsletter') score += 3;
  if (msg?.has_list_unsubscribe || msg?.list_unsubscribe) score += 2;
  if (msg?.is_bulk) score += 1;
  if (PLATFORM.test(from)) score += 3;
  if (SENDER.test(from)) score += 2;
  if (TRANSACTIONAL.test(String(msg?.subject || ''))) score -= 4;
  return score >= 3;
}

const WEB_VERSION = /\b(view (?:it |this (?:email|newsletter|post|issue) )?(?:in|on) (?:your |a )?(?:web )?browser|view (?:it |this )?online|read (?:it |this )?online|read (?:it )?in (?:your |a )?browser|web version|open (?:it )?in (?:your |a )?browser|view as (?:a )?web ?page|online version|im browser (?:ansehen|anzeigen)|voir (?:la )?version en ligne)\b/i;
const POST_PATH = /^https:\/\/[^/]+\/(p|post|posts|archive|issues?|newsletter)\/[^?#\s]+/i;

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"');
}

function cleanUrl(raw) {
  try {
    const u = new URL(decodeEntities(raw.trim()));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch { return null; }
}

/** The newsletter issue's web address, or null when the message carries none. */
export function findWebVersionUrl(msg) {
  const html = String(msg?.html || '');
  const anchors = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && anchors.length < 500) {
    anchors.push({ href: m[1], text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  for (const a of anchors) if (WEB_VERSION.test(a.text)) { const u = cleanUrl(a.href); if (u) return u; }
  const text = String(msg?.text || '');
  for (const line of text.split('\n')) {
    if (!WEB_VERSION.test(line)) continue;
    const url = /(https?:\/\/[^\s<>()"]+)/.exec(line);
    if (url) { const u = cleanUrl(url[1]); if (u) return u; }
  }
  // Platforms such as Substack and beehiiv link the post itself; take the first such link.
  for (const a of anchors) { const u = cleanUrl(a.href); if (u && POST_PATH.test(u)) return u; }
  return null;
}

export function parseTags(s) {
  return String(s || '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => t && t.length <= 60).slice(0, 10);
}

/** Body for Pensieve's POST /api/v1/save (JSON: url, title, tags, note, html). */
export function buildSavePayload(msg, url, settings) {
  const from = msg?.from_name ? `${msg.from_name} <${msg.from_email}>` : msg?.from_email || 'unknown sender';
  const payload = {
    url,
    title: String(msg?.subject || '').slice(0, 300) || undefined,
    tags: parseTags(settings?.tags),
    note: `Newsletter from ${from}, saved by Hedwig.`,
  };
  // Pensieve archives `html` as the page "as you see it", so the copy matches the email received.
  if (settings?.sendHtml && msg?.html && msg.html.length < 1_500_000) payload.html = msg.html;
  return payload;
}

export function saveEndpoint(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/api/v1/save`;
}

/** Map a Pensieve response to a sync status record. */
export function outcome(status, body) {
  if (status === 200 || status === 201) return { status: 'saved', itemId: body?.id || null, open: body?.open || null, created: status === 201 };
  if (status === 401) return { status: 'auth_error', error: 'Pensieve rejected the API token' };
  if (status === 422) return { status: 'rejected', error: String(body?.error || 'Pensieve could not save that link').slice(0, 300) };
  return { status: 'error', error: `Pensieve answered ${status}` };
}
