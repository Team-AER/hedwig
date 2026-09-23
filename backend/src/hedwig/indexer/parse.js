// Splits a message body into what the sender wrote now, quoted history, signature and legal
// disclaimer. Quoted history is kept (it is indexed at low weight), never dropped. HTML bodies are
// split structurally first (blockquote, Gmail/Outlook/Yahoo/Apple/Thunderbird quote containers),
// then every body goes through the text rules ("On … wrote:" in several languages, Outlook header
// blocks, `>` lines, mobile signatures, valedictions, legal footers).
import { parseDocument, DomUtils } from 'htmlparser2';
import { query } from '../../services/db.js';
import { convert } from '../htmlToText.js';

// ── Text rules ───────────────────────────────────────────────────────────────

const REPLY_HEADERS = [
  /^\s*On\s.{3,300}\s(wrote|writes)\s*:\s*$/i,
  /^\s*Am\s.{3,300}\sschrieb\s.{0,200}:\s*$/i,
  /^\s*Le\s.{3,300}\sa\s+écrit\s*:\s*$/i,
  /^\s*El\s.{3,300}\sescribió\s*:\s*$/i,
  /^\s*Il\s.{3,300}\sha\s+scritto\s*:\s*$/i,
  /^\s*Op\s.{3,300}\sschreef\s.{0,200}:\s*$/i,
  /^\s*Em\s.{3,300}\sescreveu\s*:\s*$/i,
  /^\s*(Den|På)\s.{3,300}\sskrev\s.{0,200}:\s*$/i,
  /^\s*W dniu\s.{3,300}\snapisał(a)?\s*:\s*$/i,
  /^.{3,300}\s(пишет|написал|написала)\s*:\s*$/i,
  // "Jane Doe <jane@x.com> wrote:" / "2026-09-01 10:00 GMT+2 Jane wrote:" — needs an address or a date.
  /^(?=.*(@|\d{1,4}[/.\-:]\d{1,2})).{3,300}\s(wrote|a écrit|schrieb|escribió|ha scritto|schreef|escreveu|skrev)\s*:\s*$/i,
  /^\s*-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale|Oorspronkelijk bericht|Mensagem original|Originalmeddelande)\s*-{2,}\s*$/i,
];

const FORWARD_MARKERS = [
  /^\s*-{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Doorgestuurd bericht|Mensagem encaminhada|Vidarebefordrat meddelande)\s*-{2,}\s*$/i,
  /^\s*Begin forwarded message\s*:\s*$/i,
];

const HDR_FROM = /^\s*\*?\s*(From|Von|De|Da|Van|Från|Fra|Od|От)\s*\*?\s*:\s*\S/i;
const HDR_OTHER = /^\s*\*?\s*(Sent|Date|Gesendet|Datum|Envoyé|Enviado|Inviato|Data|Verzonden|Skickat|Sendt|Wysłano|Отправлено|Fecha|To|An|À|Para|A|Aan|Till|Til|Do|Кому|Subject|Betreff|Objet|Asunto|Oggetto|Onderwerp|Ämne|Emne|Temat|Тема|Cc)\s*\*?\s*:/i;

const MOBILE_SIGNATURE = /^\s*(Sent from my .{2,40}|Sent from (Outlook|Mail|Yahoo Mail|Gmail|ProtonMail|Proton Mail|Samsung.{0,20})( for .{2,30})?|Get Outlook for .{2,20}|Sent (via|with) .{2,40}|Von meinem .{2,40} gesendet|Gesendet von .{2,40}|Envoyé de mon .{2,40}|Enviado desde mi .{2,40}|Enviado do meu .{2,40}|Inviato da(l mio)? .{2,40}|Verzonden (vanaf|met) .{2,40}|Skickat från min .{2,40}|Wysłane z .{2,40}|Отправлено с .{2,40})\.?\s*$/i;

const VALEDICTION = /^\s*(kind regards|best regards|warm regards|warmest regards|regards|best wishes|best|many thanks|thanks|thank you|thanks again|thanks so much|cheers|sincerely|yours sincerely|yours faithfully|yours truly|yours|all the best|take care|talk soon|mit freundlichen grüßen|freundliche grüße|viele grüße|beste grüße|liebe grüße|lg|mfg|cordialement|bien à vous|bien cordialement|salutations|bonne journée|saludos|un saludo|atentamente|cordiali saluti|distinti saluti|saluti|met vriendelijke groet(en)?|groeten|hälsningar|med vänlig hälsning|vänliga hälsningar|pozdrawiam|с уважением)[\s,.!]*$/i;

