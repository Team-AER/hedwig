import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const await_parse = await import('./parse.js');
const { splitBody, splitQuotes, splitSignature, splitDisclaimer, splitHtml } = await_parse;

describe('splitQuotes (text)', () => {
  it('cuts top-posted replies at "On … wrote:" and keeps the history', () => {
    const t = 'Sounds good, Thursday works.\n\nOn Mon, 21 Sep 2026 at 10:02, Priya Nair <priya@vantage.example> wrote:\n> Can we meet Thursday?\n> Priya';
    const r = splitQuotes(t);
    expect(r.newText).toBe('Sounds good, Thursday works.');
    expect(r.quoted).toContain('Can we meet Thursday?');
    expect(r.quoted).toContain('wrote:');
  });
  it('handles the header wrapped over two lines (Gmail)', () => {
    const t = 'Yes.\n\nOn Mon, 21 Sep 2026 at 10:02, Priya Nair <priya.nair@vantage.example>\nwrote:\n> Is it signed?';
    const r = splitQuotes(t);
    expect(r.newText).toBe('Yes.');
    expect(r.quoted).toContain('Is it signed?');
  });
  it.each([
    ['Am 21.09.2026 um 10:02 schrieb Anna Schmidt <anna@example.de>:', 'German'],
    ['Le lun. 21 sept. 2026 à 10:02, Jean Dupont <jean@example.fr> a écrit :', 'French'],
    ['El lun, 21 sept 2026 a las 10:02, Ana <ana@example.es> escribió:', 'Spanish'],
    ['Il giorno lun 21 set 2026 alle 10:02 Marco <marco@example.it> ha scritto:', 'Italian'],
    ['Op ma 21 sep. 2026 om 10:02 schreef Jan <jan@example.nl>:', 'Dutch'],
    ['-----Original Message-----', 'Outlook original message'],
  ])('recognises %s (%s)', (header) => {
    const r = splitQuotes(`Danke, erledigt.\n\n${header}\nDie alte Nachricht mit vielen Details.`);
    expect(r.newText).toBe('Danke, erledigt.');
    expect(r.quoted).toContain('Die alte Nachricht');
  });
  it('cuts at an Outlook header block but not at a lone "From:" line', () => {
    const t = 'Please see below.\n\n________________________________\nFrom: Thomas Reed <thomas@reedlaw.example>\nSent: Monday, 21 September 2026 10:02\nTo: Prakhar\nSubject: Fees\n\nOur fee is £1,450.';
    const r = splitQuotes(t);
    expect(r.newText).toBe('Please see below.');
    expect(r.quoted).toContain('Our fee is £1,450.');
    expect(splitQuotes('From: the desk of the CEO, a note on values.\nWe care.').newText).toContain('We care.');
  });
  it('keeps interleaved answers as new text and `>` lines as history', () => {
    const t = 'On Mon, 21 Sep 2026, Priya <p@x.example> wrote:\n> Can you do Thursday?\nYes, 3pm.\n> And bring the passport?\nWill do.';
    const r = splitQuotes(t);
    expect(r.newText).toBe('Yes, 3pm.\nWill do.');
    expect(r.quoted).toContain('Can you do Thursday?');
    expect(r.quoted).toContain('And bring the passport?');
  });
  it('treats a forwarded message as substance, not history', () => {
    const t = 'FYI\n\n---------- Forwarded message ---------\nFrom: HMRC <noreply@hmrc.example>\nDate: Mon, 21 Sep 2026\nSubject: Your tax code\nTo: me\n\nYour tax code has changed to 1257L.';
    const r = splitQuotes(t);
    expect(r.newText).toContain('Your tax code has changed to 1257L.');
    expect(r.quoted).toBe('');
  });
});

describe('splitSignature', () => {
  it('splits at the "-- " delimiter', () => {
    expect(splitSignature('See you then.\n-- \nMarta Kowalski\nKowalski Design')).toEqual({ text: 'See you then.', signature: 'Marta Kowalski\nKowalski Design' });
  });
  it('splits mobile signatures in several languages', () => {
    expect(splitSignature('On my way.\n\nSent from my iPhone').signature).toBe('Sent from my iPhone');
    expect(splitSignature('Bin gleich da.\n\nVon meinem iPhone gesendet').signature).toBe('Von meinem iPhone gesendet');
    expect(splitSignature('Ok\n\nGet Outlook for iOS').text).toBe('Ok');
  });
  it('treats the short block after a valediction as signature and keeps the valediction', () => {
    const r = splitSignature('Our fee is £1,450.\n\nKind regards,\nThomas Reed\nReed Immigration Law');
    expect(r.text).toBe('Our fee is £1,450.\n\nKind regards,');
    expect(r.signature).toBe('Thomas Reed\nReed Immigration Law');
  });
  it('leaves text alone when what follows a valediction is long', () => {
    const long = 'Thanks\nHere is a long paragraph that keeps going well beyond what any signature line would ever contain in practice.';
    expect(splitSignature(long).signature).toBe('');
  });
});

