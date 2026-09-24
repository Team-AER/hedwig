// Settings · Layouts (view 'hedwig.layouts'): template gallery, the pane tree as an editable
// outline, add-a-view chips, density, saved layouts, import/export and a live preview. Edits
// apply to the layout on screen immediately and are saved like any other layout change.
import { useEffect, useRef, useState } from 'react';
import { getView, listViews } from '../registry.js';
import { Icon } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import * as M from './model.js';
import { useShell } from './state.js';
import { TEMPLATES, buildTemplate } from './templates.js';
import { exportCurrentLayout, importLayoutFile } from './layoutFile.js';
import { useRegistryVersion, groupedViews } from './useRegistry.js';
import { tr } from './tr.js';

const REF_W = 1440;
const REF_H = 900;

function tone(id) {
  if (id === 'core.nav') return 'var(--hw-border)';
  if (/^(core\.list|hedwig\.(needs|ask))$/.test(id)) return 'var(--hw-faint)';
  if (/^(core\.thread|hedwig\.timeline)$/.test(id)) return 'var(--hw-muted)';
  if (getView(id)?.pluginId || /context|sidebar/i.test(id)) return 'var(--hw-teal)';
  return 'var(--hw-faint)';
}

function basis(size, dir) {
  if (size == null) return { flex: '1 1 0' };
  return { flex: `0 1 ${((size / (dir === 'row' ? REF_W : REF_H)) * 100).toFixed(2)}%` };
}

// Boxes for a tree. `labelled` draws pane cards with titles (the big preview); otherwise solid
// swatches (template cards).
export function MiniPreview({ node, labelled = false, selectedKey }) {
  if (!node) return null;
  if (node.type === 'split') {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: node.dir, gap: labelled ? 6 : 3 }}>
        {node.children.map((c, i) => (
          <div key={c.key || i} style={{ display: 'flex', minWidth: 0, minHeight: 0, ...basis(node.sizes?.[i], node.dir) }}>
            <MiniPreview node={c} labelled={labelled} selectedKey={selectedKey} />
          </div>
        ))}
      </div>
    );
  }
  if (node.type === 'tabs') {
    const active = node.children[node.active] || node.children[0];
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {labelled && <div style={{ fontSize: 10, color: 'var(--hw-muted)', padding: '0 2px 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.children.map((c) => getView(c.id)?.title || c.id).join(' · ')}</div>}
        <MiniPreview node={active} labelled={labelled} selectedKey={selectedKey} />
      </div>
    );
  }
  if (!labelled) return <div style={{ flex: 1, borderRadius: 3, background: tone(node.id) }} />;
  const plugin = Boolean(getView(node.id)?.pluginId);
  const selected = node.key === selectedKey;
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, overflow: 'hidden',
      background: 'var(--hw-surface)', border: `1px solid ${plugin ? 'var(--hw-teal)' : 'var(--hw-border)'}`,
      boxShadow: selected ? '0 0 0 2px var(--hw-ink)' : 'none',
    }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: plugin ? 'var(--hw-teal-text)' : 'var(--hw-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {node.id}{node.follows ? ` · follows ${node.follows}` : ''}
      </span>
      <span style={{ height: 8, width: '70%', borderRadius: 4, background: plugin ? 'var(--hw-teal-tint)' : 'var(--hw-tint)' }} />
      <span style={{ height: 8, width: '55%', borderRadius: 4, background: plugin ? 'var(--hw-teal-tint)' : 'var(--hw-tint)' }} />
    </div>
  );
}

function outlineRows(node, depth = 0, parent = null, index = 0, last = true, out = []) {
  out.push({ node, depth, parent, index, last });
  if (Array.isArray(node.children)) node.children.forEach((c, i) => outlineRows(c, depth + 1, node, i, i === node.children.length - 1, out));
  return out;
}

function describe(row) {
  const { node, parent, index } = row;
  const bits = [];
  if (parent?.type === 'split') bits.push(parent.sizes[index] == null ? 'flex' : `${parent.sizes[index]}px`);
  if (node.type === 'split') bits.unshift(node.dir);
  if (node.follows) bits.push(`follows ${node.follows}`);
  if (node.type === 'view' && getView(node.id)?.pluginId) bits.push('plugin');
  if (node.type === 'view' && !getView(node.id)) bits.push('not available');
  return bits.join(' · ');
}

