import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../../services/db.js', () => ({ query: (...args) => query(...args), pool: {} }));
vi.mock('../config.js', () => ({
  getConfig: vi.fn(async () => ({ 'context.extractMinConfidence': 0.6, 'insights.timezone': 'Europe/London' })),
}));

const { listCommitments, updateCommitment, updateFact } = await import('./commitments.js');

const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('listCommitments', () => {
  it('scopes to the user, hides low-confidence extractions and filters by status and direction', async () => {
    await listCommitments(USER, { status: 'open', direction: 'they_owe', limit: 5 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/c\.user_id = \$1/);
    expect(sql).toMatch(/c\.confidence >= \$2/);
    expect(params).toEqual([USER, 0.6, 5, 'open', 'they_owe']);
  });
  it('rejects unknown filters', async () => {
    await expect(listCommitments(USER, { status: 'late' })).rejects.toMatchObject({ status: 400 });
    await expect(listCommitments(USER, { direction: 'both' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('updateCommitment', () => {
  it("only updates the user's own row and marks it user-edited", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, status: 'done', overdue: false, confidence: '0.9' }] });
    const out = await updateCommitment(USER, ID, { status: 'done' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE c\.id = \$1 AND c\.user_id = \$2/);
    expect(sql).toMatch(/user_edited = true/);
    expect(params.slice(0, 3)).toEqual([ID, USER, 'done']);
    expect(out).toMatchObject({ id: ID, status: 'done', confidence: 0.9, overdue: false });
  });
  it('returns null for a commitment that is not the caller\'s', async () => {
    expect(await updateCommitment(USER, ID, { what: 'Pay invoice' })).toBeNull();
  });
  it('reads a bare due date as the end of that day in the user zone', async () => {
    await updateCommitment(USER, ID, { due_at: '2026-07-01' });
    expect(query.mock.calls[0][1][2].toISOString()).toBe('2026-07-01T22:59:59.000Z');
  });
  it('validates the patch', async () => {
    await expect(updateCommitment(USER, ID, {})).rejects.toMatchObject({ status: 400 });
    await expect(updateCommitment(USER, ID, { status: 'maybe' })).rejects.toMatchObject({ status: 400 });
    await expect(updateCommitment(USER, ID, { what: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(updateCommitment(USER, ID, { due_at: 'soon' })).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('updateFact', () => {
  it('pins, dismisses and edits within the user scope', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, key: 'ref', value: 'X', pinned: true, confidence: null }] });
    const out = await updateFact(USER, ID, { value: ' X ', pinned: true, dismissed: false });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/f\.user_id = \$2/);
    expect(params).toEqual([ID, USER, 'X', false, true]); // value, dismissed, pinned
    expect(out).toMatchObject({ id: ID, pinned: true, confidence: null });
  });
  it('rejects non-boolean flags', async () => {
    await expect(updateFact(USER, ID, { pinned: 'yes' })).rejects.toMatchObject({ status: 400 });
  });
});
