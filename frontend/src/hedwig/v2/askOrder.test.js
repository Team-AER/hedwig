// node --test src/hedwig/v2/askOrder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder, distinctQuestions, reduceAsk2, askStarted, fromSaved } from './ask.js';

const sources = Array.from({ length: 46 }, (_, i) => ({ n: i + 1, message: { id: `m${i + 1}` } }));

test('citations are renumbered 1, 2… in the order the answer first cites them', () => {
  const ro = readingOrder('- September: Rs. 6195.63 [44]\n- October: Rs. 12493.75 [4]\n\nTotal: Rs. 18689.38 [4][44]', sources);
  assert.equal(ro.text, '- September: Rs. 6195.63 [1]\n- October: Rs. 12493.75 [2]\n\nTotal: Rs. 18689.38 [2, 1]');
  assert.deepEqual(ro.sources.slice(0, 3).map((s) => [s.n, s.source, s.cited]), [[1, 44, true], [2, 4, true], [3, 1, false]]);
  assert.equal(ro.sources.length, 46, 'the uncited ones follow');
  assert.equal(ro.toSource(1), 44);
  assert.equal(ro.toSource(3), 1);
});

test('lists inside one marker, repeats and unknown numbers', () => {
  const ro = readingOrder('a [3, 2] b [3] c [99]', sources.slice(0, 3));
  assert.equal(ro.text, 'a [1, 2] b [1] c [99]');
  assert.deepEqual(ro.sources.map((s) => s.source), [3, 2, 1]);
});

test('no answer yet, or nothing cited: the sources keep their order', () => {
  assert.deepEqual(readingOrder('', sources.slice(0, 2)).sources.map((s) => [s.n, s.source, s.cited]), [[1, 1, false], [2, 2, false]]);
  assert.equal(readingOrder('Plain text, [not a cite].', []).text, 'Plain text, [not a cite].');
});

test('earlier questions show each question once: the newest, or the copy on screen', () => {
  const h = [
    { id: 'c', question: 'find out all the AI expenses my team has mailed to me' },
    { id: 'f', question: 'give me a breakup per employee' },
    { id: 'b', question: 'Find out all the AI expenses my team has  mailed to me' },
    { id: 'a', question: 'find out all the AI expenses my team has mailed to me' },
  ];
  assert.deepEqual(distinctQuestions(h).map((e) => e.id), ['c', 'f']);
  assert.deepEqual(distinctQuestions(h, 'a').map((e) => e.id), ['f', 'a']);
  assert.deepEqual(distinctQuestions(null), []);
});

test('the searches Ask runs, and runs again in its own words, are kept as they stream and when saved', () => {
  let st = askStarted('find out all the AI expenses my team has mailed to me');
  for (const ev of [
    { type: 'search', text: 'AI expenses', found: 40, round: 0 },
    { type: 'search', text: 'AI subscription reimbursement', found: 3, round: 1 },
    { type: 'search', text: '' },
    { type: 'sources', sources: [], askLogId: 'a1' },
  ]) st = reduceAsk2(st, ev);
  assert.deepEqual(st.searches, [{ text: 'AI expenses', found: 40, round: 0 }, { text: 'AI subscription reimbursement', found: 3, round: 1 }]);
  assert.equal(st.status, 'streaming');
  const saved = fromSaved({ id: 'a1', question: 'q', status: 'done', answer: 'a', plan: { searches: [{ text: 'AI expenses', found: 40 }, { text: 'Claude subscription', found: 1 }] } });
  assert.deepEqual(saved.searches, [{ text: 'AI expenses', found: 40, round: 0 }, { text: 'Claude subscription', found: 1, round: 1 }]);
  assert.deepEqual(fromSaved({ id: 'a2', question: 'q', status: 'done', answer: 'a' }).searches, []);
});

test('the progress steps follow the events: running, then done, stopped on an error', () => {
  let st = askStarted('find out all the AI expenses my team has mailed to me', { now: 1000 });
  const kinds = () => st.steps.map((x) => `${x.kind}:${x.status}`);
  st = reduceAsk2(st, { type: 'plan', status: 'running' });
  assert.deepEqual(kinds(), ['plan:running']);
  st = reduceAsk2(st, { type: 'plan', status: 'done', text: 'AI expenses' });
  st = reduceAsk2(st, { type: 'search', text: 'AI expenses', round: 0, status: 'running' });
  st = reduceAsk2(st, { type: 'search', text: 'AI expenses', round: 0, status: 'done', found: 46 });
  st = reduceAsk2(st, { type: 'review', round: 1, status: 'running' });
  st = reduceAsk2(st, { type: 'review', round: 1, status: 'done', enough: false, searches: ['AI subscription reimbursement'] });
  st = reduceAsk2(st, { type: 'search', text: 'AI subscription reimbursement', round: 1, status: 'running' });
  assert.deepEqual(kinds(), ['plan:done', 'search:done', 'review:done', 'search:running']);
  assert.equal(st.steps[0].text, 'AI expenses');
  assert.equal(st.steps[1].found, 46);
  assert.deepEqual(st.searches.map((x) => x.text), ['AI expenses'], 'searches lists the finished ones');
  st = reduceAsk2(st, { type: 'search', text: 'AI subscription reimbursement', round: 1, status: 'done', found: 3 });
  st = reduceAsk2(st, { type: 'sources', sources: [{ n: 1, message: { id: 'm1' } }, { n: 2, message: { id: 'm2' } }], askLogId: 'a1' });
  st = reduceAsk2(st, { type: 'delta', text: 'Two' });
  st = reduceAsk2(st, { type: 'delta', text: ' mails.' });
  assert.deepEqual(kinds().slice(-2), ['read:done', 'write:running']);
  assert.equal(st.steps.find((x) => x.kind === 'read').count, 2);
  const done = reduceAsk2(st, { type: 'done', answer: 'Two mails.', at: 18000 });
  assert.ok(done.steps.every((x) => x.status === 'done'));
  assert.equal(done.finishedAt - done.startedAt, 17000);
  const failed = reduceAsk2(st, { type: 'error', error: 'boom' });
  assert.equal(failed.steps.at(-1).status, 'stopped');
});
