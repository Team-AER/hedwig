// The agent cites [n] from its run's search_mail numbers; automations turn that into an insight's
// sources, and still understand the retired [msg:<id>] form from older runs.
import { describe, it, expect, vi } from 'vitest';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const RUN = '99999999-9999-4999-8999-999999999999';
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    if (/FROM hedwig_agent_runs/.test(sql)) {
      return { rows: [{ messages: [{ role: 'tool', name: 'search_mail', content: JSON.stringify({ results: [{ n: 1, id: A }, { n: 2, id: B }, { n: 3, id: C }] }) }] }] };
    }
    if (/SELECT m.id FROM messages m JOIN email_accounts/.test(sql)) return { rows: params[1].filter((id) => id !== C).map((id) => ({ id })) };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const { citeForInsight } = await import('../agent/automations.js');
const { buildSystemPrompt } = await import('../agent/prompt.js');

describe('agent citations', () => {
  it('maps [n] through the run and renumbers for the insight, dropping messages the user does not own', async () => {
    const out = await citeForInsight('u', 'The fee is £1,450 [2]. Reference confirmed [1, 3]. Old style [msg:' + A + '].', RUN);
    expect(out.sources).toEqual([B, A]);
    expect(out.body).toBe('The fee is £1,450 [1]. Reference confirmed [2]. Old style [2].');
  });

  it('tells the agent to cite [n]', () => {
    const p = buildSystemPrompt({ profile: { name: 'P', accounts: [] }, tz: 'UTC' });
    expect(p).toContain('cite it as [n]');
    expect(p).not.toContain('[msg:');
  });
});
