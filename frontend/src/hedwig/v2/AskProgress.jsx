// Ask's progress (ask.js steps): while an answer is being worked out, a timeline of what Ask is
// doing — understanding the question, each search and what it found, checking what is still
// missing, searching again in other words, reading, writing — with the time so far. Once the answer
// is there it folds into one line ("Searched 3 ways · Read 45 messages · 17 s") that opens the
// steps again.
import { useEffect, useState } from 'react';
import i18n from 'i18next';
import { Icon } from '../icons.jsx';
import { V } from './primitives.jsx';
import { tv, tvn } from './i18n.js';

// Styles: .hw-steps … in theme/styles.js.


/** Seconds as "17 s" / "1 min 5 s" in the reader's language. */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const unit = (n, u) => {
    try { return new Intl.NumberFormat(i18n.language || undefined, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n); } catch { return `${n} ${u === 'second' ? 's' : 'min'}`; }
  };
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return unit(sec, 'second');
  return `${unit(Math.floor(sec / 60), 'minute')} ${unit(sec % 60, 'second')}`;
}

/** One line per step, in words: { text, query?, detail? }. */
export function stepLine(step) {
  const live = step.status === 'running';
  switch (step.kind) {
    case 'plan':
      return live || !step.text
        ? { text: tv('hedwig.v2.ask.progress.plan', 'Understanding the question') }
        : { text: tv('hedwig.v2.ask.progress.lookingFor', 'Looking for'), query: step.text };
    case 'search': {
      const text = live ? tv('hedwig.v2.ask.progress.searching', 'Searching') : tv('hedwig.v2.ask.progress.searched', 'Searched');
      if (live) return { text, query: step.text };
      const n = Number(step.found) || 0;
      const detail = step.round > 0
        ? (n ? tvn(n, ['hedwig.v2.ask.progress.newOne', '1 new'], ['hedwig.v2.ask.progress.newMany', '{{n}} new']) : tv('hedwig.v2.ask.progress.nothingNew', 'nothing new'))
        : tvn(n, ['hedwig.v2.ask.progress.messagesOne', '1 message'], ['hedwig.v2.ask.progress.messagesMany', '{{n}} messages']);
      return { text, query: step.text, detail, fresh: step.round > 0 && n > 0 };
    }
    case 'review':
      if (live) return { text: tv('hedwig.v2.ask.progress.review', 'Checking what is still missing') };
      return { text: step.enough ? tv('hedwig.v2.ask.progress.enough', 'That covers it') : tv('hedwig.v2.ask.progress.again', 'Searching again with other words') };
    case 'read':
      return {
        text: live
          ? tvn(step.count, ['hedwig.v2.ask.progress.readingOne', 'Reading 1 message'], ['hedwig.v2.ask.progress.readingMany', 'Reading {{n}} messages'])
          : tvn(step.count, ['hedwig.v2.ask.progress.readOne', 'Read 1 message'], ['hedwig.v2.ask.progress.readMany', 'Read {{n}} messages']),
      };
    case 'thread':
      return live
        ? { text: tv('hedwig.v2.ask.progress.threadReading', 'Reading this thread') }
        : { text: tv('hedwig.v2.ask.progress.threadRead', 'Read this thread'), detail: tvn(step.count, ['hedwig.v2.ask.progress.messagesOne', '1 message'], ['hedwig.v2.ask.progress.messagesMany', '{{n}} messages']) };
    case 'web': {
      const text = live ? tv('hedwig.v2.ask.progress.webSearching', 'Searching the web') : tv('hedwig.v2.ask.progress.webSearched', 'Searched the web');
      if (live) return { text, query: step.text };
      return { text, query: step.text, detail: tvn(Number(step.found) || 0, ['hedwig.v2.ask.progress.resultsOne', '1 result'], ['hedwig.v2.ask.progress.resultsMany', '{{n}} results']) };
    }
    case 'webread': {
      if (live) return { text: tvn(step.count || 0, ['hedwig.v2.ask.progress.pagesReadingOne', 'Reading 1 page'], ['hedwig.v2.ask.progress.pagesReadingMany', 'Reading {{n}} pages']) };
      const hosts = [...new Set((step.pages || []).filter((x) => x && x.ok && x.host).map((x) => x.host))];
      const failed = (step.pages || []).filter((x) => x && !x.ok).length;
      return {
        text: tvn(step.count || 0, ['hedwig.v2.ask.progress.pagesReadOne', 'Read 1 page'], ['hedwig.v2.ask.progress.pagesReadMany', 'Read {{n}} pages']),
        query: hosts.slice(0, 3).join(', ') || undefined,
        detail: failed ? tvn(failed, ['hedwig.v2.ask.progress.pagesFailedOne', '1 would not open'], ['hedwig.v2.ask.progress.pagesFailedMany', '{{n}} would not open']) : undefined,
      };
    }
    case 'links': {
      const skipped = step.skipped || [];
      const reasons = [...new Set(skipped.map((x) => linkReason(x?.reason)).filter(Boolean))].join(', ');
      return {
        text: step.opened
          ? tvn(step.opened, ['hedwig.v2.ask.progress.linksOne', 'Followed 1 link from the mail'], ['hedwig.v2.ask.progress.linksMany', 'Followed {{n}} links from the mail'])
          : tv('hedwig.v2.ask.progress.linksNone', 'Followed no links from the mail'),
        detail: skipped.length ? tvn(skipped.length, ['hedwig.v2.ask.progress.skippedOne', 'skipped 1 ({{why}})'], ['hedwig.v2.ask.progress.skippedMany', 'skipped {{n}} ({{why}})'], { why: reasons }) : undefined,
      };
    }
    case 'dig':
      if (live) return { text: tv('hedwig.v2.ask.progress.dig', 'Deciding what else to read') };
      return { text: step.enough ? tv('hedwig.v2.ask.progress.digEnough', 'Read enough') : tv('hedwig.v2.ask.progress.digMore', 'Looking further') };
    case 'write':
      return { text: live ? tv('hedwig.v2.ask.progress.writing', 'Writing the answer') : tv('hedwig.v2.ask.progress.written', 'Wrote the answer') };
    default:
      return { text: '' };
  }
}

