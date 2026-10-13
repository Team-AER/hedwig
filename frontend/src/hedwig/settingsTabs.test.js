// node --test src/hedwig/settingsTabs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEDWIG_SETTINGS_TABS, settingsTabFor, settingsViewFor } from './settingsTabs.js';

test('every Hedwig settings view has a dialog tab and back', () => {
  for (const t of HEDWIG_SETTINGS_TABS) {
    assert.equal(settingsTabFor(t.viewId), t.id);
    assert.equal(settingsViewFor(t.id), t.viewId);
  }
  assert.equal(settingsTabFor('hedwig.settings.models'), 'hedwig-pipeline');
});

test('other views and tabs are left alone', () => {
  assert.equal(settingsTabFor('hedwig.thread'), null);
  assert.equal(settingsTabFor(undefined), null);
  assert.equal(settingsViewFor('accounts'), null);
});

test('models and the pipeline are admin pages', () => {
  assert.deepEqual(HEDWIG_SETTINGS_TABS.filter((t) => t.adminOnly).map((t) => t.id), ['hedwig-routing', 'hedwig-pipeline']);
});