function SizeField({ parent, index }) {
  const current = parent.sizes[index];
  const [value, setValue] = useState(current == null ? '' : String(current));
  useEffect(() => { setValue(current == null ? '' : String(current)); }, [current]);
  const commit = () => {
    const n = value.trim() === '' ? null : Number(value);
    if (n !== null && !Number.isFinite(n)) { setValue(current == null ? '' : String(current)); return; }
    useShell.getState().edit((t) => M.resizeChild(t, parent.key, index, n));
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hw-muted)' }}>
      {parent.dir === 'row' ? tr('editor.width', 'Width') : tr('editor.height', 'Height')}
      <input
        type="number"
        min={M.MIN_PANE_PX}
        step={10}
        inputMode="numeric"
        value={value}
        placeholder="flex"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        style={{ width: 90, height: 28, padding: '0 8px', border: '1px solid var(--hw-border)', borderRadius: 6, background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'var(--hw-font-mono)', fontSize: 12 }}
      />
      <span>{tr('editor.sizeHint', 'px · empty = flex')}</span>
    </label>
  );
}

function ViewSelect({ value, onChange, label, allowNone = false }) {
  const views = groupedViews();
  const known = views.some((g) => g.views.some((v) => v.id === value));
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hw-muted)' }}>
      {label}
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ height: 28, maxWidth: 220, padding: '0 6px', border: '1px solid var(--hw-border)', borderRadius: 6, background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 12 }}
      >
        {allowNone && <option value="">nothing</option>}
        {value && !known && <option value={value}>{value} (not available)</option>}
        {views.map((g) => (
          <optgroup key={g.group} label={g.label}>
            {g.views.map((v) => <option key={v.id} value={v.id}>{v.title || v.id} — {v.id}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function SelectedControls({ row }) {
  const s = useShell.getState;
  if (!row) return <p style={{ margin: 0, fontSize: 12, color: 'var(--hw-muted)' }}>{tr('editor.selectHint', 'Select a pane in the tree to change it.')}</p>;
  const { node, parent, index } = row;
  const btn = (label, icon, onClick, disabled = false) => (
    <button type="button" className="hw-btn" onClick={onClick} disabled={disabled} style={{ ...ui.button, height: 28, fontSize: 12, padding: '0 8px' }}>
      <Icon name={icon} size={13} />{label}
    </button>
  );
  const isView = node.type === 'view';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {isView && <ViewSelect label="View" value={node.id} onChange={(id) => id && s().replaceView(node.key, id)} />}
      {node.type === 'split' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hw-muted)' }}>
          Direction
          <select value={node.dir} onChange={(e) => s().edit((t) => M.setDirection(t, node.key, e.target.value))} style={{ height: 28, padding: '0 6px', border: '1px solid var(--hw-border)', borderRadius: 6, background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 12 }}>
            <option value="row">row (side by side)</option>
            <option value="column">column (stacked)</option>
          </select>
        </label>
      )}
      {parent?.type === 'split' && <SizeField parent={parent} index={index} />}
      {isView && (
        <ViewSelect label="Follows" allowNone value={node.follows || null} onChange={(id) => s().edit((t) => M.setFollows(t, node.key, id))} />
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {btn('Split right', 'split-right', () => s().edit((t) => M.splitPane(t, node.key, 'row', M.view('core.picker'))))}
        {btn('Split down', 'split-down', () => s().edit((t) => M.splitPane(t, node.key, 'column', M.view('core.picker'))))}
        {isView && btn('Add tab', 'tabs', () => s().edit((t) => M.addTab(t, node.key, M.view('core.picker'))))}
        {btn('Earlier', 'arrow-up', () => s().edit((t) => M.moveBy(t, node.key, -1)), !parent || index === 0)}
        {btn('Later', 'arrow-down', () => s().edit((t) => M.moveBy(t, node.key, 1)), !parent || index === parent.children.length - 1)}
        {btn('Remove', 'close', () => s().closePane(node.key), !parent)}
      </div>
    </div>
  );
}

function Outline({ tree, selectedKey, onSelect }) {
  const rows = outlineRows(tree);
  const drag = useRef(null);
  const onDrop = (e, target) => {
    e.preventDefault();
    const key = drag.current;
    drag.current = null;
    if (!key || key === target.node.key) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const dir = target.parent?.type === 'split' ? target.parent.dir : 'row';
    const where = target.parent?.type === 'tabs' ? 'tab' : dir === 'row' ? (before ? 'left' : 'right') : (before ? 'top' : 'bottom');
    useShell.getState().edit((t) => M.movePane(t, key, target.node.key, where));
  };
  return (
    <div role="tree" aria-label={tr('editor.tree', 'Pane tree')} style={{ ...ui.card, padding: '10px 8px', fontFamily: 'var(--hw-font-mono)', fontSize: 12, lineHeight: 1.7, display: 'flex', flexDirection: 'column' }}>
      {rows.map((row) => {
        const { node, depth, last } = row;
        const selected = node.key === selectedKey;
        const label = node.type === 'view' ? 'view' : node.type;
        const name = node.type === 'view' ? node.id : '';
        const plugin = node.type === 'view' && getView(node.id)?.pluginId;
        return (
          <button
            key={node.key}
            type="button"
            role="treeitem"
            aria-selected={selected}
            aria-level={depth + 1}
            draggable={node.type === 'view'}
            onDragStart={(e) => { drag.current = node.key; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={(e) => onDrop(e, row)}
            onClick={() => onSelect(node.key)}
            className="hw-row"
            style={{
              display: 'flex', alignItems: 'baseline', gap: 6, padding: `1px 8px 1px ${8 + depth * 16}px`, border: 0, borderRadius: 6,
              background: selected ? 'var(--hw-tint)' : 'transparent', color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 12,
              textAlign: 'left', cursor: 'pointer', boxShadow: selected ? 'inset 2px 0 0 var(--hw-ink)' : 'none',
            }}
          >
            {depth > 0 && <span aria-hidden style={{ color: 'var(--hw-faint)' }}>{last ? '└' : '├'}</span>}
            <span>{label}</span>
            {name && <strong style={{ color: plugin ? 'var(--hw-teal)' : 'var(--hw-ink)' }}>{name}</strong>}
            <span style={{ color: 'var(--hw-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describe(row)}</span>
          </button>
        );
      })}
    </div>
  );
}

function SavedLayouts() {
  const rows = useShell((s) => s.rows);
  const device = useShell((s) => s.device);
  const name = useShell((s) => s.name);
  const saveState = useShell((s) => s.saveState);
  const [newName, setNewName] = useState('');
  const saved = rows.filter((r) => r.device === device);
  return (
    <div style={{ ...ui.card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={ui.label}>Saved · {device}</div>
        <span style={{ flex: 1 }} />
        <span role="status" style={{ fontSize: 11, color: saveState === 'error' ? 'var(--hw-red)' : 'var(--hw-muted)' }}>
          {saveState === 'error' ? 'Not saved — the server refused it' : saveState === 'idle' ? 'Saved' : 'Saving…'}
        </span>
      </div>
      {saved.length === 0 && <span style={{ fontSize: 12, color: 'var(--hw-muted)' }}>Nothing saved for this device yet. Changes save automatically as “{name}”.</span>}
      {saved.map((r) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: r.name === name ? 600 : 400 }}>
            {r.name}{r.is_active ? ' · active' : ''}
          </span>
          {r.name !== name && (
            <button type="button" className="hw-btn" onClick={() => useShell.getState().applySaved(r)} style={{ ...ui.button, height: 26, fontSize: 12, padding: '0 8px' }}>{tr('editor.use', 'Use')}</button>
          )}
          <button type="button" className="hw-btn" aria-label={`Delete ${r.name}`} onClick={() => useShell.getState().deleteSaved(r)} style={{ ...ui.button, height: 26, fontSize: 12, padding: '0 8px' }}>{tr('editor.delete', 'Delete')}</button>
        </div>
      ))}
      <form
        onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { useShell.getState().saveAs(newName); setNewName(''); } }}
        style={{ display: 'flex', gap: 6, marginTop: 4 }}
      >
        <input
          aria-label={tr('editor.saveAsLabel', 'Save the current layout as')}
          value={newName}
          maxLength={80}
          placeholder={tr('editor.saveAsPlaceholder', 'Save current layout as…')}
          onChange={(e) => setNewName(e.target.value)}
          style={{ flex: 1, minWidth: 0, height: 28, padding: '0 8px', border: '1px solid var(--hw-border)', borderRadius: 6, background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 12 }}
        />
        <button type="submit" className="hw-btn" disabled={!newName.trim()} style={{ ...ui.primaryButton, height: 28, fontSize: 12 }}>{tr('editor.save', 'Save')}</button>
      </form>
    </div>
  );
}

export default function LayoutEditor() {
  useRegistryVersion();
  const tree = useShell((s) => s.tree);
  const name = useShell((s) => s.name);
  const templateId = useShell((s) => s.templateId);
  const device = useShell((s) => s.device);
  const [selectedKey, setSelectedKey] = useState(null);
  const [message, setMessage] = useState(null);
  const fileRef = useRef(null);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!tree) return null;
  const rows = outlineRows(tree);
  const selected = rows.find((r) => r.node.key === selectedKey) || null;
  const density = tree.density || 'default';

  const addView = (id) => {
    const target = selected?.node.key || tree.key;
    const node = M.view(id);
    const dir = selected?.parent?.type === 'split' ? selected.parent.dir : 'row';
    useShell.getState().edit((t) => M.splitPane(t, target, dir, node));
    setSelectedKey(node.key);
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await importLayoutFile(file);
      setMessage({ ok: true, text: `Imported “${imported}”.` });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  const chips = listViews().filter((v) => !v.hidden).sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'transparent', color: 'var(--hw-ink)', fontFamily: 'var(--hw-font-body)', fontSize: 13 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px 32px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ ...ui.display, margin: 0, fontSize: 20 }}>{tr('editor.title', 'Layouts')}</h1>
          <span style={{ fontSize: 12, color: 'var(--hw-muted)' }}>{tr('editor.caption', 'A layout is a tree of panes; each pane hosts a view. Saved per device.')}</span>
          <span style={{ flex: 1 }} />
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onImport} style={{ display: 'none' }} />
          <button type="button" className="hw-btn" onClick={() => fileRef.current?.click()} style={ui.button}><Icon name="import" size={14} />{tr('editor.import', 'Import JSON')}</button>
          <button type="button" className="hw-btn" onClick={exportCurrentLayout} style={ui.button}><Icon name="export" size={14} />{tr('editor.export', 'Export')}</button>
        </div>
        {message && <div role="status" style={{ fontSize: 12, color: message.ok ? 'var(--hw-teal-text)' : 'var(--hw-red)' }}>{message.text}</div>}

        <section aria-label={tr('editor.templates', 'Templates')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={ui.label}>Templates · {device}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {TEMPLATES.map((t) => {
              const active = templateId === t.id && name === t.label;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { useShell.getState().applyTemplate(t.id); setSelectedKey(null); }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                    border: `1px solid ${active ? 'var(--hw-accent)' : 'var(--hw-border)'}`, boxShadow: active ? 'inset 0 0 0 1px var(--hw-accent)' : 'none',
                    background: 'var(--hw-surface)', color: 'var(--hw-ink)', fontFamily: 'inherit',
                  }}
                >
                  <div aria-hidden style={{ height: 64, display: 'flex', padding: 4, borderRadius: 6, background: 'var(--hw-raised)' }}>
                    <MiniPreview node={buildTemplate(t.id)} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--hw-muted)' }}>{t.note}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px', maxWidth: 420, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Tree · {name}</h2>
              <span style={{ fontSize: 12, color: 'var(--hw-muted)' }}>{tr('editor.treeHint', 'drag to reorder · split any pane')}</span>
            </div>
            <Outline tree={tree} selectedKey={selectedKey} onSelect={setSelectedKey} />
            <div style={{ ...ui.card, padding: '12px 14px' }}>
              <div style={{ ...ui.label, marginBottom: 8 }}>{selected ? `Selected · ${selected.node.type === 'view' ? selected.node.id : selected.node.type}` : 'Selected pane'}</div>
              <SelectedControls row={selected} />
            </div>
            <div style={{ ...ui.card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={ui.label}>{tr('editor.addView', 'Add a view')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {chips.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="hw-chip"
                    onClick={() => addView(v.id)}
                    title={`${v.title || v.id} — add ${selected ? 'next to the selected pane' : 'to the layout'}`}
                    style={{ ...ui.chip(false), padding: '4px 9px', borderColor: v.pluginId ? 'var(--hw-teal)' : 'var(--hw-border)', color: v.pluginId ? 'var(--hw-teal-text)' : 'var(--hw-ink)' }}
                  >
                    {v.id}
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-label={tr('editor.density', 'Density')} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hw-muted)', flexWrap: 'wrap' }}>
              <span>{tr('editor.density', 'Density')}</span>
              {['compact', 'comfortable', 'spacious'].map((d) => (
                <button key={d} type="button" aria-pressed={density === d} className="hw-chip" onClick={() => useShell.getState().edit((t) => M.setMeta(t, { density: density === d ? null : d }))} style={{ ...ui.chip(density === d), padding: '2px 8px' }}>
                  {d}
                </button>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hw-muted)' }}>
              <input type="checkbox" checked={Boolean(tree.headers)} onChange={(e) => useShell.getState().edit((t) => M.setMeta(t, { headers: e.target.checked || null }))} />
              {tr('editor.headers', 'Always show pane headers')}
            </label>
            <SavedLayouts />
          </div>

          <div style={{ flex: '2 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{tr('editor.preview', 'Preview')}</h2>
              <span style={{ fontSize: 12, color: 'var(--hw-muted)' }}>{vp.w} × {vp.h} · {device}</span>
            </div>
            <div aria-hidden style={{ aspectRatio: `${vp.w} / ${Math.max(1, vp.h - 48)}`, maxHeight: 560, display: 'flex', padding: 8, borderRadius: 12, background: 'var(--hw-raised)', border: '1px solid var(--hw-border)' }}>
              <MiniPreview node={tree} labelled selectedKey={selectedKey} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