/** Why a link in the mail was not followed, in words. */
export function linkReason(reason) {
  switch (reason) {
    case 'unsubscribe': return tv('hedwig.v2.ask.progress.whyUnsubscribe', 'unsubscribe');
    case 'confirm': return tv('hedwig.v2.ask.progress.whyConfirm', 'confirm');
    case 'password': return tv('hedwig.v2.ask.progress.whyPassword', 'password');
    case 'sign-in': case 'token': return tv('hedwig.v2.ask.progress.whySignIn', 'sign-in');
    case 'respond': return tv('hedwig.v2.ask.progress.whyRespond', 'reply to an invitation');
    case 'payment': return tv('hedwig.v2.ask.progress.whyPayment', 'payment');
    case 'tracker': return tv('hedwig.v2.ask.progress.whyTracker', 'click tracker');
    default: return reason ? String(reason) : '';
  }
}

/** The folded line once the answer is there: searches, messages and pages read, time taken. */
export function summaryLine(steps, ms) {
  const searches = steps.filter((x) => x.kind === 'search').length;
  const read = steps.find((x) => x.kind === 'read')?.count || 0;
  const web = steps.filter((x) => x.kind === 'web').length;
  const pages = steps.filter((x) => x.kind === 'webread').reduce((n, x) => n + (Number(x.count) || 0), 0);
  return [
    searches ? tvn(searches, ['hedwig.v2.ask.progress.waysOne', 'Searched once'], ['hedwig.v2.ask.progress.waysMany', 'Searched {{n}} ways']) : null,
    read ? tvn(read, ['hedwig.v2.ask.progress.readOne', 'Read 1 message'], ['hedwig.v2.ask.progress.readMany', 'Read {{n}} messages']) : null,
    web && !pages ? tvn(web, ['hedwig.v2.ask.progress.webOne', 'Searched the web once'], ['hedwig.v2.ask.progress.webMany', 'Searched the web {{n}} times']) : null,
    pages ? tvn(pages, ['hedwig.v2.ask.progress.pagesReadOne', 'Read 1 page'], ['hedwig.v2.ask.progress.pagesReadMany', 'Read {{n}} pages']) : null,
    duration(ms) || null,
  ].filter(Boolean).join(' · ');
}

