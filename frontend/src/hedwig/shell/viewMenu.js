// Menu items for choosing a view, grouped as in the registry.
import { groupedViews } from './useRegistry.js';

export function viewMenuItems(currentId, onPick) {
  const items = [];
  for (const g of groupedViews()) {
    items.push({ type: 'header', label: g.label });
    for (const v of g.views) {
      items.push({ id: v.id, label: v.title || v.id, icon: v.icon, checked: v.id === currentId, onSelect: () => onPick(v.id) });
    }
  }
  return items;
}
