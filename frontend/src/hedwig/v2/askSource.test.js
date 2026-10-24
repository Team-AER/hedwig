import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/store/index.js')) return { format: 'module', shortCircuit: true, source: 'let state={user:null};export const useStore={getState:()=>state,setState:s=>{state={...state,...s}}};' };
  return next(url, context);
} });
const { useStore } = await import('../../store/index.js');
const { askSource, rememberAskSource, rememberCitation, takeCitation, sourceMotion } = await import('./askSource.js');

test('an excerpt remains scoped to its thread and authenticated reader', () => {
  useStore.setState({ user: { id: 1 } });
  rememberAskSource('a', { quote: 'Actual excerpt' }, null);
  assert.equal(askSource('a').source.quote, 'Actual excerpt');
  assert.equal(askSource('b'), null);
  useStore.setState({ user: { id: 2 } });
  assert.equal(askSource('a'), null);
  useStore.setState({ user: null });
  assert.equal(askSource('a'), null);
});

test('source connectors cancel on preference change and preserve real content under API failure', async () => {
  const dom = new JSDOM('<button>Source</button>');
  globalThis.document = dom.window.document;
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const listeners = new Set();
  globalThis.matchMedia = () => ({ matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) });
  dom.window.Element.prototype.animate = () => ({ finished: new Promise(() => {}), cancel() {} });
  const target = document.querySelector('button');
  target.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 44 });
  const cancel = sourceMotion(target, { left: 10, top: 20, width: 20, height: 20 }, { link: true });
  assert.equal(document.querySelectorAll('.hw-source-connector').length, 1);
  for (const fn of [...listeners]) fn({ matches: true });
  assert.equal(document.querySelectorAll('.hw-source-connector').length, 0);
  assert.equal(listeners.size, 0);
  cancel();
  dom.window.Element.prototype.animate = () => { throw new Error('Unavailable'); };
  sourceMotion(target, null)();
  assert.equal(target.textContent, 'Source');
});


test('a citation handoff is consumed only by its matching authenticated destination', () => {
  useStore.setState({ user: { id: 1 } });
  const rect = { left: 4, top: 8, width: 20, height: 20 };
  rememberCitation({ id: 'message-a', thread_key: 'thread-a' }, rect);
  assert.equal(takeCitation({ messageId: 'message-b', threadId: 'thread-b' }), null);
  assert.equal(takeCitation({ messageId: 'message-a', threadId: 'thread-a' }), rect);
  assert.equal(takeCitation({ messageId: 'message-a', threadId: 'thread-a' }), null);
  rememberCitation({ id: 'message-a', thread_key: 'thread-a' }, rect);
  useStore.setState({ user: { id: 2 } });
  assert.equal(takeCitation({ threadId: 'thread-a' }), null);
});
