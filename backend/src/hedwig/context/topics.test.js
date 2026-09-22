import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { updateCentroid, nearestTopic, planTopics, needsLabel, normaliseLabel } = await import('./topics.js');
const { cosine, l2 } = await import('../embeddings.js');

const unit = (...v) => l2(v);

function state(over = {}) {
  let n = 0;
  return {
    threadTopics: new Map(), topics: new Map(), members: new Set(), threshold: 0.8, newId: () => `new${++n}`, ...over,
  };
}

describe('centroid math', () => {
  it('starts from the first vector and keeps a normalised running mean', () => {
    const a = unit(1, 0);
    const b = unit(0, 1);
    const c1 = updateCentroid(null, 0, a);
    expect(c1).toEqual(a);
    const c2 = updateCentroid(c1, 1, b);
    expect(Math.hypot(...c2)).toBeCloseTo(1, 6);
    expect(c2[0]).toBeCloseTo(c2[1], 6);
    // A third vector along x pulls the mean of three towards x (weight 2:1).
    const c3 = updateCentroid(c2, 2, a);
    expect(c3[0]).toBeGreaterThan(c3[1]);
  });
  it('ignores a missing vector and restarts on a dimension change', () => {
    expect(updateCentroid([1, 0], 3, null)).toEqual([1, 0]);
    expect(updateCentroid([1, 0], 3, [0, 0, 1])).toEqual([0, 0, 1]);
  });
  it('finds the nearest topic at or above the threshold only', () => {
    const topics = [{ id: 'a', centroid: unit(1, 0.1) }, { id: 'b', centroid: unit(0.2, 1) }, { id: 'c', centroid: null }];
    expect(nearestTopic(unit(1, 0), topics, 0.9).topic.id).toBe('a');
    expect(nearestTopic(unit(1, 1), topics, 0.99)).toBeNull();
    expect(nearestTopic(null, topics, 0.1)).toBeNull();
  });
});

describe('planTopics', () => {
  const visa = unit(1, 0, 0);
  const visaish = unit(0.95, 0.1, 0);
  const boiler = unit(0, 0, 1);

  it('joins by thread first, then by centroid, else starts a topic', () => {
    const s = state({
      threadTopics: new Map([['t-visa', 'T1']]),
      topics: new Map([['T1', { id: 'T1', centroid: visa, n: 2, dims: 3 }]]),
    });
    const plan = planTopics([
      { id: 'm1', thread_key: 't-visa', date: '2026-09-01', eligible: true, vec: boiler },
      { id: 'm2', thread_key: 't-sol', date: '2026-09-02', eligible: true, vec: visaish },
      { id: 'm3', thread_key: 't-boiler', date: '2026-09-03', eligible: true, vec: boiler },
    ], s);
    expect(plan.joins.map((j) => [j.messageId, j.topicId])).toEqual([['m1', 'T1'], ['m2', 'T1'], ['m3', 'new1']]);
    expect(plan.created).toEqual(['new1']);
    expect([...plan.newThreads.entries()]).toEqual([['t-sol', 'T1'], ['t-boiler', 'new1']]);
    expect(s.topics.get('T1').n).toBe(4);
  });

  it('processes oldest first so a thread keeps the topic its first message chose', () => {
    const plan = planTopics([
      { id: 'reply', thread_key: 't', date: '2026-09-05', eligible: true, vec: boiler },
      { id: 'first', thread_key: 't', date: '2026-09-01', eligible: true, vec: visa },
    ], state());
    expect(plan.joins.map((j) => j.messageId)).toEqual(['first', 'reply']);
    expect(new Set(plan.joins.map((j) => j.topicId)).size).toBe(1);
  });

  it('never starts a topic from outgoing mail, bulk mail or messages already placed', () => {
    const s = state({ members: new Set(['done']) });
    const plan = planTopics([
      { id: 'sent', thread_key: 'a', date: '2026-09-01', outgoing: true, eligible: true, vec: visa },
      { id: 'news', thread_key: 'b', date: '2026-09-01', eligible: false, vec: visa },
      { id: 'done', thread_key: 'c', date: '2026-09-01', eligible: true, vec: visa },
    ], s);
    expect(plan.joins).toEqual([]);
    expect(plan.created).toEqual([]);
  });

  it('lets outgoing mail join its thread topic, including one started earlier in the batch', () => {
    const plan = planTopics([
      { id: 'in', thread_key: 'x', date: '2026-09-01', eligible: true, vec: visa },
      { id: 'out', thread_key: 'x', date: '2026-09-02', outgoing: true, eligible: true, vec: visaish },
    ], state());
    expect(plan.joins.map((j) => j.topicId)).toEqual(['new1', 'new1']);
  });

  it('falls back to one topic per thread without embeddings', () => {
    const plan = planTopics([
      { id: 'a1', thread_key: 'a', date: '2026-09-01', eligible: true, vec: null },
      { id: 'b1', thread_key: 'b', date: '2026-09-02', eligible: true, vec: null },
      { id: 'a2', thread_key: 'a', date: '2026-09-03', eligible: true, vec: null },
    ], state());
    expect(plan.joins.map((j) => j.topicId)).toEqual(['new1', 'new2', 'new1']);
    expect(plan.joins.every((j) => j.score === null)).toBe(true);
  });

  it('scores joins by similarity to the centroid before the update', () => {
    const s = state({ topics: new Map([['T', { id: 'T', centroid: visa, n: 1, dims: 3 }]]), threadTopics: new Map([['t', 'T']]) });
    const plan = planTopics([{ id: 'm', thread_key: 't', date: '2026-09-01', eligible: true, vec: visaish }], s);
    expect(plan.joins[0].score).toBeCloseTo(cosine(visa, visaish), 6);
  });
});

describe('topic labels', () => {
  it('labels at the minimum size and again after 50% growth', () => {
    expect(needsLabel({ message_count: 2, label: null }, 3)).toBe(false);
    expect(needsLabel({ message_count: 3, label: null }, 3)).toBe(true);
    expect(needsLabel({ message_count: 5, label: 'x', meta: { labelled_count: 4 } }, 3)).toBe(false);
    expect(needsLabel({ message_count: 6, label: 'x', meta: { labelled_count: 4 } }, 3)).toBe(true);
  });
  it('bounds the label to six words and the summary to two sentences', () => {
    expect(normaliseLabel({ label: '"Visa sponsorship for the new role at Vantage."', summary: 'One. Two! Three?' }))
      .toEqual({ label: 'Visa sponsorship for the new role', summary: 'One. Two!' });
    expect(normaliseLabel({ summary: 'x' })).toBeNull();
    expect(normaliseLabel(null)).toBeNull();
  });
});
