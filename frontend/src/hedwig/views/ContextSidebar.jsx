// The context card inside upstream's right sidebar (classic shell).
import RightSidebar from '../../components/RightSidebar.jsx';
import ContextCard from './ContextCard.jsx';
import { tr } from './i18n.js';

export default function ContextSidebar({ onCollapse, toggleHint }) {
  return (
    <RightSidebar title={tr('contextSidebar.context', 'Context')} onCollapse={onCollapse} toggleHint={toggleHint}>
      <ContextCard compact />
    </RightSidebar>
  );
}
