// A stream row, as in the People mockup: unread dot, sender, time; subject; and, for what needs
// you (or was rescued from spam, or waits in the Screener), the italic reason line that opens the
// why door. Other rows keep the door behind a quiet "why" that shows on hover and keyboard focus
// (on a phone, the thread's Change does it). The row's main area is one real button (Enter opens
// the thread); the reason is a second button, not nested in the first. A reminder row (synthetic,
// no message) has nothing to open or explain.
import { useV2 } from './state.js';
import { Mono, V, Why } from './primitives.jsx';
import { listTime, senderName } from './format.js';
import { tv } from './i18n.js';

/** Rows that say why they are here in the list itself. */
export function showsReason(item) {
  return Boolean(item?.reason) && Boolean(item.needsYou || item.spam === 'rescued' || item.held || item.rescued);
}

export function StreamRow({ item, onOpen, onWhy, phone = false, stream }) {
  const selected = useV2((s) => Boolean(item.messageId) && s.selected?.messageId === item.messageId);
  const synthetic = Boolean(item.synthetic || !item.messageId);
  const strong = item.needsYou || item.unread;
  const name = senderName(item.from) || tv('hedwig.v2.row.unknownSender', 'Unknown sender');
  const subject = item.subject || tv('hedwig.v2.row.noSubject', '(no subject)');
  const openWhy = onWhy && !synthetic ? (el) => onWhy({ ...item, stream: item.stream || stream }, el) : undefined;
  const reasonLine = showsReason(item) || (synthetic && item.reason);
  const quietWhy = Boolean(openWhy) && !reasonLine && !phone;
  return (
    <article
      className="hw-row"
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      style={{
        borderRadius: phone ? 14 : 12, background: selected ? V.tint : undefined,
        padding: phone ? '14px 12px' : '14px 12px', display: 'flex', flexDirection: 'column', position: 'relative',
      }}
    >
      <button
        type="button"
        data-row-button=""
        onClick={synthetic ? undefined : () => onOpen(item)}
        aria-disabled={synthetic ? 'true' : undefined}
        aria-label={`${name}: ${subject}${item.unread ? `, ${tv('hedwig.v2.row.unread', 'unread')}` : ''}`}
        style={{
          display: 'grid', gridTemplateColumns: `${phone ? 12 : 14}px minmax(0, 1fr) auto`, columnGap: 10, alignItems: 'baseline',
          width: '100%', padding: 0, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: synthetic ? 'default' : 'pointer',
          minHeight: phone ? 44 : undefined,
        }}
      >
        <span aria-hidden="true" style={{ alignSelf: 'center', width: 7, height: 7, borderRadius: '50%', background: item.unread || item.needsYou ? V.accent : 'transparent' }} />
        <span style={{ fontSize: phone ? 16 : 15, fontWeight: strong ? 600 : 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <Mono>{listTime(item.date)}</Mono>
        <span />
        <span style={{
          gridColumn: '2 / 4', paddingTop: 3, fontSize: phone ? 15 : 14, color: item.needsYou ? V.ink : V.muted,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: quietWhy ? 40 : 0,
        }}
        >
          {subject}
        </span>
      </button>
      {reasonLine && (
        <div style={{ paddingLeft: phone ? 22 : 24, paddingTop: 4 }}>
          <Why
            tone={item.needsYou ? 'accent' : 'muted'}
            hit={phone}
            onOpen={openWhy}
            label={openWhy ? tv('hedwig.v2.row.whyLabel', 'Why: {{reason}}. Open to see or change', { reason: item.reason }) : undefined}
          >
            {item.reason}
          </Why>
        </div>
      )}
      {quietWhy && (
        <button
          type="button"
          className="hw-row-why hw-why-door"
          aria-haspopup="dialog"
          aria-label={item.reason
            ? tv('hedwig.v2.row.whyLabel', 'Why: {{reason}}. Open to see or change', { reason: item.reason })
            : tv('hedwig.v2.row.whyQuiet', 'Why is this here? Open to see or change')}
          onClick={(e) => openWhy(e.currentTarget)}
          style={{ position: 'absolute', right: 12, bottom: 12, padding: '2px 4px', border: 0, background: 'none', cursor: 'pointer', fontFamily: V.why, fontStyle: 'italic', fontSize: 15, lineHeight: 1.2, color: V.muted }}
        >
          {tv('hedwig.v2.row.why', 'why')}
        </button>
      )}
    </article>
  );
}

/** Arrow keys (and j / k) move between the row buttons of a list. */
export function onListKeyDown(e) {
  const t = e.target;
  if (!t?.hasAttribute?.('data-row-button')) return;
  const down = e.key === 'ArrowDown' || e.key === 'j';
  const up = e.key === 'ArrowUp' || e.key === 'k';
  if (!down && !up) return;
  const all = [...e.currentTarget.querySelectorAll('[data-row-button]')];
  const i = all.indexOf(t);
  const next = all[i + (down ? 1 : -1)];
  if (next) { e.preventDefault(); next.focus(); }
}

export function GroupLabel({ children, tone = 'muted', first = false, phone = false }) {
  return (
    <Why as="h2" tone={tone} style={{ margin: 0, padding: `${first ? 4 : 22}px ${phone ? 4 : 12}px 6px`, fontSize: 16 }}>
      {children}
    </Why>
  );
}
