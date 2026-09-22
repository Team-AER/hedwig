// "Why is this here?" — the triage explanation for one message: category, confidence, weighted
// reasons (bar length = weight; teal for, amber against), the sender's history, and corrections.
import { hedwigApi } from '../api.js';
import { categoryLabel, formatPercent, senderName, truncate, TRIAGE_CATEGORIES } from './helpers.js';
import { useAction, useResource } from './hooks.js';
import { ActionError, Button, Card, Spinner, StateView, T } from './ui.jsx';
import { tr } from './i18n.js';

export function overrideTriage(messageId, category, reason) {
  return hedwigApi.post(`/triage/messages/${encodeURIComponent(messageId)}/override`, { category, reason })
    .then((info) => { window.dispatchEvent(new CustomEvent('hedwig:triage-changed', { detail: { messageId, triage: info } })); return info; });
}

export default function Explainer({ messageId, message, onChanged, onSenderRule, style }) {
  const res = useResource(messageId ? `/triage/messages/${encodeURIComponent(messageId)}` : null);
  const act = useAction(async (category, reason) => {
    const info = await overrideTriage(messageId, category, reason);
    res.setData((d) => (d ? { ...d, triage: info || { ...d.triage, category, overridden: true } } : d));
    onChanged?.(info || { category, overridden: true });
    return info;
  });

  const triage = res.data?.triage;
  const sender = res.data?.sender;
  const reasons = (triage?.reasons || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const maxW = Math.max(0.01, ...reasons.map((r) => Math.abs(r.weight || 0)));

  return (
    <Card tone="ink" style={{ padding: '16px 18px', gap: 10, ...style }} aria-label={tr('explainer.whyIsThisHere', 'Why is this here?')}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.72 }}>{tr('explainer.whyIsThisHere', 'Why is this here?')}</div>
      {message && (
        <div style={{ fontWeight: 600 }}>{senderName(message)} · “{truncate(message.subject || '(no subject)', 60)}”</div>
      )}
      {res.loading && !res.data && <span style={{ color: T.surface }}><Spinner size={14} /></span>}
      {res.error && (
        <div style={{ background: T.surface, color: T.ink, borderRadius: 8 }}>
          <StateView error={res.error} onRetry={res.reload} what="The explanation" compact />
        </div>
      )}
      {triage && (
        <>
          <div style={{ fontSize: 13, opacity: 0.9 }}>
            Filed under <strong>{categoryLabel(triage.category)}</strong>
            {triage.confidence != null && <> with {Number(triage.confidence).toFixed(2)} confidence</>}
            {triage.stage && <> · stage {triage.stage}</>}
            {triage.overridden && <> {tr('explainer.correctedByYou', '· corrected by you')}</>}.
          </div>
          {reasons.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              {reasons.map((r, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span aria-hidden="true" style={{
                    width: Math.max(8, Math.round((Math.abs(r.weight || 0) / maxW) * 96)), height: 6, borderRadius: 3, flexShrink: 0,
                    background: r.direction === 'against' ? T.amber : T.teal,
                  }} />
                  <span style={{ opacity: r.direction === 'against' ? 0.8 : 1 }}>
                    {r.label}{r.direction === 'against' && ' (against)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {sender && (
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              From this sender: {sender.received ?? 0} received · {formatPercent(rate(sender.opened, sender.received))} opened · {formatPercent(rate(sender.replied, sender.received))} replied
              {sender.archived_unread ? ` · ${sender.archived_unread} archived unread` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, paddingTop: 4, flexWrap: 'wrap' }}>
            {triage.category === 'needs_you'
              ? <Button size="sm" variant="inverse" busy={act.busy} onClick={() => act.run('everything', 'not urgent')}>{tr('explainer.correctNotUrgent', 'Correct: not urgent')}</Button>
              : <Button size="sm" variant="inverse" busy={act.busy} onClick={() => act.run('needs_you', 'needs me')}>{tr('explainer.correctNeedsMe', 'Correct: needs me')}</Button>}
            {onSenderRule && message?.from_email && (
              <Button size="sm" variant="inverseGhost" onClick={() => onSenderRule(message)}>{tr('explainer.neverFromThisSender', 'Never from this sender')}</Button>
            )}
          </div>
          <ActionError error={act.error} onDismiss={act.clearError} />
        </>
      )}
    </Card>
  );
}

function rate(part, whole) {
  if (!whole) return 0;
  return (Number(part) || 0) / Number(whole);
}

/** Buttons for moving a message to another category. */
export function MoveMenu({ current, onPick, busy }) {
  return (
    <div role="menu" aria-label={tr('explainer.moveToCategory', 'Move to category')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: T.muted }}>{tr('explainer.moveTo', 'Move to')}</span>
      {TRIAGE_CATEGORIES.filter((c) => c.id !== current).map((c) => (
        <Button key={c.id} size="sm" role="menuitem" disabled={busy} onClick={() => onPick(c.id)}>
          {c.id === 'everything' ? 'Everything (not for me)' : c.label}
        </Button>
      ))}
    </div>
  );
}
