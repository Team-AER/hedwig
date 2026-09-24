// The quiet tier note: GET /status `tiers.notice` ("Tier 2 is slow; using the lighter model", or
// Tier 1 not answering) in one italic line in the rail or top bar, Ask and the Brief; the detail
// is its title. Nothing shows while both tiers are fine. `LighterLabel` marks one output the lighter model produced.
import { useHedwig } from '../store.js';
import { tierNotice } from './tiers.js';
import { V } from './primitives.jsx';
import { tv } from './i18n.js';

export function TierNote({ size = 14, style }) {
  const status = useHedwig((s) => s.status);
  const notice = tierNotice(status);
  if (!notice) return null;
  return (
    <span
      role="status"
      data-tier-note=""
      data-level={notice.level}
      title={notice.detail || undefined}
      style={{ display: 'block', fontFamily: V.why, fontStyle: 'italic', fontSize: size, lineHeight: 1.25, color: notice.level === 'error' ? V.accentInk : V.muted, ...style }}
    >
      {notice.text}
    </span>
  );
}

export function LighterLabel({ what = 'answer', size = 14, style }) {
  const text = what === 'story'
    ? tv('hedwig.v2.tier.lighterStory', 'Written by the lighter model')
    : tv('hedwig.v2.tier.lighterAnswer', 'Answered by the lighter model');
  return (
    <span data-lighter="" style={{ fontFamily: V.why, fontStyle: 'italic', fontSize: size, lineHeight: 1.25, color: V.muted, ...style }}>
      {text}
    </span>
  );
}
