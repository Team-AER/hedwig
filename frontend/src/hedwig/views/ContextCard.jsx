// hedwig.context — who this is and where things stand: follows the open message (its sender and
// thread context), or an explicit entity chosen in People / Needs you.
import { useEffect, useRef, useState } from 'react';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { formatAgo, formatCount, formatMonth } from './helpers.js';
import { useAction, useResource } from './hooks.js';
import { CommitmentList, FactsGrid, mergeById, removeById, replaceById } from './contextParts.jsx';
import {
  ActionError, Avatar, Button, Empty, Glyph, IconButton, Loading, Markdown, MessageLiteRow, SectionLabel, NUM, StateView, T,
} from './ui.jsx';
import { tr } from './i18n.js';

/** Decide what the card shows: the latest of an explicit entity pick and a message selection. */
function useContextSource(props) {
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const selectedEntityId = useHedwig((s) => s.selectedEntityId);
  const [source, setSource] = useState(() => {
    if (props.entityId) return { kind: 'entity', id: props.entityId };
    if (props.messageId) return { kind: 'message', id: props.messageId };
    if (selectedMessageId) return { kind: 'message', id: selectedMessageId };
    if (selectedEntityId) return { kind: 'entity', id: selectedEntityId };
    return null;
  });
  const first = useRef(true);
  const messageAt = useRef(0);
  useEffect(() => { if (props.entityId) setSource({ kind: 'entity', id: props.entityId }); }, [props.entityId]);
  useEffect(() => {
    if (first.current) return;
    messageAt.current = Date.now();
    if (selectedMessageId) setSource({ kind: 'message', id: selectedMessageId });
  }, [selectedMessageId]);
  useEffect(() => {
    if (first.current || !selectedEntityId) return;
    // Opening a message also publishes its sender as the selected entity; the message context
    // already shows that sender, so keep it. A deliberate pick (People, a chip) switches.
    setSource((s) => {
      if (s?.kind === 'message' && (s.senderId === selectedEntityId || (!s.senderId && Date.now() - messageAt.current < 4000))) return s;
      return { kind: 'entity', id: selectedEntityId };
    });
  }, [selectedEntityId]);
  useEffect(() => { first.current = false; }, []);
  return [source, setSource];
}

