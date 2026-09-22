// Layout export (a JSON download) and import (a JSON file the user picks).
import { exportLayoutJson, parseLayoutJson } from './model.js';
import { useShell } from './state.js';

export function exportCurrentLayout() {
  const { name, tree, device } = useShell.getState();
  if (!tree) return;
  const blob = new Blob([exportLayoutJson(name, tree)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hedwig-layout-${String(name || 'layout').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${device}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Resolves to the imported layout's name; rejects with a readable message.
export async function importLayoutFile(file) {
  const text = await file.text();
  const { name, tree } = parseLayoutJson(text);
  const finalName = name || file.name.replace(/\.json$/i, '').slice(0, 80) || 'Imported';
  useShell.getState().setTree(tree, { name: finalName, templateId: null });
  return finalName;
}
