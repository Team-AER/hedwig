// Shared frame for Hedwig settings pages: title row plus a nav across the Hedwig settings views.
import { useHedwig } from '../../store.js';
import { useStore } from '../../../store/index.js';
import { useIsAdmin } from '../hooks.js';
import { T } from '../ui.jsx';
import { tr } from '../i18n.js';
import { usePhone } from '../../v2/primitives.jsx';

const PAGES = [
  { id: 'hedwig.settings.personal', label: 'Personal' },
  { id: 'hedwig.settings.triage', label: 'Triage' },
  { id: 'hedwig.settings.plugins', label: 'Plugins' },
  { id: 'hedwig.settings.routing', label: 'Models and routing', admin: true },
  { id: 'hedwig.settings.models', label: 'Pipeline', admin: true },
];

export default function SettingsFrame({ active, title, sub, right, children, label }) {
  const openView = useHedwig((s) => s.openView);
  const isAdmin = useIsAdmin();
  const phone = usePhone();
  const openMailSettings = () => { const st = useStore.getState(); st.setAdminTab?.('accounts'); st.setShowAdmin?.(true); };
  return (
    <section aria-label={label || title} style={{
      // On a phone the floating tab bar covers the bottom: the last setting scrolls clear of it.
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: phone ? '16px 16px calc(24px + var(--hw-tabbar-space, 0px))' : '20px 28px calc(28px + var(--hw-tabbar-space, 0px))', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'transparent', color: T.ink, fontFamily: T.body, fontSize: 13, lineHeight: 1.45,
    }}>
      <nav aria-label={tr('settingsFrame.hedwigSettings', 'Hedwig settings')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 13 }}>
        {PAGES.filter((p) => !p.admin || isAdmin).map((p) => (
          <button key={p.id} type="button" aria-current={p.id === active ? 'page' : undefined} onClick={() => openView(p.id, {})} style={{
            minHeight: phone ? 44 : 28, padding: '0 10px', borderRadius: 6, border: 0, font: 'inherit', cursor: 'pointer', color: T.ink,
            background: p.id === active ? 'var(--hw-select, rgba(0,0,0,0.07))' : 'transparent', fontWeight: p.id === active ? 600 : 400,
          }}>{p.label}</button>
        ))}
        <button type="button" onClick={openMailSettings} style={{ minHeight: phone ? 44 : 28, padding: '0 10px', borderRadius: 6, border: 0, font: 'inherit', cursor: 'pointer', color: T.muted, background: 'transparent' }}>
          Mail settings…
        </button>
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
