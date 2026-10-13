// node --test src/hedwig/aiModels.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelOptions, modelIsUsable } from './aiModels.js';

const MODELS = [
  { id: 'deepseek', label: 'deepseek', status: 'ready', available: true },
  { id: 'kimi-k3', label: 'Kimi K3', status: 'ready', available: true },
  { id: 'qwen-next', label: 'Qwen Next', status: 'offline', available: false },
];

test('lists the models, names them, and greys out offline ones', () => {
  assert.deepEqual(modelOptions(MODELS, 'kimi-k3'), [
    { value: 'deepseek', label: 'deepseek', disabled: false },
    { value: 'kimi-k3', label: 'Kimi K3 (kimi-k3)', disabled: false },
    { value: 'qwen-next', label: 'Qwen Next (qwen-next) · offline', disabled: true },
  ]);
});

test('keeps the saved model selectable when it is offline, so the page does not change it', () => {
  const qwen = modelOptions(MODELS, 'qwen-next').find((o) => o.value === 'qwen-next');
  assert.equal(qwen.disabled, false);
  assert.equal(qwen.label, 'Qwen Next (qwen-next) · offline');
});

test('puts a saved model the server no longer lists at the top, marked', () => {
  const opts = modelOptions(MODELS, 'Qwen/Qwen3.8-Flash-Next', { missingLabel: 'gone' });
  assert.deepEqual(opts[0], { value: 'Qwen/Qwen3.8-Flash-Next', label: 'Qwen/Qwen3.8-Flash-Next · gone', disabled: false });
  assert.equal(opts.length, 4);
});

test('modelIsUsable', () => {
  assert.equal(modelIsUsable(MODELS, 'deepseek'), true);
  assert.equal(modelIsUsable(MODELS, 'qwen-next'), false);
  assert.equal(modelIsUsable(MODELS, 'nope'), false);
  assert.equal(modelIsUsable(null, 'deepseek'), false);
});
