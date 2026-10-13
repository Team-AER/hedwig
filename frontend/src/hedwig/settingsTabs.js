// Every setting lives in one panel beside the reader (SettingsFrame.jsx): Hedwig's own pages and
// the mail settings upstream shows in its dialog (AdminPanel.jsx). In the Hedwig shell the dialog
// is not used; MailApp sends every way of opening it here. The nav is two rows: the groups, then
// the pages of the current group. Pure so node --test can pin it.

/** The view that shows one of upstream's dialog tabs; which one is the store's adminTab. */
export const MAIL_SETTINGS_VIEW = 'hedwig.settings.mail';

// `label` is the English, shown until the locale loads (tv).
const tab = (id, labelKey, label, flags = {}) => ({ key: `mail:${id}`, tab: id, labelKey, label, ...flags });
const view = (viewId, labelKey, label, flags = {}) => ({ key: viewId, viewId, labelKey, label, ...flags });

// The mail groups and tabs follow AdminPanel.jsx TAB_GROUPS and TABS, in the same order with the
// same flags (AccountForm.render.test.js checks). The dialog's ungrouped tab, About, ends the
// Hedwig group, which keeps the group row to one line in the panel.
export const SETTINGS_GROUPS = [
  { id: 'hedwig', labelKey: 'hedwig.settingsTabs.group', label: 'Hedwig', pages: [
    view('hedwig.settings.personal', 'hedwig.settingsTabs.personal', 'Personal'),
    view('hedwig.settings.triage', 'hedwig.settingsTabs.triage', 'Triage'),
    view('hedwig.settings.plugins', 'hedwig.settingsTabs.plugins', 'Hedwig plugins'),
    view('hedwig.settings.connectors', 'hedwig.settingsTabs.connectors', 'Connectors'),
    view('hedwig.settings.routing', 'hedwig.settingsTabs.routing', 'Models and routing', { adminOnly: true }),
    view('hedwig.settings.models', 'hedwig.settingsTabs.pipeline', 'Pipeline', { adminOnly: true }),
    // About is the app's version and licence; the dialog shows it below its groups.
    tab('about', 'admin.tabs.about', 'About'),
  ] },
  { id: 'account-mail', labelKey: 'admin.tabs.groupAccountMail', label: 'Account & Mail', pages: [
    tab('accounts', 'admin.tabs.accounts', 'Accounts'),
    tab('notifications', 'admin.tabs.notifications', 'Notifications'),
    tab('rules', 'admin.tabs.rules', 'Rules'),
    tab('categories', 'admin.tabs.categories', 'Categories'),
    tab('cleanup', 'admin.tabs.cleanup', 'Cleanup', { beta: true }),
    tab('antispam', 'admin.tabs.antispam', 'Antispam'),
  ] },
  { id: 'display', labelKey: 'admin.tabs.groupDisplay', label: 'Display', pages: [
    tab('appearance', 'admin.tabs.appearance', 'Appearance'),
    tab('shortcuts', 'admin.tabs.shortcuts', 'Shortcuts', { mobileHidden: true }),
  ] },
  { id: 'security-integrations', labelKey: 'admin.tabs.groupSecurityIntegrations', label: 'Security & Integrations', pages: [
    tab('security', 'admin.tabs.security', 'Security'),
    tab('integrations', 'admin.tabs.integrations', 'Integrations'),
    tab('ai', 'admin.tabs.ai', 'AI Assistant', { adminOnly: true }),
    tab('ai-actions', 'admin.tabs.aiActions', 'AI Actions'),
    tab('plugins', 'admin.tabs.plugins', 'Plugins', { beta: true }),
  ] },
  { id: 'admin', labelKey: 'admin.tabs.groupAdmin', label: 'Administration', pages: [
    tab('users', 'admin.tabs.users', 'Users', { adminOnly: true }),
    tab('sso', 'admin.tabs.sso', 'SSO', { adminOnly: true }),
  ] },
];

/** The groups this person sees: admin pages for admins, Shortcuts off phones, no empty group. */
export function visibleGroups({ isAdmin = false, phone = false } = {}) {
  return SETTINGS_GROUPS
    .map((g) => ({ ...g, pages: g.pages.filter((p) => (!p.adminOnly || isAdmin) && (!p.mobileHidden || !phone)) }))
    .filter((g) => g.pages.length);
}

/** The page key on screen: a Hedwig view id, or mail:<tab> for the mail settings view. */
export function activeKey(viewId, adminTab) {
  return viewId === MAIL_SETTINGS_VIEW ? `mail:${adminTab || 'accounts'}` : viewId;
}

/** The page for a key, or null. */
export function pageFor(key) {
  for (const g of SETTINGS_GROUPS) {
    const p = g.pages.find((x) => x.key === key);
    if (p) return p;
  }
  return null;
}

/** The group a page key belongs to, among those given. */
export function groupOf(key, groups = SETTINGS_GROUPS) {
  return groups.find((g) => g.pages.some((p) => p.key === key)) || null;
}

/** What opening a page does: { viewId, props, adminTab } (adminTab only for a mail tab). */
export function openTarget(page, { subTab = null } = {}) {
  if (!page) return null;
  if (page.viewId) return { viewId: page.viewId, props: {}, adminTab: null };
  return { viewId: MAIL_SETTINGS_VIEW, props: { subTab }, adminTab: page.tab };
}
