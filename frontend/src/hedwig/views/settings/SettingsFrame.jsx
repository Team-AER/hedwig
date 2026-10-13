// Shared frame for the settings pages in the panel beside the reader: the nav, then a title row.
// The nav is two rows (settingsTabs.js): the groups (Hedwig, Account & Mail, Display, …), then the
// pages of the current group. Hedwig's pages are views of their own; the mail pages are one view
// (MailSettings.jsx) showing the store's adminTab.
import { useHedwig } from '../../store.js';
import { useStore } from '../../../store/index.js';
import { useMobile } from '../../../hooks/useMobile.js';
import { useIsAdmin } from '../hooks.js';
import { T } from '../ui.jsx';
import { tv } from '../../v2/i18n.js';
import { usePhone } from '../../v2/primitives.jsx';
import { activeKey, groupOf, openTarget, visibleGroups } from '../../settingsTabs.js';

/** Open a settings page (a settingsTabs.js page) in the panel. */
export function openSettingsPage(page, { subTab = null } = {}) {
  const target = openTarget(page, { subTab });
  if (!target) return;
  if (target.adminTab) useStore.getState().setAdminTab?.(target.adminTab);
  useHedwig.getState().openView(target.viewId, target.props);
}

const label = (item) => tv(item.labelKey, item.label);

export default function SettingsFrame({ active, title, sub, right, children, label: ariaLabel }) {
  const isAdmin = useIsAdmin();
  const phone = usePhone();
  const mobile = useMobile();
  const adminTab = useStore((s) => s.adminTab);
  const groups = visibleGroups({ isAdmin, phone: mobile });
  const current = activeKey(active, adminTab);
  const group = groupOf(current, groups);
  const row = { display: 'flex', gap: 2, fontSize: 13, ...(phone ? { overflowX: 'auto', scrollbarWidth: 'none' } : { flexWrap: 'wrap' }) };
  const button = (on, small) => ({
    minHeight: phone ? 44 : (small ? 26 : 28), padding: small ? '0 8px' : '0 7px', borderRadius: 6, border: 0, font: 'inherit',
    fontSize: small ? 12.5 : 13, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
    color: on || !small ? T.ink : T.muted,
    background: on ? 'var(--hw-select, rgba(0,0,0,0.07))' : 'transparent',
    // The group row keeps one weight, so picking a group never re-wraps the row.
    fontWeight: small ? (on ? 600 : 400) : 500,
  });
  return (
    <section aria-label={ariaLabel || title} style={{
      // On a phone the floating tab bar covers the bottom: the last setting scrolls clear of it.
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: phone ? '16px 16px calc(24px + var(--hw-tabbar-space, 0px))' : '20px 28px calc(28px + var(--hw-tabbar-space, 0px))', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'transparent', color: T.ink, fontFamily: T.body, fontSize: 13, lineHeight: 1.45,
    }}>
      <nav aria-label={tv('admin.title', 'Settings')} data-settings-nav="" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div data-settings-groups="" style={row}>
          {groups.map((g) => (
            <button key={g.id} type="button" aria-current={g === group ? 'true' : undefined} onClick={() => openSettingsPage(g.pages[0])} style={button(g === group, false)}>
              {label(g)}
            </button>
          ))}
        </div>
        {group && group.pages.length > 1 && (
          <div data-settings-pages="" style={{ ...row, paddingTop: 6, borderTop: '1px solid var(--hw-line, rgba(0,0,0,0.08))' }}>
            {group.pages.map((p) => (
              <button key={p.key} type="button" aria-current={p.key === current ? 'page' : undefined} onClick={() => openSettingsPage(p)} style={button(p.key === current, true)}>
                {label(p)}
                {p.beta && <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--hw-accent, var(--accent))' }}>BETA</span>}
              </button>
            ))}
          </div>
        )}
      </nav>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontFamily: T.display, fontSize: phone ? 28 : 22, fontWeight: phone ? 700 : 600, lineHeight: 1.2, letterSpacing: '-0.01em' }}>{title}</h1>
        {sub && <span style={{ fontSize: 12, color: T.muted }}>{sub}</span>}
        {right && <><span style={{ flexGrow: 1 }} />{right}</>}
      </div>
      {children}
    </section>
  );
}
