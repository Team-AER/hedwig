import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const logged = [];
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) {
      logged.push(params);
      return { rows: [{ id: 42 }] };
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
const { decisionState, gate, decideBatch, QUESTIONS } = await import('./decision.js');

const ROW = {
  id: 'm-1', from_name: 'Priya', from_email: 'priya@example.com', to_addresses: [{ address: 'me@example.com' }],
  in_reply_to: '<abc@x>', subject: 'Payslips', body_text: 'old body',
};
const PARTS = { newText: 'Can you send the payslips by Friday?' };

function answers({ stream = 'people', p = 0.95, spam = 0.02, needs = 0.93 } = {}) {
  const rest = (1 - p) / 2;
  const probabilities = { people: rest, reading: rest, records: rest, [stream]: p };
  return {
    model: 'aer-laya',
    answers: {
      stream: { type: 'choice', choice: stream, probabilities, confidence: 0.8 },
      spam: { type: 'noul', noul: spam },
      needs_you: { type: 'noul', noul: needs },
    },
    usage: { input_tokens: 300, output_tokens: 3 },
  };
}

beforeEach(() => {
  cfg = { ...DEFAULTS, enabled: true, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'llm.probe.enabled': false };
  gw.decisions.length = 0;
  gw.systemone = null;
  logged.length = 0;
  gw.install();
});
afterAll(() => gw.restore());

describe('decision state', () => {
  it('matches the training format', () => {
    expect(decisionState(ROW, PARTS)).toBe(
      'From: Priya <priya@example.com>\nTo: 1 recipient(s); a reply in an existing thread\nSubject: Payslips\n\nCan you send the payslips by Friday?',
    );
    const spammy = decisionState({ ...ROW, in_reply_to: null, to_addresses: '[]' }, { newText: 'x'.repeat(5000) }, { inSpamFolder: true });
    expect(spammy).toContain("To: 0 recipient(s)\nDelivered to the server's spam folder\nSubject:");
    expect(spammy.split('\n\n')[1]).toHaveLength(1200);
  });

  it('asks the trained questions in the Nimble-compatible shape', () => {
    expect(Object.keys(QUESTIONS)).toEqual(['stream', 'spam', 'needs_you']);
    expect(Object.keys(QUESTIONS.stream.criteria)).toEqual(['people', 'reading', 'records']);
    expect(QUESTIONS.spam.type).toBe('noul');
  });
});

describe('gate', () => {
  it('accepts confident clean answers', () => {
    const r = gate(answers().answers, { ...DEFAULTS });
    expect(r).toMatchObject({ layer: 'decision', stream: 'people', needsYou: true, spam: 'clean' });
    expect(r.confidence).toBeCloseTo(0.93, 2);
    expect(gate(answers({ needs: 0.05 }).answers, DEFAULTS).needsYou).toBe(false);
  });

  it('escalates unsure or spam-like mail to Reflex', () => {
    expect(gate(answers({ p: 0.7 }).answers, DEFAULTS)).toBeNull(); // stream unsure
    expect(gate(answers({ spam: 0.3 }).answers, DEFAULTS)).toBeNull(); // possibly spam: Reflex tells phishing apart
    expect(gate(answers({ needs: 0.5 }).answers, DEFAULTS)).toBeNull(); // needs-you unsure
    expect(gate({}, DEFAULTS)).toBeNull();
  });
});

describe('decideBatch', () => {
  it('posts one System One request per message through the gateway and keeps the confident ones', async () => {
    gw.systemone = (body) => (body.state.includes('Payslips') ? answers() : answers({ p: 0.6 }));
    const out = await decideBatch('user-1', [
      { row: ROW, parts: PARTS, d: {} },
      { row: { ...ROW, id: 'm-2', subject: 'Something else' }, parts: PARTS, d: {} },
    ], cfg);
    expect([...out.keys()]).toEqual(['m-1']);
    expect(out.get('m-1').provenance).toMatchObject({ id: 'sort.decision', model: 'aer-laya', aiCallId: 42 });
    expect(gw.decisions).toHaveLength(2);
    const { body, headers } = gw.decisions[0];
    expect(body).toMatchObject({ model: 'aer-laya', questions: QUESTIONS });
    expect(headers['x-workflow']).toBe('sort.decision');
    expect(logged).toHaveLength(2); // both calls logged in hedwig_ai_calls
  });

  it('never throws: a gateway or model failure leaves everything to Reflex', async () => {
    gw.systemone = () => ({ status: 503, error: 'model pool unavailable' });
    const out = await decideBatch('user-1', [{ row: ROW, parts: PARTS, d: {} }, { row: { ...ROW, id: 'm-2' }, parts: PARTS, d: {} }], cfg);
    expect(out.size).toBe(0);
    expect(gw.decisions).toHaveLength(1); // stops at the first failure instead of hammering a down endpoint
  });

  it('is off without a model', async () => {
    const out = await decideBatch('user-1', [{ row: ROW, parts: PARTS, d: {} }], { ...cfg, 'sort.decision.model': '' });
    expect(out.size).toBe(0);
    expect(gw.decisions).toHaveLength(0);
  });
});
