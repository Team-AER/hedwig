// Mail search found nothing: offer the same words to Ask, which reads the mail instead of matching
// words (MessageList's empty search state). Only in the Hedwig shell, with Ask available.
import { useHedwig } from '../store.js';
import { getView } from '../registry.js';
import { tv } from './i18n.js';

export default function AskInstead({ query, style }) {
  const shell = useHedwig((s) => s.shellMode) === 'hedwig';
  const q = String(query || '').trim();
  if (!shell || !q || !getView('hedwig.ask')) return null;
  const ask = () => {
    useHedwig.getState().setAskPrompt(q);
    useHedwig.getState().openView('hedwig.ask', { question: q });
  };
  return (
    <button type="button" data-ask-instead="" onClick={ask} style={style}>
      {tv('hedwig.v2.askInstead', 'Ask Hedwig instead')}
    </button>
  );
}