export default function ContextCard({ props = {}, compact = false }) {
  const [source, setSource] = useContextSource(props);
  const path = !source ? null
    : source.kind === 'entity' ? `/context/entities/${encodeURIComponent(source.id)}`
      : `/context/messages/${encodeURIComponent(source.id)}`;
  const res = useResource(path, { refreshOn: ['hedwig:context-changed'] });

  // Remember the message's sender id so the follow-up entity selection does not flip the card.
  const senderId = source?.kind === 'message' ? res.data?.sender?.entity?.id : null;
  useEffect(() => {
    if (senderId) setSource((s) => (s?.kind === 'message' && s.senderId !== senderId ? { ...s, senderId } : s));
  }, [senderId, setSource]);

  const pad = compact ? '12px 14px' : '18px 16px';
  const frame = (children) => (
    <aside aria-label={tr('contextCard.context', 'Context')} style={{
      height: '100%', minHeight: 0, overflowY: 'auto', boxSizing: 'border-box', padding: pad, display: 'flex', flexDirection: 'column', gap: 14,
      background: T.surface, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>{children}</aside>
  );

  if (!source) {
    return frame(<Empty title={tr('contextCard.context', 'Context')}>{tr('contextCard.openAMessageOrPick', 'Open a message or pick a person to see who they are, what is open between you, and the facts Hedwig has found.')}</Empty>);
  }
  if (res.loading && !res.data) return frame(<Loading label="Gathering context…" />);
  if (res.error && !res.data) {
    if (res.error.status === 404 && source.kind === 'message') {
      return frame(<Empty title={tr('contextCard.noContextYet', 'No context yet')}>{tr('contextCard.hedwigHasNotIndexedThis', 'Hedwig has not indexed this message yet. Context appears once it has been read by the pipeline.')}</Empty>);
    }
    return frame(<StateView error={res.error} onRetry={res.reload} what="The context engine" />);
  }
  if (!res.data) return frame(null);

  if (source.kind === 'entity') {
    const setCard = res.setData;
    return frame(
      <EntityBody card={res.data} reload={res.reload} compact={compact}
        onCommitment={(c) => setCard((d) => ({ ...d, commitments: replaceById(d.commitments, c) }))}
        onFact={(f) => setCard((d) => ({ ...d, facts: replaceById(d.facts, f) }))}
        onFactRemove={(f) => setCard((d) => ({ ...d, facts: removeById(d.facts, f) }))} />,
    );
  }

  const ctx = res.data;
  const setCtx = res.setData;
  const card = ctx.sender;
  const related = ctx.related?.length > 0 ? (
    <div>
      <SectionLabel style={{ marginBottom: 4 }}>{tr('contextCard.related', 'Related')}</SectionLabel>
      {ctx.related.slice(0, 6).map((m) => <MessageLiteRow key={m.id} message={m} dense />)}
    </div>
  ) : null;
  return frame(
    <>
      {card ? (
        <EntityBody
          card={{
            ...card,
            commitments: mergeById(ctx.commitments, card.commitments),
            facts: mergeById(ctx.facts, card.facts),
          }}
          onCommitment={(c) => setCtx((d) => ({ ...d, commitments: replaceById(d.commitments, c), sender: { ...d.sender, commitments: replaceById(d.sender.commitments, c) } }))}
          onFact={(f) => setCtx((d) => ({ ...d, facts: replaceById(d.facts, f), sender: { ...d.sender, facts: replaceById(d.sender.facts, f) } }))}
          onFactRemove={(f) => setCtx((d) => ({ ...d, facts: removeById(d.facts, f), sender: { ...d.sender, facts: removeById(d.sender.facts, f) } }))}
          reload={res.reload}
          topic={ctx.topic}
          compact={compact}
          extra={related}
        />
      ) : (
        <>
          <Empty title={tr('contextCard.noSenderCard', 'No sender card')}>{tr('contextCard.hedwigDoesNotHaveA', 'Hedwig does not have a card for this sender yet.')}</Empty>
          <CommitmentList items={ctx.commitments} onChange={(c) => setCtx((d) => ({ ...d, commitments: replaceById(d.commitments, c) }))} />
          <FactsGrid items={ctx.facts} onChange={(f) => setCtx((d) => ({ ...d, facts: replaceById(d.facts, f) }))}
            onRemove={(f) => setCtx((d) => ({ ...d, facts: removeById(d.facts, f) }))} />
          {related}
        </>
      )}
    </>,
  );
}

function EntityBody({ card, reload, topic, compact, onCommitment, onFact, onFactRemove, extra }) {
  const openView = useHedwig((s) => s.openView);
  const setSelectedTopic = useHedwig((s) => s.setSelectedTopic);
  const { entity, summary, stats, commitments, facts, recent, topics } = card;
  const refresh = useAction(async () => {
    await hedwigApi.post(`/context/entities/${encodeURIComponent(entity.id)}/refresh`);
    await reload({ quiet: true });
  });
  if (!entity) return null;
  const addresses = entity.addresses?.length || 0;
  const orgLine = [entity.org?.display_name || (entity.kind === 'org' ? null : entity.domain), addresses > 1 ? `${addresses} addresses merged` : entity.primary_email]
    .filter(Boolean).join(' · ');
  const openTopic = (t) => { setSelectedTopic(t.id); openView('hedwig.timeline', { topicId: t.id }); };
  const allTopics = mergeById(topic ? [topic] : [], topics);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={entity.display_name} email={entity.primary_email} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entity.display_name || entity.primary_email}</span>
          <span style={{ fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orgLine}</span>
        </div>
      </div>
      {stats && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.muted, paddingBottom: 12, borderBottom: `1px solid ${T.raised}` }}>
          <span><strong style={{ color: T.ink, ...NUM, fontWeight: 600 }}>{formatCount(stats.messages)}</strong> mails</span>
          {stats.accounts && <span><strong style={{ color: T.ink, ...NUM, fontWeight: 600 }}>{stats.accounts.length}</strong> account{stats.accounts.length === 1 ? '' : 's'}</span>}
          {stats.first_seen && <span>since {formatMonth(stats.first_seen)}</span>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionLabel right={<IconButton label="Refresh summary" icon="refresh" size={24} onClick={() => refresh.run()} disabled={refresh.busy}
          style={refresh.busy ? { animation: 'hw-spin 0.9s linear infinite' } : undefined} />}>
          State of things
        </SectionLabel>
        {summary?.text ? (
          <>
            <Markdown text={summary.text} style={{ fontSize: 13 }} resolveCite={(n) => summary.sources?.[n - 1]} />
            {summary.at && <span style={{ fontSize: 11, color: T.muted }}>updated {formatAgo(summary.at)}</span>}
          </>
        ) : (
          <span style={{ fontSize: 13, color: T.muted }}>No summary yet. {refresh.busy ? 'Writing one…' : 'Refresh to write one.'}</span>
        )}
        <ActionError error={refresh.error} onDismiss={refresh.clearError} />
      </div>

      <CommitmentList items={commitments} counterpartyName={entity.display_name}
        onChange={onCommitment} />
      <FactsGrid items={facts} onChange={onFact} onRemove={onFactRemove} />

      {allTopics.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>{tr('contextCard.topics', 'Topics')}</SectionLabel>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allTopics.map((t) => (
              <button key={t.id} type="button" onClick={() => openTopic(t)} style={{
                padding: '3px 9px', borderRadius: 6, border: 0, background: T.tealTint, color: T.tealText, font: 'inherit', fontSize: 12, cursor: 'pointer',
              }}>
                {t.label}{t.message_count ? <span style={{ ...NUM, marginLeft: 6, opacity: 0.8 }}>{t.message_count}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {!compact && recent?.length > 0 && (
        <div>
          <SectionLabel style={{ marginBottom: 4 }}>{tr('contextCard.recent', 'Recent')}</SectionLabel>
          {recent.slice(0, 5).map((m) => <MessageLiteRow key={m.id} message={m} dense />)}
        </div>
      )}

      {extra}
      <span style={{ flexGrow: 1 }} />
      <Button onClick={() => openView('hedwig.ask', { entityId: entity.id, topicId: topic?.id, question: '' })}
        style={{ justifyContent: 'flex-start', background: T.raised, border: 0, padding: '10px 12px', fontWeight: 500 }}>
        <Glyph name="ask" /> Ask about {entity.kind === 'org' ? 'this organisation' : (entity.display_name || 'this person')}
      </Button>
    </>
  );
}