const DISCLAIMER = /(confidential|privileged|intended (solely |only )?for the (use of the )?(addressee|recipient|individual|named)|if you (are not|have received this).{0,60}(intended recipient|in error)|disclaimer|this (e-?mail|message|communication)( and any (files|attachments?)( transmitted with it)?)? (is|are|may be|contains?)\b|registered (in england|in scotland|office|number)|company (number|no\.?|registration)|vat (number|no\.?|reg)|please consider the environment|do not print this|vertraulich|diese e-?mail enthält|ce (message|courriel).{0,60}(confidenti|destiné)|este (mensaje|correo).{0,60}confidencial|questo messaggio.{0,60}riservat|bevat vertrouwelijke)/i;

// Unambiguous footer phrases; anything else must also be long to count ("keep this confidential" is not a footer).
const DISCLAIMER_STRONG = /(intended recipient|please consider the environment|registered office|company (number|no\.?|registration)|do not print this)/i;
const isDisclaimer = (p) => DISCLAIMER.test(p) && (DISCLAIMER_STRONG.test(p) || p.trim().length >= 100);

const EXTERNAL_BANNER = /^\s*\[?(external|caution|warning|attention|notice)\]?\s*[:!-]?.{0,40}(this (e-?mail|message)).{0,40}(originated|came|comes|was sent|is) from outside/i;

const QUOTE_LINE = /^\s*>/;
const SEPARATOR_LINE = /^\s*[-_=*~]{3,}\s*$/;

function isReplyHeader(line, next) {
  if (REPLY_HEADERS.some((re) => re.test(line))) return 1;
  // Gmail wraps long "On … wrote:" headers over two lines.
  if (next != null && /^\s*(On|Am|Le|El|Il|Op|Em|Den|W dniu)\s/i.test(line) && !/:\s*$/.test(line)
    && REPLY_HEADERS.some((re) => re.test(`${line.trim()} ${next.trim()}`))) return 2;
  return 0;
}

function isOutlookHeaderBlock(lines, i) {
  if (!HDR_FROM.test(lines[i])) return false;
  let hits = 0;
  for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
    if (HDR_OTHER.test(lines[j])) hits++;
    else if (lines[j].trim() && !/^\s*\*?\s*\w+\s*\*?\s*:/.test(lines[j])) break;
  }
  return hits >= 2;
}

const stripQuoteMarks = (line) => line.replace(/^(\s*>)+\s?/, '');
const tidy = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Split plain text into new text and quoted history (strings). Interleaved `>` replies keep the
 * unquoted lines as new text.
 */
export function splitQuotes(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const main = [];
  const quoted = [];
  let forwarded = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!forwarded && FORWARD_MARKERS.some((re) => re.test(line))) forwarded = true; // a forward's body is its substance
    if (!forwarded) {
      const hdr = isReplyHeader(line, lines[i + 1]);
      const underscore = /^\s*_{10,}\s*$/.test(line) && lines.slice(i + 1, i + 3).some((l) => HDR_FROM.test(l));
      if (hdr || underscore || (isOutlookHeaderBlock(lines, i) && main.some((l) => l.trim()))) {
        const rest = lines.slice(i + (hdr || 0));
        const nonEmpty = rest.filter((l) => l.trim());
        // Bottom-posting and inline replies quote with ">" right after the header.
        const angleQuoted = nonEmpty.length > 0 && QUOTE_LINE.test(nonEmpty[0]);
        if (hdr && angleQuoted) {
          // Bottom-posting or inline replies: the header goes to the history, `>` rules do the rest.
          quoted.push(lines.slice(i, i + hdr).join(' '));
          i += hdr - 1;
          continue;
        }
        quoted.push(...lines.slice(i).map(stripQuoteMarks));
        break;
      }
    }
    if (QUOTE_LINE.test(line)) quoted.push(stripQuoteMarks(line));
    else main.push(line);
  }
  return { newText: tidy(main.join('\n')), quoted: tidy(quoted.join('\n')) };
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/);
}

