import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const logged = [];
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) {
      logged.push(params);
      return { rows: [{ id: 7 }] };
    }
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const gw = mockGateway();
let cfg = {};
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) };
});
const { SCHEMA } = await import('../config.js');
const DEFAULTS = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));
const { guardState, contextLines, guardVerdict, guardBatch, guardCandidate, hrefDomains, QUESTIONS } = await import('./guard.js');
const { registrable } = await import('./spam.js');

const people = new Map([['dana reyes', ['dana.reyes@corp.example']]]);
const ROW = {
  id: 'g-1', from_name: 'Dana Reyes', from_email: 'dana.reyes.office@gmail.com', to_addresses: [{ address: 'me@example.com' }],
  in_reply_to: null, subject: 'Quick favour', body_text: 'Are you free? I need a quick favour.',
  body_html: '<p>Open the <a href="https://files-view.example/doc">docs.corpmail.com</a> today</p>',
  attachments: [{ filename: 'image001.png' }, { filename: 'Brief.html' }], reply_to: [{ address: 'dana.r.desk@outlook.com' }],
};

function answers(p) {
  const probabilities = { safe: 0, spam: 0, scam: 0, phishing: 0, impersonation: 0, malware: 0, ...p };
  return { model: 'aer-laya-guard', answers: { threat: { type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities, confidence: 0.7 } }, usage: { input_tokens: 400, output_tokens: 1 } };
}

beforeEach(() => {
  cfg = { ...DEFAULTS, enabled: true, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'llm.probe.enabled': false };
  gw.decisions.length = 0;
  gw.systemone = null;
  logged.length = 0;
  gw.install();
});
afterAll(() => gw.restore());

describe('guard state', () => {
  it('matches the training format (dm/threat.py): identity lines, links, attachments, then subject and body', () => {
    const s = guardState(ROW, { newText: ROW.body_text }, { written: 0, received: 0, knownPeople: people, knownDomains: ['corp.example'] });
    expect(s.split('\n')).toEqual([
      'From: Dana Reyes <dana.reyes.office@gmail.com>',
      'Sender: first message from this address; you have never written to it',
      'Known name: "Dana Reyes" is someone you write to at dana.reyes@corp.example; this address is not one of them',
      'Reply-To: replies go to dana.r.desk@outlook.com',
      'To: 1 recipient(s)',
      'Links: files-view.example',
      'Link text: shows "docs.corpmail.com" but goes to files-view.example',
      'Attachments: Brief.html',
      'Subject: Quick favour',
      '',
      'Are you free? I need a quick favour.',
    ]);
  });

  it('describes history, own addresses, hidden addresses and look-alikes of correspondents only', () => {
    expect(contextLines({ from_email: 'a@b.example' }, { written: 12 })).toEqual(['Sender: you have written to this address 10+ time(s)']);
    expect(contextLines({ from_email: 'a@b.example' }, { received: 3 })[0]).toBe('Sender: 3 earlier message(s) from this address; you have never written to it');
    expect(contextLines({ from_email: 'me@example.com' }, { own: true })).toEqual(["Sender: one of the user's own addresses"]);
    expect(contextLines({ from_name: 'dana.reyes@corp.example', from_email: 'x@mailer.example' }, {})).toContain('Display name: contains a different address, dana.reyes@corp.example');
    expect(contextLines({ from_email: 'ap@vendor-co.example' }, { knownDomains: ['vendorco.example'] }))
      .toContain('Look-alike: the domain vendor-co.example looks like vendorco.example, a domain you write to');
    // a brand look-alike is rule evidence (spam.js), not a line the model was trained on
    expect(contextLines({ from_email: 'help@paypa1.com' }, { knownDomains: [] }).some((l) => l.startsWith('Look-alike'))).toBe(false);
  });

  it('lists link targets like training does (hrefs only, hosts sorted, registrable and deduplicated)', () => {
    const html = '<img src="https://cdn.images.example/a.png"><a href="https://www.zeta.example/x">z</a> <a href=https://alpha.example/y>a</a> <a href="https://m.zeta.example">z2</a>';
    expect(hrefDomains(html)).toEqual(['alpha.example', 'zeta.example']);
    expect(hrefDomains(null)).toEqual([]);
    // India's .bank.in second level keeps banks apart
    expect(registrable('alerts.hdfcbank.bank.in')).toBe('hdfcbank.bank.in');
    expect(registrable('kotak.bank.in')).toBe('kotak.bank.in');
  });

  it('asks one Nimble-compatible choice question over the trained threat options', () => {
    expect(Object.keys(QUESTIONS.threat.criteria)).toEqual(['safe', 'spam', 'scam', 'phishing', 'impersonation', 'malware']);
  });
});

