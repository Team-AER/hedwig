import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { chunkText, tailWords, contextHeader, buildMessageChunks, buildThreadRollup } = await import('./chunk.js');
const { estimateTokens } = await import('../text.js');

const para = (n, word = 'lorem') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

describe('chunkText', () => {
  it('returns one chunk for short text and nothing for empty text', () => {
    expect(chunkText('Hello there.\n\nSecond paragraph.')).toEqual(['Hello there.\n\nSecond paragraph.']);
    expect(chunkText('   ')).toEqual([]);
  });
  it('packs whole paragraphs up to the token budget and cuts at paragraph boundaries', () => {
    const paras = Array.from({ length: 6 }, (_, i) => para(40, `p${i}w`)); // ~6-7 chars/word → ~70 tokens each
    const chunks = chunkText(paras.join('\n\n'), { maxTokens: 150, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c)).toBeLessThanOrEqual(150);
      // every chunk is made of whole paragraphs
      for (const piece of c.split('\n\n')) expect(paras).toContain(piece);
    }
    expect(chunks.join('\n\n')).toBe(paras.join('\n\n'));
  });
  it('carries about `overlap` tokens from the end of one chunk into the next', () => {
    const paras = Array.from({ length: 4 }, (_, i) => para(60, `q${i}w`));
    const chunks = chunkText(paras.join('\n\n'), { maxTokens: 120, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(2);
    const carried = tailWords(chunks[0], 20);
    expect(carried.length).toBeGreaterThan(0);
    expect(estimateTokens(carried)).toBeLessThanOrEqual(21);
    expect(chunks[1].startsWith(carried)).toBe(true);
  });
  it('splits an over-long paragraph by sentences, then words', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} talks about the visa application in some detail.`).join(' ');
    const chunks = chunkText(sentences, { maxTokens: 60, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(60);
    const oneHugeWordRun = para(500);
    for (const c of chunkText(oneHugeWordRun, { maxTokens: 100, overlap: 0 })) expect(estimateTokens(c)).toBeLessThanOrEqual(100);
  });
  it('respects maxChunks', () => {
    expect(chunkText(para(2000), { maxTokens: 64, overlap: 0, maxChunks: 3 })).toHaveLength(3);
  });
});

const row = {
  id: 'm1', subject: 'Invoice 2041', from_name: 'Marta Kowalski', from_email: 'marta@kowalski-design.example',
  to_addresses: [{ address: 'me@prafiles.example', name: '' }], date: '2026-09-20T09:00:00Z', folder: 'INBOX',
  body_text: 'x', attachments: [{ filename: 'invoice-2041.pdf', part: '2' }],
};

describe('contextHeader', () => {
  it('names subject, sender, date, folder and the attachment', () => {
    expect(contextHeader(row)).toBe('Invoice 2041 · Marta Kowalski <marta@kowalski-design.example> · 2026-09-20 · INBOX');
    expect(contextHeader(row, { kind: 'attachment', attachmentName: 'invoice-2041.pdf' })).toContain('attachment: invoice-2041.pdf');
    expect(contextHeader(row, { kind: 'quote' })).toContain('quoted history');
  });
});

describe('buildMessageChunks', () => {
  const parts = { newText: 'Please find invoice 2041 attached: €1,840 due within 14 days.', quoted: 'Earlier: can you send the invoice?', signature: 'Marta Kowalski\n+44 20 7946 0000' };
  const chunks = buildMessageChunks(row, parts, [{ index: 0, filename: 'invoice-2041.pdf', text: 'INVOICE 2041\nTotal due: EUR 1,840.00\nIBAN DE89 3704 0044 0532 0130 00' }]);
  it('makes header, body, attachment and quote chunks, each starting with the context line', () => {
    expect(chunks.map((c) => c.kind)).toEqual(['header', 'body', 'attachment', 'quote']);
    for (const c of chunks) expect(c.text.split('\n')[0]).toContain('Invoice 2041 · Marta Kowalski');
    expect(chunks[0].text).toContain('Attachments: invoice-2041.pdf');
    expect(chunks[0].text).toContain('Signature: Marta Kowalski +44 20 7946 0000');
    expect(chunks[2]).toMatchObject({ attachmentIndex: 0 });
    expect(chunks[2].text).toContain('IBAN DE89');
  });
  it('weights the subject on its own and keeps it out of the body text used for the tsvector', () => {
    expect(chunks[1].tsSubject).toBe('Invoice 2041');
    expect(chunks[1].tsBody.startsWith(' · Marta')).toBe(true);
    expect(chunks[1].tokens).toBe(estimateTokens(chunks[1].text));
  });
  it('carries the snippet in the header chunk until the body arrives', () => {
    const noBody = { ...row, body_text: null, body_html: null, snippet: 'Please find invoice 2041' };
    const c = buildMessageChunks(noBody, { newText: 'Please find invoice 2041', quoted: '', signature: '' });
    expect(c[0].text).toContain('Snippet: Please find invoice 2041');
  });
});

describe('buildThreadRollup', () => {
  const msg = (from, date, text) => ({ row: { subject: 'Re: Visa sponsorship', from_name: from, from_email: `${from.toLowerCase()}@x.example`, date }, newText: text });
  it('needs two messages', () => {
    expect(buildThreadRollup([msg('Priya', '2026-05-01', 'hi')])).toBeNull();
  });
  it('summarises participants, dates and each message in order', () => {
    const r = buildThreadRollup([
      msg('Priya', '2026-05-01T09:00:00Z', 'Vantage will sponsor your visa.'),
      msg('Prakhar', '2026-05-02T09:00:00Z', 'Thanks, passport attached.'),
      msg('Priya', '2026-05-03T09:00:00Z', 'Solicitor confirmed.'),
    ]);
    expect(r.kind).toBe('thread');
    expect(r.text.split('\n')[0]).toBe('Visa sponsorship · thread of 3 messages · Priya, Prakhar · 2026-05-01 to 2026-05-03');
    expect(r.text).toMatch(/2026-05-01 Priya: Vantage will sponsor your visa\.\n2026-05-02 Prakhar: Thanks, passport attached\.\n2026-05-03 Priya: Solicitor confirmed\./);
  });
  it('stays within budget for long threads, keeping the opening and latest messages', () => {
    const many = Array.from({ length: 40 }, (_, i) => msg(`P${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, para(60, `m${i}w`)));
    const r = buildThreadRollup(many, { maxTokens: 200 });
    expect(r.text.length).toBeLessThanOrEqual(Math.round(200 * 1.4 * 4) + 5);
    expect(r.text).toContain('P0:');
    expect(r.text).toContain('P39:');
  });
});
