import { useStore } from '../store/index.js';
import { resolveConversationMode } from '../utils/conversationMode.js';
import ConversationPane from './ConversationPane.jsx';
import MessagePane from './MessagePane.jsx';

// Chooses what the reading area shows.
//
// In 'pane' mode a selected row opens its whole conversation; in every other mode it opens
// the single message, exactly as before. The thread is taken from the selected message
// rather than tracked separately, so selecting a row needs no new behavior in MessageList.
//
// Pop-out windows deliberately keep MessagePane: a pop-out is one message by definition.
//
// Design from #317 by YunQue0912.
export default function ReadingPane() {
  const conversationMode = useStore(s => s.conversationMode);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const messages = useStore(s => s.messages);
  const searchResults = useStore(s => s.searchResults);
  const selectedFolder = useStore(s => s.selectedFolder);
  const selectedAccountId = useStore(s => s.selectedAccountId);

  const mode = resolveConversationMode({ conversationMode });
  if (mode !== 'pane' || !selectedMessageId) return <MessagePane />;

  const selected = [...(messages || []), ...(searchResults || [])]
    .find(m => m.id === selectedMessageId);
  // A message with no thread of its own is just a message.
  if (!selected?.thread_id) return <MessagePane />;

  return (
    <ConversationPane
      threadId={selected.thread_id}
      folder={selectedFolder}
      unified={!selectedAccountId}
    />
  );
}
