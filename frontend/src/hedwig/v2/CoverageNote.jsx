// "Features light up as the index fills": while GET /index/coverage says the index is not
// complete, Ask, the ledgers and the Brief say how much of the mail they can see. Nothing shows
// once it is complete, when the share is unknown, or when the route is not there.
import { useV2Resource } from './hooks.js';
import { coverageOf, coverageGap } from './ask.js';
import { V } from './primitives.jsx';
import { tv } from './i18n.js';

export function coverageText(what, share) {
  if (what === 'cards') return tv('hedwig.v2.coverage.cards', 'Hedwig has read {{share}} of your mail so far; these figures come from that part.', { share });
  if (what === 'brief') return tv('hedwig.v2.coverage.brief', 'Hedwig has read {{share}} of your mail so far.', { share });
  return tv('hedwig.v2.coverage.ask', 'Hedwig has read {{share}} of your mail so far; Ask answers from that part until the rest is in.', { share });
}

/** `coverage` given (the Brief carries it) skips the request. */
export function CoverageNote({ what = 'ask', coverage, style }) {
  const res = useV2Resource(coverage === undefined ? '/index/coverage' : null, { refreshOn: [] });
  const gap = coverageGap(coverageOf({ coverage: coverage === undefined ? res.data : coverage }));
  if (!gap) return null;
  return (
    <span data-coverage="" style={{ display: 'block', fontSize: 13, color: V.muted, ...style }}>
      {coverageText(what, gap)}
    </span>
  );
}