describe('splitDisclaimer', () => {
  it('pulls legal footers off the end and external banners off the start', () => {
    const t = 'CAUTION: This email originated from outside of the organization.\n\nThe contract is attached.\n\nThis e-mail and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please delete it.';
    const r = splitDisclaimer(t);
    expect(r.text).toBe('The contract is attached.');
    expect(r.disclaimer).toContain('intended recipient');
    expect(r.disclaimer).toContain('originated from outside');
  });
  it('does not mistake a short confidential remark for a footer', () => {
    expect(splitDisclaimer('Please keep this confidential for now.').text).toBe('Please keep this confidential for now.');
  });
});

describe('splitHtml / splitBody (HTML)', () => {
  it('splits Gmail quote and signature containers', () => {
    const html = '<div dir="ltr">Thursday at 3 works.<div><br></div><div class="gmail_signature" data-smartmail="gmail_signature">Priya Nair | HR</div></div>'
      + '<div class="gmail_quote"><div class="gmail_attr">On Mon, Sep 21, 2026 at 10:02 AM Prakhar wrote:<br></div><blockquote class="gmail_quote">Can we meet?</blockquote></div>';
    const r = splitBody({ body_html: html });
    expect(r.newText).toBe('Thursday at 3 works.');
    expect(r.signature).toContain('Priya Nair | HR');
    expect(r.quoted).toContain('Can we meet?');
  });
  it('treats everything after Outlook\'s divRplyFwdMsg as history', () => {
    const html = '<div>Approved.</div><hr><div id="divRplyFwdMsg"><b>From:</b> Finance<br><b>Sent:</b> Monday</div><div>Please approve invoice 2041.</div>';
    const r = splitBody({ body_html: html });
    expect(r.newText).toBe('Approved.');
    expect(r.quoted).toContain('Please approve invoice 2041.');
  });
  it('splits Apple/Thunderbird blockquote type=cite', () => {
    const r = splitBody({ body_html: '<p>Done, thanks!</p><div class="moz-cite-prefix">On 21/09/2026 Anna wrote:</div><blockquote type="cite"><p>Is the form signed?</p></blockquote>' });
    expect(r.newText).toBe('Done, thanks!');
    expect(r.quoted).toContain('Is the form signed?');
    expect(r.quoted).toContain('Anna wrote');
  });
  it('keeps a Gmail forward container as the message itself', () => {
    const html = '<div>fyi</div><div class="gmail_quote">---------- Forwarded message ---------<br>From: HMRC<br><br>Your tax code changed.</div>';
    const r = splitBody({ body_html: html });
    expect(r.newText).toContain('Your tax code changed.');
  });
  it('returns null for HTML without structure and falls back to the text rules', () => {
    expect(splitHtml('<p>Hello</p><p>World</p>')).toBeNull();
    const r = splitBody({ body_html: '<p>Hi there</p><p>On Mon, 21 Sep 2026, Bob &lt;b@x.example&gt; wrote:</p><p>&gt; old</p>' });
    expect(r.newText).toBe('Hi there');
    expect(r.quoted).toContain('old');
  });
  it('uses the snippet when no body has arrived and accepts a plain string', () => {
    expect(splitBody({ snippet: 'Invoice 2041 attached' }).newText).toBe('Invoice 2041 attached');
    expect(splitBody('Plain text\n\nSent from my iPhone')).toMatchObject({ newText: 'Plain text', signature: 'Sent from my iPhone' });
  });
});

describe('bodies that used to give no text (prod, 2026-09-24)', () => {
  const { looksLikeHtml, textChars } = await_parse;
  it('a text part that is only a line break does not hide the HTML part', () => {
    const r = splitBody({ body_text: '\r\n', body_html: '<style>body{width:100%}</style><table><tr><td><p>Delhi Metro stations are getting new lifts.</p></td></tr></table>' });
    expect(r.newText).toContain('Delhi Metro stations are getting new lifts.');
    expect(r.newText).not.toContain('width');
  });
  it('HTML sent in the text part is converted, not indexed as markup', () => {
    const html = '\r\n\r\n<!DOCTYPE html><html><body><div><p>Your refund of Rs.295 has been processed.</p></div></body></html>';
    expect(looksLikeHtml(html)).toBe(true);
    const r = splitBody({ body_text: html, body_html: null });
    expect(r.newText).toContain('Your refund of Rs.295 has been processed.');
    expect(r.newText).not.toMatch(/<[a-z!]/i);
    expect(looksLikeHtml('Use <b> for bold, I said.')).toBe(false);
  });
  it('a one-paragraph body that mentions "confidential" is the message, not a footer', () => {
    const t = '--- REPLY ABOVE THIS LINE TO POST A COMMENT --- Poor confidentiality maintained at the clinic: my records were shared without consent and I want this escalated.';
    const r = splitBody(t);
    expect(r.newText).toBe(t);
    expect(r.disclaimer).toBe('');
    expect(textChars(r)).toBe(t.length);
    // A real footer after a message is still taken off.
    const withFooter = splitDisclaimer('See you Friday.\n\nThis email and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, delete it.');
    expect(withFooter.text).toBe('See you Friday.');
    expect(withFooter.disclaimer).toMatch(/intended recipient/);
  });
});