describe('guard verdict', () => {
  it('leaves mail alone unless the malicious options are confident together', () => {
    expect(guardVerdict(answers({ safe: 0.9, phishing: 0.1 }).answers, {}, DEFAULTS)).toBeNull();
    expect(guardVerdict(answers({ spam: 0.6, scam: 0.4 }).answers, {}, DEFAULTS)).toBeNull();
    expect(guardVerdict({}, {}, DEFAULTS)).toBeNull();
  });

  it('calls it phishing with rule evidence or very high confidence, suspected otherwise; a scam is suspected', () => {
    const p = answers({ impersonation: 0.6, phishing: 0.3, safe: 0.1 }).answers;
    expect(guardVerdict(p, { phishingScore: 0 }, DEFAULTS)).toMatchObject({ spam: 'suspected', threat: 'impersonation' });
    const signals = [{ name: 'dmarc', label: 'DMARC passed', weight: 0.5 }, { name: 'impersonation', label: 'Named "Dana Reyes" like your contact at dana.reyes@corp.example', weight: 0.4 }];
    const withRules = guardVerdict(p, { phishingScore: 0.4, signals }, DEFAULTS);
    expect(withRules).toMatchObject({ spam: 'phishing', threat: 'impersonation' });
    expect(withRules.reason).toBe('Looks like impersonation of someone you know (threat model, 90% sure); Named "Dana Reyes" like your contact at dana.reyes@corp.example');
    expect(guardVerdict(answers({ malware: 0.97 }).answers, {}, DEFAULTS).spam).toBe('phishing');
    expect(guardVerdict(answers({ scam: 0.99 }).answers, { phishingScore: 0.5 }, DEFAULTS).spam).toBe('suspected');
  });

  it('checks unfamiliar senders only', () => {
    expect(guardCandidate(ROW, { layer: 'classifier' })).toBe(true);
    expect(guardCandidate(ROW, { trustedSender: true })).toBe(false);
    expect(guardCandidate(ROW, { own: true })).toBe(false);
    expect(guardCandidate(ROW, { inSpamFolder: true })).toBe(false);
    expect(guardCandidate(ROW, { layer: 'rule', ruleId: 'r1' })).toBe(false);
    expect(guardCandidate({ ...ROW, body_text: null, body_html: null, snippet: null }, {})).toBe(false);
  });
});

describe('guardBatch', () => {
  it('posts one System One request per message and returns the flagged ones with provenance', async () => {
    gw.systemone = (body) => (body.state.includes('Quick favour') ? answers({ impersonation: 0.92, safe: 0.08 }) : answers({ safe: 0.97 }));
    const out = await guardBatch('user-1', [
      { row: ROW, d: { phishingScore: 0.4, signals: [{ name: 'impersonation', label: 'Named "Dana Reyes" like your contact', weight: 0.4 }] }, history: {} },
      { row: { ...ROW, id: 'g-2', subject: 'Lunch?' }, d: {}, history: { written: 4 } },
    ], cfg, { knownPeople: people, knownDomains: ['corp.example'] });
    expect([...out.keys()]).toEqual(['g-1']);
    expect(out.get('g-1')).toMatchObject({ spam: 'phishing', threat: 'impersonation', provenance: { promptId: 'sort.guard', model: 'aer-laya-guard', aiCallId: 7 } });
    expect(gw.decisions).toHaveLength(2);
    expect(gw.decisions[0].body).toMatchObject({ model: 'aer-laya-guard', questions: QUESTIONS });
    expect(gw.decisions[0].headers['x-workflow']).toBe('sort.guard');
    expect(gw.decisions[1].body.state).toContain('Sender: you have written to this address 4 time(s)');
  });

  it('never throws: a gateway failure leaves the batch as sorted', async () => {
    gw.systemone = () => ({ status: 503, error: 'model pool unavailable' });
    const out = await guardBatch('user-1', [{ row: ROW, d: {}, history: {} }, { row: { ...ROW, id: 'g-2' }, d: {}, history: {} }], cfg);
    expect(out.size).toBe(0);
    expect(gw.decisions).toHaveLength(1);
  });

  it('is off without a model', async () => {
    const out = await guardBatch('user-1', [{ row: ROW, d: {}, history: {} }], { ...cfg, 'sort.guard.model': '' });
    expect(out.size).toBe(0);
    expect(gw.decisions).toHaveLength(0);
  });
});
