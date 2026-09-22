import { describe, it, expect } from 'vitest';
import { isNewsletter, selectForPaper, localParts, shouldBuild, snippetLine } from './select.js';
import activate from './index.js';

const nl = (over) => ({ id: over.id, from_email: 'hello@stratechery.substack.com', from_name: 'Stratechery', subject: 'Issue #12', date: '2026-09-22T07:00:00Z', has_list_unsubscribe: true, ...over });

describe('newsletter detection', () => {
  it('recognises platform newsletters and list mail', () => {
    expect(isNewsletter(nl({ id: '1' }))).toBe(true);
    expect(isNewsletter({ from_email: 'weekly@acme.io', has_list_unsubscribe: true, subject: 'This week at Acme' })).toBe(true);
    expect(isNewsletter({ category: 'newsletter', from_email: 'x@y.z' })).toBe(true);
  });
  it('leaves transactional and personal mail alone', () => {
    expect(isNewsletter({ from_email: 'no-reply@bank.example', has_list_unsubscribe: true, is_bulk: true, subject: 'Your one-time code' })).toBe(false);
    expect(isNewsletter({ from_email: 'sam@friend.example', subject: 'Lunch?' })).toBe(false);
    expect(isNewsletter({ ...nl({ id: '1' }), is_outgoing: true })).toBe(false);
  });
});

describe('paper selection', () => {
  it('keeps the newest issue per sender since the cut-off, sorted by sender', () => {
    const picked = selectForPaper([
      nl({ id: 'a', date: '2026-09-22T07:00:00Z' }),
      nl({ id: 'b', date: '2026-09-22T09:00:00Z' }),
      nl({ id: 'c', from_email: 'news@axios.com', from_name: 'Axios', subject: 'Axios AM', category: 'newsletter', date: '2026-09-22T06:00:00Z' }),
      nl({ id: 'old', from_email: 'daily@old.example', from_name: 'Old', date: '2026-09-10T06:00:00Z' }),
      { id: 'p', from_email: 'sam@friend.example', subject: 'Lunch?', date: '2026-09-22T08:00:00Z' },
    ], { since: '2026-09-21T07:00:00Z', max: 10 });
    expect(picked.map((m) => m.id)).toEqual(['c', 'b']);
  });
  it('builds once a day after the configured hour in the user\'s zone', () => {
    const at = new Date('2026-09-23T05:30:00Z');
    expect(localParts('Asia/Kolkata', at)).toEqual({ date: '2026-09-23', hour: 11 });
    expect(localParts('America/Los_Angeles', at)).toEqual({ date: '2026-09-22', hour: 22 });
    expect(localParts('Not/AZone', at).date).toBe('2026-09-23');
    expect(shouldBuild({ hour: 6, paperHour: 7, exists: false })).toBe(false);
    expect(shouldBuild({ hour: 7, paperHour: 7, exists: false })).toBe(true);
    expect(shouldBuild({ hour: 9, paperHour: 7, exists: true })).toBe(false);
  });
  it('falls back to a trimmed snippet', () => {
    expect(snippetLine('Short one.')).toBe('Short one.');
    expect(snippetLine('word '.repeat(60), 120)).toMatch(/^word( word)+…$/);
    expect(snippetLine(`${'word '.repeat(20)}ends here. And then a great deal more text that goes on and on well past the limit`, 120)).toMatch(/ends here\.$/);
  });
});

describe('beforeTriage', () => {
  it('files newsletters under digest when the setting is on', async () => {
    const settings = { forceDigest: true, paperHour: 7, maxItems: 40 };
    const hedwig = { PermissionError: class extends Error {}, settings: { get: async () => settings }, router: () => ({ get() {}, post() {} }), mail: {}, logger: { debug() {} } };
    const { hooks } = activate(hedwig);
    expect(await hooks.beforeTriage({ userId: 'u', message: nl({ id: 'a' }) })).toEqual({ verdict: { category: 'digest', reason: 'Newsletter' }, features: { newsletter: 1 } });
    expect(await hooks.beforeTriage({ userId: 'u', message: { from_email: 'sam@friend.example', subject: 'hi' } })).toBeUndefined();
    settings.forceDigest = false;
    expect(await hooks.beforeTriage({ userId: 'u', message: nl({ id: 'a' }) })).toBeUndefined();
  });
});