function useNow(live) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

function Mark({ status }) {
  if (status === 'running') return <span className="hw-step-mark"><span className="hw-step-ring" /></span>;
  if (status === 'stopped') return <span className="hw-step-mark" style={{ color: V.muted }}><Icon name="minus" size={10} strokeWidth={2.4} /></span>;
  return (
    <span className="hw-step-mark" style={{ background: `color-mix(in srgb, var(--hw-accent, #007AFF) 14%, var(--hw-content, #fff))`, color: V.accentInk }}>
      <Icon name="check" size={10} strokeWidth={2.6} />
    </span>
  );
}

export default function AskProgress({ state }) {
  const steps = state.steps || [];
  const live = state.status === 'streaming' || state.status === 'loading';
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  if (!steps.length) return null;
  const ms = state.startedAt ? (state.finishedAt || now) - state.startedAt : NaN;

  if (!live && !open) {
    return (
      <div data-ask-progress="folded">
        <button type="button" className="hw-steps-sum" aria-expanded="false" onClick={() => setOpen(true)}>
          <Mark status={steps.some((x) => x.status === 'stopped') ? 'stopped' : 'done'} />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{summaryLine(steps, ms)}</span>
          <Icon name="chevron-down" size={12} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <section data-ask-progress={live ? 'live' : 'open'} aria-label={tv('hedwig.v2.ask.progress.working', 'Working on it')} aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', borderRadius: 12, background: V.field, border: `1px solid ${V.line}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: V.muted }}>
        <span style={{ fontWeight: 600, color: V.ink }}>{live ? tv('hedwig.v2.ask.progress.working', 'Working on it') : summaryLine(steps, ms)}</span>
        <span style={{ flexGrow: 1 }} />
        {live && Number.isFinite(ms) && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{duration(ms)}</span>}
        {!live && (
          <button type="button" className="hw-steps-sum" aria-expanded="true" aria-label={tv('hedwig.v2.ask.progress.hide', 'Hide the steps')}
            title={tv('hedwig.v2.ask.progress.hide', 'Hide the steps')} onClick={() => setOpen(false)} style={{ padding: 2 }}>
            <Icon name="chevron-down" size={14} strokeWidth={2} style={{ transform: 'rotate(180deg)' }} />
          </button>
        )}
      </div>
      <ol className="hw-steps">
        {steps.map((step) => {
          const line = stepLine(step);
          const running = step.status === 'running';
          return (
            <li key={step.id} className={`hw-step${running ? ' hw-step-live' : ''}`} data-step={step.kind} data-status={step.status}
              style={{ fontSize: 13, lineHeight: '17px', color: step.status === 'done' ? V.ink : V.muted }}>
              <Mark status={step.status} />
              <span style={{ minWidth: 0, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span className="hw-step-text" style={{ flexShrink: 0 }}>{line.text}</span>
                {line.query && <span className="hw-step-chip" title={line.query} style={{ fontSize: 12, minWidth: 0 }}>{line.query}</span>}
              </span>
              {line.detail
                ? <span style={{ fontSize: 12, color: line.fresh ? V.accentInk : V.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{line.detail}</span>
                : <span />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
