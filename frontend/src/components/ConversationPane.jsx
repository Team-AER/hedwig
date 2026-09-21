import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import {
  normalizeConversation,
  initialExpandedMessageIds,
  conversationMembershipKey,
} from '../utils/conversation.js';
import ConversationMessageCard from './ConversationMessageCard.jsx';

// The whole conversation, stacked, with only what the reader has opened rendered.
//
// The thread endpoint already returns every message across folders, Sent replies included,
// deduplicated by Message-ID preferring the INBOX copy, so this needs no scope parameter of
// its own.
//
// Design from #317 by YunQue0912.
export default function ConversationPane({ threadId, folder, unified = false }) {
  const [messages, setMessages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getThread(threadId, folder, unified)
      .then(data => {
        if (cancelled) return;
        const ordered = normalizeConversation(data?.messages || []);
        setMessages(ordered);
        // Opens on the newest message, the way every threaded client does: the reader
        // almost always wants the latest reply, and expanding everything would render a
        // document per message.
        setExpanded(initialExpandedMessageIds(ordered));
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId, folder, unified]);

  const toggle = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (error) return <div style={{ padding: 16, color: 'var(--red, #e03131)' }}>{error}</div>;
  if (loading && !messages.length) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="skeleton-line" style={{ height: 13, width: '48%', borderRadius: 4 }} />
        <div className="skeleton-line" style={{ height: 13, width: '70%', borderRadius: 4 }} />
      </div>
    );
  }
  if (!messages.length) return null;

  return (
    <div
      // Remounts the stack when the thread's membership changes, so expansion state from a
      // previous conversation can never be applied to this one's message ids.
      key={conversationMembershipKey(messages)}
      style={{ padding: 12, overflowY: 'auto', height: '100%' }}
    >
      {messages.map(message => (
        <ConversationMessageCard
          key={message.id}
          message={message}
          expanded={expanded.has(message.id)}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}
