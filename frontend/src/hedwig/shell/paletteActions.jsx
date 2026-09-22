// Registry commands as upstream CommandPalette actions: { id, label, icon, hint, group, run }.
// In the classic shell only the way back to Hedwig is offered, so classic stays as upstream made it.
import { useStore } from '../../store/index.js';
import { useHedwig } from '../store.js';
import { listCommands, getView } from '../registry.js';
import { Icon } from '../icons.jsx';
import { formatKeys } from './keymap.js';
import { effectiveBindings } from './useKeymap.js';
import { useRegistryVersion } from './useRegistry.js';
import { useShell } from './state.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const GROUP_ORDER = ['Open view', 'Hedwig', 'Layout'];

function icon(name) {
  return <Icon name={name || 'spark'} size={15} strokeWidth={2} />;
}

export function useHedwigPaletteActions(query) {
  useRegistryVersion();
  const shellMode = useHedwig((s) => s.shellMode);
  const shortcuts = useStore((s) => s.shortcuts);
  const q = query.trim();

  const commands = listCommands();
  if (shellMode !== 'hedwig') {
    return commands.filter((c) => c.id === 'shell.hedwig').map((c) => ({ id: c.id, label: c.title, icon: icon(c.icon), group: 'Hedwig', run: c.run }));
  }

  const bindings = effectiveBindings(shortcuts);
  const actions = [];
  if (q) {
    if (getView('hedwig.ask')) {
      actions.push({
        id: 'hedwig:ask-query', label: `Ask Hedwig: “${q}”`, icon: icon('ask'), group: 'Hedwig',
        run: () => { useHedwig.getState().setAskPrompt(q); useHedwig.getState().openView('hedwig.ask', { question: q }); },
      });
    }
    actions.push({
      id: 'hedwig:search-mail', label: `Search mail for “${q}”`, icon: icon('search'), group: 'Mail',
      run: () => {
        useStore.getState().setSearchQuery(q);
        // On a phone upstream's own list is the search screen; elsewhere show a list pane.
        if (window.innerWidth < 768) { useShell.getState().setMobileTab('inbox'); useShell.getState().setStack('inbox', []); }
        else useHedwig.getState().openView('core.list');
      },
    });
  }

  const sorted = [...commands].sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
  });
  for (const c of sorted) {
    const b = bindings.get(c.id);
    actions.push({
      id: `cmd:${c.id}`,
      label: c.title || c.id,
      icon: typeof c.icon === 'string' || !c.icon ? icon(c.icon) : c.icon,
      group: c.group || 'Hedwig',
      hint: b ? formatKeys(b.keys, isMac).join(' ') : undefined,
      run: c.run,
    });
  }
  return actions;
}
