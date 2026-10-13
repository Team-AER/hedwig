// node --test src/hedwig/settingsTabs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_SETTINGS_VIEW, SETTINGS_GROUPS, activeKey, groupOf, openTarget, pageFor, visibleGroups } from './settingsTabs.js';

const ids = (groups) => groups.map((g) => `${g.id}: ${g.pages.map((p) => p.key).join(' ')}`);

test('an admin on a computer sees every group and page, Hedwig first', () => {
  const groups = visibleGroups({ isAdmin: true, phone: false });
  assert.deepEqual(groups.map((g) => g.id), ['hedwig', 'account-mail', 'display', 'security-integrations', 'admin']);
  assert.equal(groups[0].pages.length, 7);
  assert.equal(groups[0].pages.at(-1).key, 'mail:about');
  assert.ok(groups.find((g) => g.id === 'display').pages.some((p) => p.tab === 'shortcuts'));
});

test('someone else loses the admin pages, and the Administration group with them; phones lose Shortcuts', () => {
  const groups = visibleGroups({ isAdmin: false, phone: true });
  assert.deepEqual(ids(groups), [
    'hedwig: hedwig.settings.personal hedwig.settings.triage hedwig.settings.plugins hedwig.settings.connectors mail:about',
    'account-mail: mail:accounts mail:notifications mail:rules mail:categories mail:cleanup mail:antispam',
    'display: mail:appearance',
    'security-integrations: mail:security mail:integrations mail:ai-actions mail:plugins',
  ]);
});

test('the page on screen: a Hedwig view by its id, a mail page by the adminTab', () => {
  assert.equal(activeKey('hedwig.settings.routing', 'accounts'), 'hedwig.settings.routing');
  assert.equal(activeKey(MAIL_SETTINGS_VIEW, 'ai'), 'mail:ai');
  assert.equal(activeKey(MAIL_SETTINGS_VIEW, null), 'mail:accounts');
  assert.equal(groupOf('mail:ai').id, 'security-integrations');
  assert.equal(groupOf('hedwig.settings.models').id, 'hedwig');
  assert.equal(groupOf('nope'), null);
});

test('opening a page: Hedwig pages are views, mail pages set the tab and open the mail view', () => {
  assert.deepEqual(openTarget(pageFor('hedwig.settings.personal')), { viewId: 'hedwig.settings.personal', props: {}, adminTab: null });
  assert.deepEqual(openTarget(pageFor('mail:rules'), { subTab: 'block-list' }), { viewId: MAIL_SETTINGS_VIEW, props: { subTab: 'block-list' }, adminTab: 'rules' });
  assert.deepEqual(openTarget(pageFor('mail:accounts')).props, { subTab: null }, 'a plain open clears a sub-tab left from before');
  assert.equal(openTarget(null), null);
});

test('every page has a key, a locale key and English, and keys are unique', () => {
  const pages = SETTINGS_GROUPS.flatMap((g) => g.pages);
  assert.equal(new Set(pages.map((p) => p.key)).size, pages.length);
  for (const p of [...pages, ...SETTINGS_GROUPS]) assert.ok(p.labelKey && p.label, JSON.stringify(p));
});
