// Run with: node --test src/hedwig/views/helpers.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCitations, linkifyCitations, citedNumbers,
  reduceAsk, ASK_INITIAL, reduceAgent, AGENT_INITIAL, updateActionInItems, itemsFromRun,
  buildSchedule, parseSchedule, describeSchedule,
  formatWhen, formatAgo, dueLabel, formatHours, formatPercent,
  classifyError, triageReason, stageLabel, initials, followUps,
  groupFields, buildConfigPatch, isModelField, niceMax, sparkPoints,
  installSource, pluginMonogram, initialGrants, formatArgs,
} from './helpers.js';

describe('parseCitations', () => {
  it('splits numbered citations, lists and msg ids', () => {
    assert.deepEqual(parseCitations('A [1] b [2, 3] c [msg:ab-12]'), [
      { type: 'text', text: 'A ' }, { type: 'cite', n: 1 }, { type: 'text', text: ' b ' },
      { type: 'cite', n: 2 }, { type: 'cite', n: 3 }, { type: 'text', text: ' c ' }, { type: 'msg', id: 'ab-12' },
    ]);
  });
  it('leaves markdown links and plain brackets alone', () => {
    assert.deepEqual(parseCitations('see [1](http://x) and [note]'), [{ type: 'text', text: 'see [1](http://x) and [note]' }]);
  });
  it('handles adjacent citations and empty input', () => {
    assert.deepEqual(parseCitations('x[1][2]').map((s) => s.n ?? s.text), ['x', 1, 2]);
    assert.deepEqual(parseCitations(''), []);
    assert.deepEqual(parseCitations(null), []);
  });
  it('citedNumbers is unique and ordered', () => {
    assert.deepEqual(citedNumbers('a [2] b [1] c [2]'), [2, 1]);
  });
});

describe('linkifyCitations', () => {
  it('turns markers into buttons', () => {
    const out = linkifyCitations('<p>Done [1] and [msg:m1]</p>');
    assert.match(out, /<button type="button" class="hw-cite" data-cite="1"/);
    assert.match(out, /data-msg="m1"/);
  });
  it('does not touch code blocks or attributes', () => {
    const html = '<pre><code>arr[1]</code></pre><a title="[2]">x</a>';
    assert.equal(linkifyCitations(html), html);
  });
});

describe('reduceAsk', () => {
  it('folds sources, deltas and done', () => {
    let s = ASK_INITIAL;
    s = reduceAsk(s, { type: 'sources', sources: [{ n: 1, message: { id: 'a' } }] });
    s = reduceAsk(s, { type: 'delta', text: 'Hello ' });
    s = reduceAsk(s, { type: 'delta', text: 'world [1]' });
    assert.equal(s.status, 'streaming');
    assert.equal(s.answer, 'Hello world [1]');
    s = reduceAsk(s, { type: 'done', answer: 'Final [1]', citations: [1] });
    assert.equal(s.status, 'done');
    assert.equal(s.answer, 'Final [1]');
    assert.deepEqual(s.citations, [1]);
  });
  it('keeps the streamed answer when done has none, and records errors', () => {
    let s = reduceAsk({ ...ASK_INITIAL, answer: 'x [2]' }, { type: 'done' });
    assert.equal(s.answer, 'x [2]');
    assert.deepEqual(s.citations, [2]);
    s = reduceAsk(s, { type: 'error', error: 'nope' });
    assert.equal(s.status, 'error');
    assert.equal(s.error, 'nope');
    assert.equal(reduceAsk(s, { type: 'weird' }), s);
  });
});

