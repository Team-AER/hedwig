import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { fetchMessageBodyWithRetry } from '../utils/messageBody.js';
import MessageBodyView from './MessageBodyView.jsx';

// One message inside a conversation.
//
// Collapsed it is a header row and nothing else: no body request, no frame, no document.
// That is what makes a long thread affordable, since an expanded body is a whole rendered
// document and a thread can run to dozens of messages. Only what the reader has opened is
// ever rendered, which is how Gmail and Thunderbird handle the same problem.
//
// Design from #317 by YunQue0912.
export default function ConversationMessageCard({ message, expanded, onToggle }) {
  const [body, setBody] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef(null);
  const emailScaleRef = useRef(1);

  // The body is fetched the first time this card is opened and kept afterwards, so
  // collapsing and reopening does not cost another round trip.
  useEffect(() => {
    if (!expanded || body || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMessageBodyWithRetry(message.id, {
      load: (id, remoteImages) => api.getMessageBody(id, remoteImages),
      isCancelled: () => cancelled,
    })
      .then(data => { if (!cancelled) setBody(data); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, body, loading, message.id]);

  const when = message.date ? new Date(message.date).toLocaleString() : '';
  const who = message.from_name || message.from_email || '';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8, background: 'var(--bg-primary)' }}>
      <button
        onClick={() => onToggle(message.id)}
        aria-expanded={expanded}
        style={{
          width: '100%', display: 'flex', alignItems: 'baseline', gap: 8, textAlign: 'left',
          background: 'none', border: 'none', padding: '10px 12px', cursor: 'pointer',
          color: 'var(--text-primary)', font: 'inherit',
        }}
      >
        <span style={{ fontWeight: message.is_read ? 400 : 600, flex: '0 1 auto' }}>{who}</span>
        {!expanded && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 13, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {message.snippet || ''}
          </span>
        )}
        <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 'auto', flex: '0 0 auto' }}>{when}</span>
      </button>

      {expanded && (
        <div style={{ padding: '0 12px 12px' }}>
          {loading && (
            <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '74%', borderRadius: 4 }} />
            </div>
          )}
          {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13 }}>{error}</div>}
          {body?.html && (
            <MessageBodyView
              iframeRef={iframeRef}
              body={body}
              messageId={message.id}
              emailScaleRef={emailScaleRef}
              hasNativeContextTarget={false}
              onContextMenu={null}
            />
          )}
          {!body?.html && body?.text && (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body.text}</div>
          )}
        </div>
      )}
    </div>
  );
}
