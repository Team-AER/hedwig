// hedwig.timeline — topics, and one topic as a dated timeline: who said what, what is owed.
import { useEffect, useMemo, useState } from 'react';
import { useHedwig } from '../store.js';
import { dueLabel, formatAgo, formatCount, formatDay, senderName, truncate } from './helpers.js';
import { isTypingTarget, openMessage, useResource } from './hooks.js';
import { CommitmentList, FactsGrid, removeById, replaceById } from './contextParts.jsx';
import { Button, Chip, Dot, Empty, Glyph, Loading, Markdown, SectionLabel, NUM, StateView, T } from './ui.jsx';
import { tr } from './i18n.js';

const MARKER_COLOR = { i_owe: T.amber, they_owe: T.teal, settled: T.muted };

export default function Timeline({ props = {} }) {
  const selectedTopicId = useHedwig((s) => s.selectedTopicId);
  const setSelectedTopic = useHedwig((s) => s.setSelectedTopic);
  const topicId = props.topicId || selectedTopicId;
  const topics = useResource('/context/topics?limit=100');
  const [showList, setShowList] = useState(!props.topicId);

  useEffect(() => { if (props.topicId) setSelectedTopic(props.topicId); }, [props.topicId, setSelectedTopic]);
  useEffect(() => {
    if (!topicId && topics.data?.length) setSelectedTopic(topics.data[0].id);
  }, [topicId, topics.data, setSelectedTopic]);

  const sorted = useMemo(() => (topics.data || []).slice().sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen)), [topics.data]);

  return (
    <section aria-label={tr('timeline.topicTimeline', 'Topic timeline')} style={{
      height: '100%', minHeight: 0, display: 'flex', background: T.ground, color: T.ink, fontFamily: T.body, fontSize: 14, lineHeight: 1.45,
    }}>
      {showList && (
        <TopicList topics={sorted} res={topics} selected={topicId} onSelect={(id) => setSelectedTopic(id)} />
      )}
      <div style={{ flexGrow: 1, minWidth: 0, overflowY: 'auto', padding: '22px 24px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowList((v) => !v)} aria-expanded={showList}>
            {showList ? 'Hide topics' : 'All topics'}
          </Button>
        </div>
        {topicId ? <TopicDetail key={topicId} topicId={topicId} /> : (
          topics.loading ? <Loading /> : topics.error ? <StateView error={topics.error} onRetry={topics.reload} what="Topics" />
            : <Empty title={tr('timeline.noTopicsYet', 'No topics yet')}>{tr('timeline.topicsFormAsHedwigNotices', 'Topics form as Hedwig notices several messages about the same thing.')}</Empty>
        )}
      </div>
    </section>
  );
}

function TopicList({ topics, res, selected, onSelect }) {
  const onKeyDown = (e) => {
    if (isTypingTarget(e)) return;
    const i = topics.findIndex((t) => t.id === selected);
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const t = topics[Math.min(topics.length - 1, i + 1)]; if (t) onSelect(t.id); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const t = topics[Math.max(0, i - 1)]; if (t) onSelect(t.id); }
  };
  return (
    <nav aria-label={tr('timeline.topics', 'Topics')} style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: T.surface, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 14px 8px' }}><SectionLabel>{tr('timeline.topics', 'Topics')}</SectionLabel></div>
      {res.loading && !res.data && <Loading />}
      {res.error && !res.data && <StateView error={res.error} onRetry={res.reload} what="Topics" compact />}
      <div role="listbox" tabIndex={0} aria-label={tr('timeline.topics', 'Topics')} onKeyDown={onKeyDown} aria-activedescendant={selected ? `hw-topic-${selected}` : undefined} style={{ outlineOffset: -2 }}>
        {topics.map((t) => (
          <div key={t.id} id={`hw-topic-${t.id}`} role="option" aria-selected={t.id === selected} onClick={() => onSelect(t.id)} style={{
            padding: '8px 14px', cursor: 'pointer', borderTop: `1px solid ${T.raised}`, background: t.id === selected ? T.raised : 'transparent',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontWeight: t.id === selected ? 600 : 500, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
              {t.open_commitments > 0 && <Chip tone="amber">{t.open_commitments}</Chip>}
            </span>
            <span style={{ fontSize: 12, color: T.muted }}>{formatCount(t.message_count)} messages · {formatAgo(t.last_seen)}</span>
          </div>
        ))}
      </div>
    </nav>
  );
}

function TopicDetail({ topicId }) {
  const openView = useHedwig((s) => s.openView);
  const res = useResource(`/context/topics/${encodeURIComponent(topicId)}`, { refreshOn: ['hedwig:context-changed'] });
  if (res.loading && !res.data) return <Loading label="Loading topic…" />;
  if (res.error && !res.data) return <StateView error={res.error} onRetry={res.reload} what="This topic" />;
  const card = res.data;
  if (!card?.topic) return null;
  const { topic, people = [], commitments = [], facts = [] } = card;
  // Newest first, as in the design; citation numbers follow this order.
  const timeline = (card.timeline || []).slice().sort((a, b) => new Date(b.message?.date || 0) - new Date(a.message?.date || 0));
  const set = res.setData;
  const accounts = new Set(timeline.map((e) => e.message?.account_id).filter(Boolean));
  const open = commitments.filter((c) => !c.status || c.status === 'open');
  const overdue = open.filter((c) => c.overdue).length;
  const soon = open.filter((c) => !c.overdue && c.due_at && (new Date(c.due_at) - Date.now()) < 14 * 86_400_000);
  const badge = [overdue ? `${overdue} overdue` : null, soon.length ? `${soon.length} ${dueLabel(soon[0].due_at)}` : null].filter(Boolean).join(' · ');

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontFamily: T.display, fontSize: 20, fontWeight: 600 }}>{topic.label}</h2>
        <span style={{ fontSize: 12, color: T.muted }}>
          topic · {formatCount(topic.message_count)} messages · {people.length} {people.length === 1 ? 'person' : 'people'} · {accounts.size} account{accounts.size === 1 ? '' : 's'}
        </span>
        <span style={{ flexGrow: 1 }} />
        {badge && <Chip tone="amber" size="md">{badge}</Chip>}
        <Button size="sm" onClick={() => openView('hedwig.ask', { topicId: topic.id, question: '' })}><Glyph name="ask" size={13} /> {tr('timeline.askAboutThisTopic', 'Ask about this topic')}</Button>
      </div>

      {topic.summary && (
        <Markdown text={topic.summary} style={{ fontSize: 13 }}
          resolveCite={(n) => topic.summary_sources?.[n - 1]} />
      )}

      <ol aria-label={tr('timeline.timeline', 'Timeline')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {timeline.length === 0 && <li style={{ color: T.muted, fontSize: 13 }}>{tr('timeline.noMessagesInThisTopic', 'No messages in this topic yet.')}</li>}
        {timeline.map((ev, i) => {
          const m = ev.message || {};
          const tags = tagsFor(m.id, commitments, facts);
          return (
            <li key={m.id || i} style={{ display: 'flex', gap: 14, padding: '10px 0', borderTop: `1px solid ${T.border}` }}>
              <div style={{ width: 78, flexShrink: 0, ...NUM, fontSize: 12, color: T.muted, paddingTop: 2 }}>{formatDay(m.date)}</div>
              <div style={{ width: 10, flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
                <Dot color={MARKER_COLOR[ev.marker] || T.muted} />
              </div>
              <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>{senderName(m)}</span>
                  <span style={{ fontSize: 12, color: T.muted }}>{m.account?.name}</span>
                  <span style={{ flexGrow: 1 }} />
                  <button type="button" onClick={() => openMessage(m.id, { lite: m })} aria-label={`Open message ${i + 1}: ${m.subject || ''}`}
                    style={{ border: 0, padding: 0, background: 'none', ...NUM, fontSize: 11, fontWeight: 600, color: T.tealText, cursor: 'pointer' }}>[{i + 1}]</button>
                </div>
                <div style={{ fontSize: 13 }}>{ev.gist || truncate(m.subject || m.snippet || '', 200)}</div>
                {tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                    {tags.map((t) => <Chip key={t.key} tone={t.tone}>{t.text}</Chip>)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: T.muted }}>
        <Dot color={T.amber} /><span>{tr('timeline.youOwe', 'you owe')}</span>
        <Dot color={T.teal} style={{ marginLeft: 10 }} /><span>{tr('timeline.theyOwe', 'they owe')}</span>
        <Dot color={T.muted} style={{ marginLeft: 10 }} /><span>settled</span>
        <span style={{ flexGrow: 1 }} />
        <span>{tr('timeline.factsAndCommitmentsAreEditable', 'Facts and commitments are editable; corrections train the extractor.')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {commitments.length ? (
            <CommitmentList items={commitments} editable showDone title={tr('timeline.commitments', 'Commitments')}
              onChange={(c) => set((d) => ({ ...d, commitments: replaceById(d.commitments, c) }))} />
          ) : <SectionLabel>{tr('timeline.noCommitmentsFound', 'No commitments found')}</SectionLabel>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {facts.length ? (
            <FactsGrid items={facts} editable
              onChange={(f) => set((d) => ({ ...d, facts: replaceById(d.facts, f) }))}
              onRemove={(f) => set((d) => ({ ...d, facts: removeById(d.facts, f) }))} />
          ) : <SectionLabel>{tr('timeline.noFactsFound', 'No facts found')}</SectionLabel>}
        </div>
      </div>

      {people.length > 0 && <People people={people} />}
    </>
  );
}

function People({ people }) {
  const setSelectedEntity = useHedwig((s) => s.setSelectedEntity);
  const openView = useHedwig((s) => s.openView);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>{tr('timeline.people', 'People')}</SectionLabel>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {people.map((p) => (
          <button key={p.id} type="button" onClick={() => { setSelectedEntity(p.id); openView('hedwig.context', { entityId: p.id }); }} style={{
            padding: '3px 9px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, font: 'inherit', fontSize: 12, cursor: 'pointer',
          }}>{p.display_name || p.primary_email}</button>
        ))}
      </div>
    </div>
  );
}

function tagsFor(messageId, commitments, facts) {
  if (!messageId) return [];
  const out = [];
  for (const c of commitments) {
    if (c.source_message_id !== messageId) continue;
    const settled = c.status && c.status !== 'open';
    const when = c.due_at ? ` · ${dueLabel(c.due_at).replace(/^due /, 'due ')}` : '';
    out.push({
      key: `c${c.id}`,
      tone: settled ? 'neutral' : c.direction === 'i_owe' ? 'amber' : 'teal',
      text: `${c.direction === 'i_owe' ? 'You owe' : 'They owe'}${settled ? ` · ${c.status}` : when}`,
    });
  }
  for (const f of facts) {
    if (f.source_message_id === messageId) out.push({ key: `f${f.id}`, tone: 'neutral', text: `Fact: ${f.key} ${truncate(String(f.value), 40)}` });
  }
  return out;
}