describe('reduceAgent', () => {
  it('builds a transcript from run events', () => {
    let s = AGENT_INITIAL;
    s = reduceAgent(s, { type: 'run', runId: 'r1' });
    s = reduceAgent(s, { type: 'delta', text: 'Looking' });
    s = reduceAgent(s, { type: 'delta', text: '…' });
    s = reduceAgent(s, { type: 'tool_call', id: 't1', name: 'search', arguments: '{"q":"visa"}' });
    s = reduceAgent(s, { type: 'tool_result', id: 't1', name: 'search', ok: true, summary: '3 hits' });
    s = reduceAgent(s, { type: 'action_pending', action: { id: 'a1', summary: 'Archive 3', status: 'pending' } });
    s = reduceAgent(s, { type: 'delta', text: 'Done' });
    s = reduceAgent(s, { type: 'done', runId: 'r1', status: 'waiting', result: 'ok' });
    assert.equal(s.runId, 'r1');
    assert.equal(s.status, 'waiting');
    assert.deepEqual(s.items.map((i) => i.kind), ['text', 'tool', 'action', 'text']);
    assert.equal(s.items[0].text, 'Looking…');
    assert.equal(s.items[1].done, true);
    assert.equal(s.items[1].summary, '3 hits');
  });
  it('updates actions in place', () => {
    const items = [{ kind: 'action', action: { id: 'a1', status: 'pending' } }, { kind: 'text', text: 'x' }];
    const next = updateActionInItems(items, { id: 'a1', status: 'executed' });
    assert.equal(next[0].action.status, 'executed');
    assert.equal(next[1], items[1]);
  });
  it('rebuilds items from a stored run', () => {
    const run = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"summary":"2 results"}' },
        { role: 'assistant', content: 'Answer' },
      ],
    };
    const items = itemsFromRun(run, [{ id: 'a', status: 'pending' }]);
    assert.deepEqual(items.map((i) => i.kind), ['user', 'tool', 'text', 'action']);
    assert.equal(items[1].summary, '2 results');
  });
  it('prefers step summaries, turns status notes into notes, and does not repeat the result', () => {
    const run = {
      messages: [
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'search_mail', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"results":[1,2,3]}' },
        { role: 'assistant', content: 'Found it.' },
        { role: 'user', kind: 'action_update', content: '[Hedwig status update, not typed by the user] The user rejected it.' },
      ],
      steps: [{ n: 1, tool_calls: [{ id: 'c1', name: 'search_mail', ok: true, summary: '3 messages' }] }],
      result: 'Found it.',
    };
    const items = itemsFromRun(run);
    assert.deepEqual(items.map((i) => i.kind), ['user', 'tool', 'text', 'note']);
    assert.equal(items[1].summary, '3 messages');
    assert.equal(items[3].text, 'The user rejected it.');
  });
});

describe('schedules', () => {
  it('builds every kind', () => {
    assert.equal(buildSchedule({ kind: 'daily', time: '7:05' }), 'daily@07:05');
    assert.equal(buildSchedule({ kind: 'weekdays', time: '18:30' }), 'weekdays@18:30');
    assert.equal(buildSchedule({ kind: 'weekly', day: 1, time: '09:00' }), 'weekly@1@09:00');
    assert.equal(buildSchedule({ kind: 'every', every: 30, unit: 'm' }), 'every@30m');
    assert.equal(buildSchedule({ kind: 'every', every: 2, unit: 'h' }), 'every@2h');
  });
  it('rejects invalid input', () => {
    assert.equal(buildSchedule({ kind: 'daily', time: '25:00' }), null);
    assert.equal(buildSchedule({ kind: 'weekly', day: 7, time: '09:00' }), null);
    assert.equal(buildSchedule({ kind: 'every', every: 2, unit: 'm' }), null);
    assert.equal(buildSchedule({ kind: 'every', every: 0, unit: 'h' }), null);
    assert.equal(buildSchedule({ kind: 'cron' }), null);
  });
  it('round-trips and describes', () => {
    for (const s of ['daily@07:00', 'weekdays@08:15', 'weekly@0@10:00', 'every@15m', 'every@1h']) {
      assert.equal(buildSchedule(parseSchedule(s)), s);
    }
    assert.equal(describeSchedule('weekly@1@09:00'), 'Every Monday at 09:00');
    assert.equal(describeSchedule('every@1h'), 'Every 1 hour');
    assert.equal(parseSchedule('nonsense'), null);
    assert.match(describeSchedule('nonsense'), /Custom/);
  });
});

describe('time formatting', () => {
  const now = new Date(2026, 8, 23, 12, 0); // Wed 23 Sep 2026
  it('formatWhen', () => {
    assert.equal(formatWhen(new Date(2026, 8, 23, 9, 40), now), '09:40');
    assert.equal(formatWhen(new Date(2026, 8, 22, 9, 40), now), 'Yesterday');
    assert.equal(formatWhen(new Date(2026, 8, 20, 9, 40), now), 'Sun');
    assert.equal(formatWhen(new Date(2026, 5, 12), now), '12 Jun');
    assert.equal(formatWhen(new Date(2024, 5, 12), now), '12 Jun 2024');
    assert.equal(formatWhen('garbage', now), '');
  });
  it('formatAgo and dueLabel', () => {
    assert.equal(formatAgo(new Date(now.getTime() - 3 * 3600_000), now), '3 h ago');
    assert.equal(formatAgo(new Date(now.getTime() + 2 * 86_400_000), now), 'in 2 d');
    assert.equal(dueLabel(new Date(2026, 8, 30), now), 'due in 7 d');
    assert.equal(dueLabel(new Date(2026, 8, 20), now), 'overdue 3 d');
    assert.equal(dueLabel(new Date(2026, 8, 23, 20), now), 'due today');
  });
  it('hours and percents', () => {
    assert.equal(formatHours(0.5), '30 min');
    assert.equal(formatHours(3), '3 h');
    assert.equal(formatHours(72), '3 d');
    assert.equal(formatHours(null), '–');
    assert.equal(formatPercent(0.962, 1), '96.2%');
    assert.equal(formatPercent(42), '42%');
  });
});

