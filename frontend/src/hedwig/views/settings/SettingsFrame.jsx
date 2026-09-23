// Shared frame for Hedwig settings pages: title row plus a nav across the Hedwig settings views.
import { useHedwig } from '../../store.js';
import { useStore } from '../../../store/index.js';
import { useIsAdmin } from '../hooks.js';
import { T } from '../ui.jsx';
import { tr } from '../i18n.js';

const PAGES = [
  { id: 'hedwig.settings.personal', label: 'Personal' },
  { id: 'hedwig.settings.triage', label: 'Triage' },
  { id: 'hedwig.settings.plugins', label: 'Plugins' },
  { id: 'hedwig.settings.models', label: 'Models', admin: true },
];

export default function SettingsFrame({ active, title, sub, right, children, label }) {
  const openView = useHedwig((s) => s.openView);
  const isAdmin = useIsAdmin();
  const openMailSettings = () => { const st = useStore.getState(); st.setAdminTab?.('accounts'); st.setShowAdmin?.(true); };
  return (
    <section aria-label={label || title} style={{
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: '20px 28px 28px', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'transparent', color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      <nav aria-label={tr('settingsFrame.hedwigSettings', 'Hedwig settings')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 13 }}>
        {PAGES.filter((p) => !p.admin || isAdmin).map((p) => (
          <button key={p.id} type="button" aria-current={p.id === active ? 'page' : undefined} onClick={() => openView(p.id, {})} style={{
            padding: '5px 10px', borderRadius: 8, border: 0, font: 'inherit', cursor: 'pointer', color: T.ink,
            background: p.id === active ? T.surface : 'transparent', fontWeight: p.id === active ? 600 : 400,
            boxShadow: p.id === active ? `0 1px 0 ${T.border}` : 'none',
          }}>{p.label}</button>
        ))}
        <button type="button" onClick={openMailSettings} style={{ padding: '5px 10px', borderRadius: 8, border: 0, font: 'inherit', cursor: 'pointer', color: T.muted, background: 'transparent' }}>
          Mail settings…
        </button>
      </nav>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontFamily: T.display, fontSize: 40, fontWeight: 400, lineHeight: 1, letterSpacing: '-0.015em' }}>{title}</h1>
        {sub && <span style={{ fontSize: 12, color: T.muted }}>{sub}</span>}
        {right && <><span style={{ flexGrow: 1 }} />{right}</>}
      </div>
      {children}
    </section>
  );
}
