// The quiet tier note: GET /status `tiers.notice` ("Tier 2 is slow; using the lighter model", or
// Tier 1 not answering) as one 11px muted line behind a bolt glyph, in the rail or top bar, Ask and
// the Brief; the detail is its title. Nothing shows while both tiers are fine. `LighterLabel` marks
// one output the lighter model produced. No italic, no serif (DESIGN-AUDIT-2026-09-24 §a).
import { useHedwig } from '../store.js';
import { tierNotice } from './tiers.js';
import { V } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { tv } from './i18n.js';

// Old call sites pass `size`; it is ignored, the note is always 11px.
export function TierNote({ style }) {
  const status = useHedwig((s) => s.status);
  const notice = tierNotice(status);
  if (!notice) return null;
  return (
    <span
      role="status"
      data-tier-note=""
      data-level={notice.level}
      title={notice.detail || notice.text}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%',
        fontFamily: V.sans, fontStyle: 'normal', fontSize: 11, lineHeight: '14px', fontWeight: 400,
        color: notice.level === 'error' ? V.attentionInk : V.muted, ...style,
      }}
    >
      <Icon name="bolt" size={12} strokeWidth={1.75} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notice.text}</span>
    </span>
  );
}

// Old call sites pass `size`; it is ignored, the label is always 11px.
export function LighterLabel({ what = 'answer', style }) {
  const text = what === 'story'
    ? tv('hedwig.v2.tier.lighterStory', 'Written by the lighter model')
    : tv('hedwig.v2.tier.lighterAnswer', 'Answered by the lighter model');
  return (
    <span data-lighter="" style={{ fontFamily: V.sans, fontStyle: 'normal', fontSize: 11, lineHeight: '14px', color: V.muted, ...style }}>
      {text}
    </span>
  );
}