/** Pull legal footers off the end (and an "external sender" banner off the start). */
export function splitDisclaimer(text) {
  const paras = paragraphs(text);
  const out = [];
  while (paras.length) {
    const p = paras[paras.length - 1];
    if (!p.trim() || SEPARATOR_LINE.test(p) || isDisclaimer(p)) out.unshift(paras.pop());
    else break;
  }
  if (paras.length && EXTERNAL_BANNER.test(paras[0])) out.unshift(paras.shift());
  // A footer is what follows the message. When the rules would take everything (a one-paragraph
  // body that happens to say "confidential", a subject like "Poor confidentiality…"), there is no
  // message left to follow: keep the text as the message.
  if (!paras.some((p) => p.trim() && !SEPARATOR_LINE.test(p))) return { text: tidy(text), disclaimer: '' };
  const disclaimer = tidy(out.filter((p) => p.trim() && !SEPARATOR_LINE.test(p)).join('\n\n'));
  return { text: tidy(paras.join('\n\n')), disclaimer };
}

/** Split a signature off the end of new text. */
export function splitSignature(text) {
  const lines = String(text || '').split('\n');
  const minIndex = 1; // never treat the very first line as the start of a signature
  for (let i = minIndex; i < lines.length; i++) {
    if (/^--\s?$/.test(lines[i])) {
      return { text: tidy(lines.slice(0, i).join('\n')), signature: tidy(lines.slice(i + 1).join('\n')) };
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (MOBILE_SIGNATURE.test(lines[i])) {
      const after = lines.slice(i + 1).filter((l) => l.trim());
      if (after.length <= 3) return { text: tidy(lines.slice(0, i).join('\n')), signature: tidy(lines.slice(i).join('\n')) };
      return splitSignature([...lines.slice(0, i), ...lines.slice(i + 1)].join('\n'));
    }
  }
  // Valediction followed by a short name/title block.
  for (let i = lines.length - 1; i >= minIndex; i--) {
    if (!VALEDICTION.test(lines[i])) continue;
    const after = lines.slice(i + 1).filter((l) => l.trim());
    if (after.length >= 1 && after.length <= 6 && after.every((l) => l.trim().length <= 80)) {
      return { text: tidy(lines.slice(0, i + 1).join('\n')), signature: tidy(lines.slice(i + 1).join('\n')) };
    }
    break;
  }
  return { text: tidy(text), signature: '' };
}

// ── HTML structure ───────────────────────────────────────────────────────────

const QUOTE_CLASS = /(^|\s)(gmail_quote|gmail_quote_container|x_gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix|OutlookMessageHeader|zmail_extra|replyQuote)(\s|$)/i;
const SIGNATURE_CLASS = /(^|\s)(gmail_signature|x_gmail_signature|moz-signature|signature)(\s|$)/i;
const SIGNATURE_ID = /^(Signature|signature|AppleMailSignature|ms-outlook-mobile-signature|x_Signature)$/;
const AFTER_IS_QUOTED_ID = /^(x_)?(divRplyFwdMsg|appendonsend|stopSpelling)$/;

const attr = (el, name) => (el.attribs && el.attribs[name]) || '';

const FORWARD_START = /^\s*(-{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Doorgestuurd bericht|Mensagem encaminhada|Vidarebefordrat meddelande)|Begin forwarded message)/i;

function isForwardContainer(el) {
  return FORWARD_START.test(DomUtils.textContent(el));
}

/** Nodes after `node` in document order (its following siblings and its ancestors' following siblings). */
function followingNodes(node) {
  const out = [];
  let cur = node;
  while (cur && cur.parent) {
    let sib = cur.next;
    while (sib) { out.push(sib); sib = sib.next; }
    cur = cur.parent;
    if (cur.type === 'root' || cur.name === 'body' || cur.name === 'html') break;
  }
  return out;
}

const htmlOf = (nodes) => nodes.map((n) => DomUtils.getOuterHTML(n)).join('\n');

/** Split HTML into { main, quoted, signature } texts. Returns null when it has no structure to use. */
export function splitHtml(html) {
  let doc;
  try { doc = parseDocument(String(html || ''), { decodeEntities: true }); } catch { return null; }
  const quotedNodes = [];
  const sigNodes = [];
  const all = DomUtils.findAll(() => true, doc.children);
  let structure = false;
  const removed = new Set();
  const within = (el) => { for (let p = el; p; p = p.parent) if (removed.has(p)) return true; return false; };
  for (const el of all) {
    if (within(el)) continue;
    const cls = attr(el, 'class');
    const id = attr(el, 'id');
    if (AFTER_IS_QUOTED_ID.test(id) || (el.name === 'div' && /^(x_)?divRplyFwdMsg/.test(id))) {
      const rest = [el, ...followingNodes(el)].filter((n) => !within(n));
      quotedNodes.push(...rest);
      rest.forEach((n) => removed.add(n));
      structure = true;
      continue;
    }
    if (el.name === 'blockquote' || QUOTE_CLASS.test(cls) || /^yahoo_quoted/.test(id)) {
      if (isForwardContainer(el)) continue;
      quotedNodes.push(el);
      removed.add(el);
      structure = true;
      continue;
    }
    if (SIGNATURE_CLASS.test(cls) || SIGNATURE_ID.test(id) || attr(el, 'data-smartmail') === 'gmail_signature') {
      sigNodes.push(el);
      removed.add(el);
      structure = true;
    }
  }
  if (!structure) return null;
  const quoted = convert(htmlOf(quotedNodes));
  const signature = convert(htmlOf(sigNodes));
  for (const n of removed) DomUtils.removeElement(n);
  const main = convert(DomUtils.getOuterHTML(doc));
  return { main, quoted, signature };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Bump when a change to splitBody can turn a message that had no indexable text into one that has
 * some. The chunk sweep then re-chunks, once, the messages whose body produced no text before
 * (store.js repairEmptyBodies), without re-chunking the whole index.
 */
export const PARSER_VERSION = '2026-09-24.1';

const HTML_START = /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<(div|table|p|span|style|meta|center|font)[\s>])/i;
/** A text/plain part that is really HTML. Pure. */
export function looksLikeHtml(text) {
  const t = String(text || '');
  return HTML_START.test(t) && /<\/[a-z]+>/i.test(t);
}

/** Characters of indexable text a split produced (new text plus quoted history). Pure. */
export function textChars(parts) {
  return String(parts?.newText || '').trim().length + String(parts?.quoted || '').trim().length;
}

/**
 * Split a body. Accepts { body_text, body_html, snippet } (a message row) or a plain string.
 * @returns {{ newText: string, quoted: string, signature: string, disclaimer: string }}
 */
export function splitBody(input) {
  const row = typeof input === 'string' ? { body_text: input } : (input || {});
  // Some senders put a bare line break in the text/plain part ("\r\n") and the whole message in
  // the HTML part, and some send HTML in the text/plain part. Neither is text to index as-is.
  let base = String(row.body_text || '').trim() ? row.body_text : '';
  let html = row.body_html || '';
  if (base && looksLikeHtml(base)) {
    if (!String(html).trim()) html = base;
    base = '';
  }
  const quotedParts = [];
  const sigParts = [];
  if (html) {
    const s = splitHtml(html);
    if (s) {
      base = s.main;
      if (s.quoted) quotedParts.push(s.quoted);
      if (s.signature) sigParts.push(s.signature);
    } else if (!base) {
      base = convert(html);
    }
  }
  if (!base && !quotedParts.length) base = row.snippet || '';
  const q = splitQuotes(base);
  if (q.quoted) quotedParts.unshift(q.quoted);
  const d1 = splitDisclaimer(q.newText);
  const s = splitSignature(d1.text);
  if (s.signature) sigParts.unshift(s.signature);
  let signature = tidy(sigParts.join('\n\n'));
  let disclaimer = d1.disclaimer;
  if (signature) {
    const d2 = splitDisclaimer(signature);
    signature = d2.text;
    disclaimer = tidy([disclaimer, d2.disclaimer].filter(Boolean).join('\n\n'));
  }
  return { newText: s.text, quoted: tidy(quotedParts.join('\n\n')), signature, disclaimer };
}

/**
 * The parts of one stored message, with extracted attachment text.
 * @param {string} messageId
 * @param {{ userId?: string }} [opts] scope the lookup to a user's accounts
 */
export async function messageParts(messageId, { userId = null } = {}) {
  const params = [messageId];
  let scope = '';
  if (userId) { params.push(userId); scope = 'AND a.user_id = $2'; }
  const { rows } = await query(
    `SELECT m.id, m.body_text, m.body_html, m.snippet, m.attachments
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 ${scope}`,
    params,
  );
  if (!rows.length) return null;
  const { rows: att } = await query(
    `SELECT attachment_index, filename, mime, text, error FROM hedwig_attachment_text
      WHERE message_id = $1 ORDER BY attachment_index`,
    [messageId],
  );
  const parts = splitBody(rows[0]);
  return {
    ...parts,
    attachments: att.filter((a) => a.text).map((a) => ({ index: a.attachment_index, filename: a.filename, mime: a.mime, text: a.text })),
  };
}
