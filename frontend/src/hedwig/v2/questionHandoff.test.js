import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { questionHandoff } from './questionHandoff.js';

function fixture({ reduced = false, unavailable = false, throws = false } = {}) {
  const dom = new JSDOM('<div id="question" style="visibility:visible">Question</div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  const target = document.getElementById('question');
  target.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 40 });
  const listeners = new Set();
  const media = { matches: reduced, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  let cancelCount = 0;
  if (!unavailable) dom.window.Element.prototype.animate = () => {
    if (throws) throw new Error('Animation unavailable');
    let reject;
    const finished = new Promise((_, no) => { reject = no; });
    return { finished, cancel: () => { cancelCount++; reject(new Error('cancelled')); } };
  };
  return { target, media, listeners, cancellations: () => cancelCount, origin: { left: 10, top: 20, width: 150, height: 44 } };
}

test('initial reduced motion and unavailable animation retain the real question', () => {
  for (const flags of [{ reduced: true }, { unavailable: true }, { throws: true }]) {
    const f = fixture(flags);
    questionHandoff(f.target, f.origin, f.media)();
    assert.equal(f.target.style.visibility, 'visible');
    assert.equal(document.querySelectorAll('.hw-question-flight').length, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('live reduced motion settles immediately and removes listeners and cosmetic clones', async () => {
  const f = fixture();
  const cancel = questionHandoff(f.target, f.origin, f.media);
  assert.equal(document.querySelectorAll('.hw-question-flight').length, 1);
  assert.equal(f.target.style.visibility, 'hidden');
  for (const changed of f.listeners) changed({ matches: true });
  assert.equal(f.target.style.visibility, 'visible');
  assert.equal(document.querySelectorAll('.hw-question-flight').length, 0);
  assert.equal(f.listeners.size, 0);
  cancel();
  await Promise.resolve();
  assert.equal(f.target.textContent, 'Question');
});

test('navigation/reversal cleanup is safe when invoked repeatedly', async () => {
  const f = fixture();
  const cancel = questionHandoff(f.target, f.origin, f.media);
  cancel(); cancel();
  await Promise.resolve();
  assert.equal(f.target.style.visibility, 'visible');
  assert.equal(document.querySelectorAll('.hw-question-flight').length, 0);
  assert.equal(f.listeners.size, 0);
});