describe('misc', () => {
  it('classifyError', () => {
    assert.equal(classifyError({ status: 404 }), 'missing');
    assert.equal(classifyError({ status: 503 }), 'off');
    assert.equal(classifyError({ status: 403 }), 'off');
    assert.equal(classifyError({ status: 429 }), 'budget');
    assert.equal(classifyError(new Error('daily model budget for ask reached (200)')), 'budget');
    assert.equal(classifyError(new Error('boom')), 'error');
    assert.equal(classifyError(null), null);
  });
  it('triageReason and stageLabel', () => {
    const t = { category: 'needs_you', reason_label: 'Deadline · 7 d', stage: 2, confidence: 0.941,
      reasons: [{ label: 'bulk', weight: 0.2, direction: 'against' }, { label: 'you owe form', weight: 0.9, direction: 'for' }] };
    assert.deepEqual(triageReason(t), { chip: 'Deadline · 7 d', why: 'you owe form' });
    assert.equal(stageLabel(t), '2 · 0.94');
    assert.equal(stageLabel({ stage: 1, confidence: 1 }), '1');
    assert.equal(triageReason({ category: 'waiting_on' }).chip, 'Waiting on');
  });
  it('initials', () => {
    assert.equal(initials('Priya Nair'), 'PN');
    assert.equal(initials('', 'thomas.reed@x.com'), 'TR');
    assert.equal(initials('GitHub'), 'GI');
    assert.equal(initials(''), '?');
  });
  it('followUps', () => {
    const f = followUps('Where are we on the visa, and what do I still owe?', { topicLabel: 'Visa' });
    assert.equal(f.length, 3);
    assert.ok(!f.some((s) => /owe/.test(s)));
  });
  it('groupFields orders known groups first', () => {
    const g = groupFields([{ key: 'x', group: 'zzz' }, { key: 'a', group: 'models' }, { key: 'b', group: 'general' }]);
    assert.deepEqual(g.map((x) => x.group), ['general', 'models', 'zzz']);
  });
  it('buildConfigPatch keeps only changed, valid keys', () => {
    const fields = [
      { key: 'n', type: 'number', value: 4, min: 1, max: 10 },
      { key: 'b', type: 'boolean', value: false },
      { key: 'j', type: 'json', value: [] },
      { key: 's', type: 'secret', value: '••••••••' },
      { key: 'e', type: 'enum', value: 'low' },
    ];
    const { patch, errors } = buildConfigPatch(fields, { n: '4', b: true, j: '[1', s: '••••••••', e: null });
    assert.deepEqual(patch, { b: true, e: null });
    assert.equal(errors.j, 'Not valid JSON');
    assert.equal(buildConfigPatch(fields, { n: '99' }).errors.n, 'Maximum 10');
  });
  it('isModelField', () => {
    assert.ok(isModelField({ key: 'llm.models.fast' }));
    assert.ok(isModelField({ key: 'embeddings.model' }));
    assert.ok(!isModelField({ key: 'llm.baseUrl' }));
  });
  it('chart helpers', () => {
    assert.equal(niceMax(7), 10);
    assert.equal(niceMax(180), 200);
    assert.equal(niceMax(0), 1);
    assert.equal(sparkPoints([1, 2, 3], 100, 20, 0), '0.0,20.0 50.0,10.0 100.0,0.0');
    assert.equal(sparkPoints([], 10, 10), '');
  });
  it('plugin helpers', () => {
    assert.equal(installSource('https://github.com/a/b.git'), 'git');
    assert.equal(installSource('/plugins/receipts'), 'dir');
    assert.equal(pluginMonogram('Receipts'), 'Rc');
    assert.equal(pluginMonogram('Send guard'), 'Sg');
    assert.equal(pluginMonogram('GTD'), 'Gt');
    assert.deepEqual(initialGrants([{ name: 'a' }, { name: 'b', optional: true }, { name: 'c', optional: true, granted: true }]), ['a', 'c']);
  });
  it('formatArgs', () => {
    assert.equal(formatArgs('{"q":"visa","limit":3}'), 'q: visa, limit: 3');
    assert.equal(formatArgs(''), '');
  });
});
