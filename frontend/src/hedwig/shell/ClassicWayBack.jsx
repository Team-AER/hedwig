// The way back from the classic MailFlow shell: one quiet line under the sidebar header (a small
// owl button when the sidebar is collapsed). The classic shell shows none of Hedwig's streams,
// reasons, summaries or Brief, so it must never be a place the user cannot see how to leave.
// Renders nothing in the Hedwig shell. Sidebar.jsx mounts it (one line, marked as a Hedwig hook).
import { useHedwig } from '../store.js';
import { useMobile } from '../../hooks/useMobile.js';
import { OwlMark } from '../icons.jsx';
import { tr } from './tr.js';

export default function ClassicWayBack({ collapsed = false }) {
  const classic = useHedwig((s) => s.shellMode === 'classic');
  const phone = useMobile();
  if (!classic) return null;
  const label = tr('classic.back', 'Switch to the Hedwig layout');
  const go = () => useHedwig.getState().setShellMode('hedwig');
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={go}
        aria-label={label}
        title={label}
        data-hedwig-way-back=""
        className="btn-press"
        style={{
          margin: '8px auto 0', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 0, borderRadius: 8, background: 'var(--hw-accent-tint, transparent)', color: 'var(--hw-accent-ink, var(--accent))', cursor: 'pointer', padding: 0,
        }}
      >
        <OwlMark size={18} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={go}
      aria-label={label}
      data-hedwig-way-back=""
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', minHeight: phone ? 44 : 36,
        padding: '8px 14px', border: 0, borderBottom: '1px solid var(--hw-line, var(--border-subtle))', background: 'transparent',
        color: 'var(--text-secondary, var(--hw-muted))', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: 'var(--hw-font-why, var(--hw-font-display, Georgia, serif))', fontStyle: 'italic', fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
        {tr('classic.here', 'Classic layout')}
      </span>
      <span style={{ flexGrow: 1 }} />
      <span className="hw-link" style={{ fontWeight: 500, color: 'var(--hw-accent-ink, var(--accent))', whiteSpace: 'nowrap' }}>
        {tr('classic.hedwig', 'Hedwig layout')}
      </span>
    </button>
  );
}
