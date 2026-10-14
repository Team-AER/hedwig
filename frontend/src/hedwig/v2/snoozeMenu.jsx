// The snooze menus' items (the reader's toolbar, phone bar and More menu, a row's hover button):
// the three presets, then "Pick date & time…", whose panel asks for a date and a time in the same
// popover (shell/Menu.jsx panels). It opens on tomorrow at 08:00, and a moment already past
// cannot be picked.
import { useState } from 'react';
import { Icon } from '../icons.jsx';
import { snoozeTimes, customSnoozeStart, snoozeAt, dateValue } from './mail.js';
import { untilTime } from './format.js';
import { Btn, V } from './primitives.jsx';
import { tv } from './i18n.js';

/**
 * `onPick(until)` snoozes. `prefix` names the items inside a shared menu ("Snooze: Next week");
 * their ids are prefixed either way, so they never collide with that menu's own (Reply Later is
 * 'later' too).
 */
export function snoozeMenuItems(onPick, { prefix = null } = {}) {
  const name = (label) => (prefix ? `${prefix}: ${label}` : label);
  return [
    ...snoozeTimes().map((s) => ({ id: `snooze-${s.id}`, label: name(s.label), icon: 'alarm-clock', onSelect: () => onPick(s.until) })),
    ...(prefix ? [] : [{ type: 'separator' }]),
    {
      id: 'snooze-custom',
      label: name(tv('hedwig.v2.snooze.custom', 'Pick date & time…')),
      panelLabel: tv('hedwig.v2.snooze.pickTitle', 'Snooze until'),
      icon: 'calendar',
      panel: ({ close, back, sheet }) => <SnoozePicker sheet={sheet} onBack={back} onPick={(until) => { close(); onPick(until); }} />,
    },
  ];
}

export function SnoozePicker({ onPick, onBack, sheet = false, now }) {
  const [start] = useState(() => customSnoozeStart(now));
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const until = snoozeAt(date, time);
  const future = Boolean(until) && until.getTime() > Date.now();
  const submit = (e) => {
    e.preventDefault();
    if (future) onPick(until);
  };
  const field = {
    width: '100%', height: sheet ? 44 : 30, boxSizing: 'border-box', padding: '0 10px',
    border: `1px solid ${V.line2}`, borderRadius: 8, background: V.field, color: V.ink,
    fontFamily: 'inherit', fontSize: sheet ? 15 : 13, colorScheme: 'light dark',
  };
  const backLabel = tv('hedwig.v2.thread.back', 'Back');
  return (
    <form data-snooze-picker="" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: sheet ? '4px 12px 8px' : '0 3px 3px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28 }}>
        <button
          type="button"
          className="hw-icon-btn"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
          style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: V.muted, cursor: 'pointer', flexShrink: 0 }}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{tv('hedwig.v2.snooze.pickTitle', 'Snooze until')}</span>
      </div>
      <input
        type="date"
        data-autofocus=""
        aria-label={tv('hedwig.v2.snooze.date', 'Date')}
        value={date}
        min={dateValue(new Date())}
        required
        onChange={(e) => setDate(e.target.value)}
        style={field}
      />
      <input
        type="time"
        aria-label={tv('hedwig.v2.snooze.time', 'Time')}
        value={time}
        required
        onChange={(e) => setTime(e.target.value)}
        style={field}
      />
      <div data-snooze-when="" aria-live="polite" style={{ minHeight: 16, fontSize: 12, lineHeight: '16px', color: until && !future ? V.red : V.muted, fontVariantNumeric: 'tabular-nums' }}>
        {until && (future ? untilTime(until) : tv('hedwig.v2.snooze.past', 'That time has already passed.'))}
      </div>
      <Btn type="submit" accent size={sheet ? 'phone' : 'md'} disabled={!future} style={{ width: '100%', opacity: future ? 1 : 0.5, cursor: future ? 'pointer' : 'default' }}>
        {tv('hedwig.v2.thread.snooze', 'Snooze')}
      </Btn>
    </form>
  );
}
