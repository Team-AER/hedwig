// Customize layout (view 'hedwig.layouts', opened from the View menu): pick a starting layout,
// the panes in reading order (add, remove, move, resize, change the view; drag to reorder), arrange
// on screen, density, name and save, the saved layouts (use, delete), export and import as JSON,
// and "Reset to Streams". Edits apply to the layout on screen at once and are saved like any other
// layout change. Sections are 14px sheets with SectionLabel headings; controls are IconButtons.
import { useEffect, useRef, useState } from 'react';
import { getView } from '../registry.js';
import { Icon } from '../icons.jsx';
import * as M from './model.js';
import { useShell } from './state.js';
import { HEDWIG_TEMPLATES, buildTemplate, DEFAULT_TEMPLATE } from './templates.js';
import { savedLayoutsFor } from './layouts.js';
import { exportCurrentLayout, importLayoutFile } from './layoutFile.js';
import { useRegistryVersion, groupedViews } from './useRegistry.js';
import { viewMenuItems } from './viewMenu.js';
import { MenuButton } from './Menu.jsx';
import { Btn, IconButton, SectionLabel, V } from '../v2/primitives.jsx';
import { tr } from './tr.js';

const REF_W = 1440;
const REF_H = 900;

function titleOf(id) {
  return getView(id)?.title || id;
}

function tone(id) {
  if (id === 'hedwig.rail' || id === 'core.nav') return V.accentTint;
  if (id === 'hedwig.thread' || id === 'core.thread') return V.select;
  return V.field;
}

function basis(size, dir) {
  if (size == null) return { flex: '1 1 0' };
  return { flex: `0 1 ${((size / (dir === 'row' ? REF_W : REF_H)) * 100).toFixed(2)}%` };
}

// Boxes for a tree. `labelled` draws each pane with its title (the preview); otherwise swatches
// (the starting-layout cards).
export function MiniPreview({ node, labelled = false, selectedKey }) {
  if (!node) return null;
  if (node.type === 'split') {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: node.dir, gap: labelled ? 4 : 2 }}>
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
    return <MiniPreview node={active} labelled={labelled} selectedKey={selectedKey} />;
  }
  if (!labelled) return <div style={{ flex: 1, borderRadius: 3, background: tone(node.id), boxShadow: `inset 0 0 0 .5px ${V.line2}` }} />;
  const selected = node.key === selectedKey;
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 4, padding: '6px 7px', borderRadius: 6, overflow: 'hidden',
      background: tone(node.id), boxShadow: selected ? `inset 0 0 0 1.5px ${V.accent}` : `inset 0 0 0 .5px ${V.line2}`,
      color: V.ink, fontSize: 11, lineHeight: '14px', fontWeight: 500,
    }}>
      <span aria-hidden="true" style={{ display: 'inline-flex', color: V.muted, flexShrink: 0 }}><Icon name={getView(node.id)?.icon || 'grid'} size={12} /></span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleOf(node.id)}</span>
    </div>
  );
}

function Section({ label, action, children, style }) {
  return (
    <section aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
        <SectionLabel as="h2" style={{ padding: '0 2px', flex: 1 }}>{label}</SectionLabel>
        {action}
      </div>
      <div style={{ marginTop: 6, padding: 12, borderRadius: 14, background: V.content, boxShadow: `0 0 0 .5px ${V.line2}`, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {children}
      </div>
    </section>
  );
}

function outlineRows(node, depth = 0, parent = null, index = 0, out = []) {
  out.push({ node, depth, parent, index });
  if (Array.isArray(node.children)) node.children.forEach((c, i) => outlineRows(c, depth + 1, node, i, out));
  return out;
}

function sizeText(row) {
  const { parent, index } = row;
  if (parent?.type !== 'split') return '';
  const px = parent.sizes[index];
  return px == null ? tr('editor.fills', 'fills the rest') : `${px} px`;
}

function groupLabel(node) {
  if (node.type === 'tabs') return tr('editor.tabs', 'Tabs');
  return node.dir === 'row' ? tr('editor.sideBySide', 'Side by side') : tr('editor.stacked', 'Stacked');
}

const fieldStyle = {
  height: 28, padding: '0 8px', border: `1px solid ${V.line2}`, borderRadius: 8, background: V.content, color: V.ink,
  fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box',
};

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
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: V.muted }}>
      <span style={{ width: 64 }}>{parent.dir === 'row' ? tr('editor.width', 'Width') : tr('editor.height', 'Height')}</span>
      <input
        type="number"
        min={M.MIN_PANE_PX}
        step={10}
        inputMode="numeric"
        value={value}
        placeholder={tr('editor.fillsShort', 'fills')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        style={{ ...fieldStyle, width: 96, fontVariantNumeric: 'tabular-nums' }}
      />
      <span style={{ fontSize: 12 }}>{tr('editor.sizeHint2', 'px · empty fills the rest')}</span>
    </label>
  );
}

function ViewSelect({ value, onChange, label, allowNone = false }) {
  const views = groupedViews();
  const known = views.some((g) => g.views.some((v) => v.id === value));
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: V.muted }}>
      <span style={{ width: 64 }}>{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} style={{ ...fieldStyle, flex: 1, minWidth: 0, maxWidth: 280 }}>
        {allowNone && <option value="">{tr('editor.nothing', 'Nothing')}</option>}
        {value && !known && <option value={value}>{tr('editor.unavailable', '{{id}} (not available)', { id: value })}</option>}
        {views.map((g) => (
          <optgroup key={g.group} label={g.label}>
            {g.views.map((v) => <option key={v.id} value={v.id}>{v.title || v.id}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function SelectedControls({ row }) {
  const s = useShell.getState;
  const { node, parent, index } = row;
  const isView = node.type === 'view';
  return (
    <div data-editor-selected="" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 10px 12px', borderRadius: 10, background: V.field }}>
      {isView && <ViewSelect label={tr('editor.view', 'View')} value={node.id} onChange={(id) => id && s().replaceView(node.key, id)} />}
      {node.type === 'split' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: V.muted }}>
          <span style={{ width: 64 }}>{tr('editor.direction', 'Direction')}</span>
          <select value={node.dir} onChange={(e) => s().edit((t) => M.setDirection(t, node.key, e.target.value))} style={fieldStyle}>
            <option value="row">{tr('editor.sideBySide', 'Side by side')}</option>
            <option value="column">{tr('editor.stacked', 'Stacked')}</option>
          </select>
        </label>
      )}
      {parent?.type === 'split' && <SizeField parent={parent} index={index} />}
      {isView && (node.follows || node.id === 'hedwig.context') && (
        <ViewSelect label={tr('editor.follows', 'Follows')} allowNone value={node.follows || null} onChange={(id) => s().edit((t) => M.setFollows(t, node.key, id))} />
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn onClick={() => s().edit((t) => M.splitPane(t, node.key, 'row', M.view('core.picker')))}><Icon name="split-right" size={14} />{tr('editor.splitRight', 'Split right')}</Btn>
        <Btn onClick={() => s().edit((t) => M.splitPane(t, node.key, 'column', M.view('core.picker')))}><Icon name="split-down" size={14} />{tr('editor.splitDown', 'Split down')}</Btn>
        {isView && <Btn onClick={() => s().edit((t) => M.addTab(t, node.key, M.view('core.picker')))}><Icon name="tabs" size={14} />{tr('editor.addTab', 'Add tab')}</Btn>}
      </div>
    </div>
  );
}

function PaneList({ tree, selectedKey, onSelect }) {
  const rows = outlineRows(tree);
  const drag = useRef(null);
  const s = useShell.getState;
  const onDrop = (e, target) => {
    e.preventDefault();
    const key = drag.current;
    drag.current = null;
    if (!key || key === target.node.key) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const dir = target.parent?.type === 'split' ? target.parent.dir : 'row';
    const where = target.parent?.type === 'tabs' ? 'tab' : dir === 'row' ? (before ? 'left' : 'right') : (before ? 'top' : 'bottom');
    s().edit((t) => M.movePane(t, key, target.node.key, where));
  };
  const selected = rows.find((r) => r.node.key === selectedKey) || null;
  return (
    <div role="list" aria-label={tr('editor.panes', 'Panes')} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {rows.map((row) => {
        const { node, depth, parent, index } = row;
        const on = node.key === selectedKey;
        const isView = node.type === 'view';
        const count = parent ? parent.children.length : 0;
        const missing = isView && !getView(node.id);
        return (
          <div key={node.key} role="listitem" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              draggable={isView}
              onDragStart={(e) => { drag.current = node.key; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
              onDrop={(e) => onDrop(e, row)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, minHeight: 32, padding: `0 4px 0 ${6 + depth * 16}px`, borderRadius: 8,
                background: on ? V.select : 'transparent',
              }}
            >
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSelect(on ? null : node.key)}
                style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: 0, border: 0, background: 'transparent', color: V.ink, fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}
              >
                <span aria-hidden="true" style={{ display: 'inline-flex', color: isView ? V.accent : V.muted, flexShrink: 0 }}>
                  <Icon name={isView ? (getView(node.id)?.icon || 'grid') : (node.type === 'tabs' ? 'tabs' : node.dir === 'row' ? 'split-right' : 'split-down')} size={14} />
                </span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isView ? 500 : 400, color: isView ? V.ink : V.muted }}>
                  {isView ? titleOf(node.id) : groupLabel(node)}
                </span>
                <span style={{ fontSize: 12, color: missing ? V.red : V.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {missing ? tr('editor.notAvailable', 'not available') : sizeText(row)}
                </span>
              </button>
              {parent && (
                <>
                  <IconButton icon={parent.dir === 'column' ? 'arrow-up' : 'chevron-left'} label={tr('editor.earlier', 'Move earlier')} disabled={index === 0} onClick={() => s().edit((t) => M.moveBy(t, node.key, -1))} style={{ color: V.muted, opacity: index === 0 ? 0.35 : 1 }} />
                  <IconButton icon={parent.dir === 'column' ? 'arrow-down' : 'chevron-right'} label={tr('editor.later', 'Move later')} disabled={index === count - 1} onClick={() => s().edit((t) => M.moveBy(t, node.key, 1))} style={{ color: V.muted, opacity: index === count - 1 ? 0.35 : 1 }} />
                  <IconButton icon="close" label={isView ? tr('editor.removeNamed', 'Remove {{title}}', { title: titleOf(node.id) }) : tr('editor.remove', 'Remove')} onClick={() => { s().closePane(node.key); if (on) onSelect(null); }} style={{ color: V.muted }} />
                </>
              )}
            </div>
            {on && selected && <SelectedControls row={selected} />}
          </div>
        );
      })}
    </div>
  );
}

function StartFrom() {
  const name = useShell((s) => s.name);
  const templateId = useShell((s) => s.templateId);
  return (
    <div role="radiogroup" aria-label={tr('editor.startFrom', 'Start from')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
      {HEDWIG_TEMPLATES.map((t) => {
        const active = templateId === t.id && name === t.label;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-template={t.id}
            onClick={() => useShell.getState().applyTemplate(t.id)}
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 10, textAlign: 'left', cursor: 'pointer',
              border: 0, boxShadow: active ? `inset 0 0 0 1.5px ${V.accent}` : `inset 0 0 0 .5px ${V.line2}`,
              background: active ? V.accentTint : 'transparent', color: V.ink, fontFamily: 'inherit',
            }}
          >
            <div aria-hidden="true" style={{ height: 52, display: 'flex', padding: 3, borderRadius: 6, background: V.paper }}>
              <MiniPreview node={buildTemplate(t.id)} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
            <span style={{ fontSize: 12, lineHeight: '16px', color: V.muted }}>{t.description}</span>
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
  const [newName, setNewName] = useState('');
  const saved = savedLayoutsFor(rows, device);
  return (
    <>
      <form
        onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { useShell.getState().saveAs(newName); setNewName(''); } }}
        style={{ display: 'flex', gap: 6 }}
      >
        <input
          aria-label={tr('editor.saveAsLabel', 'Save the current layout as')}
          value={newName}
          maxLength={80}
          placeholder={tr('editor.saveAsPlaceholder2', 'Name this layout')}
          onChange={(e) => setNewName(e.target.value)}
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
        />
        <Btn type="submit" accent disabled={!newName.trim()} style={{ opacity: newName.trim() ? 1 : 0.5 }}>{tr('editor.save', 'Save')}</Btn>
      </form>
      {saved.length === 0
        ? <span style={{ fontSize: 12, color: V.muted }}>{tr('editor.nothingSaved', 'Nothing saved on this {{device}} yet. Changes save automatically as “{{name}}”.', { device, name })}</span>
        : (
          <div role="list" aria-label={tr('editor.savedList', 'Saved layouts')} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {saved.map((r) => (
              <div key={r.id} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 32, padding: '0 4px 0 8px', borderRadius: 8, background: r.name === name ? V.select : 'transparent' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: r.name === name ? 600 : 400 }}>
                  {r.name}
                </span>
                {r.name === name
                  ? <span style={{ fontSize: 12, color: V.muted }}>{tr('editor.onScreen', 'on screen')}</span>
                  : <Btn onClick={() => useShell.getState().applySaved(r)}>{tr('editor.use', 'Use')}</Btn>}
                <IconButton icon="close" label={tr('editor.deleteNamed', 'Delete {{name}}', { name: r.name })} onClick={() => useShell.getState().deleteSaved(r)} style={{ color: V.muted }} />
              </div>
            ))}
          </div>
        )}
    </>
  );
}

function SaveState() {
  const saveState = useShell((s) => s.saveState);
  const text = saveState === 'error' ? tr('editor.notSaved', 'Not saved — the server refused it')
    : saveState === 'idle' ? tr('editor.saved', 'Saved') : tr('editor.saving', 'Saving…');
  return <span role="status" style={{ fontSize: 12, color: saveState === 'error' ? V.red : V.muted, whiteSpace: 'nowrap' }}>{text}</span>;
}

export default function LayoutEditor() {
  useRegistryVersion();
  const tree = useShell((s) => s.tree);
  const name = useShell((s) => s.name);
  const arrange = useShell((s) => s.arrange);
  const [selectedKey, setSelectedKey] = useState(null);
  const [message, setMessage] = useState(null);
  const fileRef = useRef(null);

  if (!tree) return null;
  const selected = outlineRows(tree).find((r) => r.node.key === selectedKey) || null;
  const density = tree.density || null;

  const addView = (id) => {
    const target = selected?.node.key || tree.key;
    const node = M.view(id);
    const dir = selected?.parent?.type === 'split' ? selected.parent.dir : (tree.type === 'split' ? tree.dir : 'row');
    useShell.getState().edit((t) => M.splitPane(t, target, dir, node));
    setSelectedKey(node.key);
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await importLayoutFile(file);
      setMessage({ ok: true, text: tr('editor.imported', 'Imported “{{name}}”.', { name: imported }) });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };

  const reset = () => { useShell.getState().applyTemplate(DEFAULT_TEMPLATE); setSelectedKey(null); };

  return (
    <div className="hw-v2 hw-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', color: V.ink, fontFamily: V.sans, fontSize: 13 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '14px 16px 28px', minWidth: 0, maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 17, lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tr('editor.heading', 'Customize “{{name}}”', { name })}
          </h1>
          <span style={{ flex: 1 }} />
          <SaveState />
        </div>

        <Section label={tr('editor.startFrom', 'Start from')} action={<Btn onClick={reset}>{tr('editor.reset', 'Reset to Streams')}</Btn>}>
          <StartFrom />
        </Section>

        <Section
          label={tr('editor.panes', 'Panes')}
          action={(
            <MenuButton
              label={tr('editor.addPane', 'Add pane')}
              items={() => viewMenuItems(null, addView)}
              align="right"
              width={240}
              buttonClassName="hw-btn"
              buttonStyle={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 8, border: `1px solid ${V.line2}`, background: 'transparent', color: V.ink, fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              <Icon name="plus" size={14} />{tr('editor.addPane', 'Add pane')}
            </MenuButton>
          )}
        >
          <div aria-hidden="true" style={{ aspectRatio: `${REF_W} / ${REF_H - 40}`, maxHeight: 220, display: 'flex', padding: 6, borderRadius: 10, background: V.paper }}>
            <MiniPreview node={tree} labelled selectedKey={selectedKey} />
          </div>
          <PaneList tree={tree} selectedKey={selectedKey} onSelect={setSelectedKey} />
          <span style={{ fontSize: 12, color: V.muted }}>
            {tr('editor.panesHint', 'Select a pane to change its view or size. Drag a pane onto another to move it. New panes go beside the selected one.')}
          </span>
        </Section>

        <Section label={tr('editor.display', 'Display')}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={arrange} onChange={() => useShell.getState().toggleArrange()} style={{ marginTop: 2 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span>{tr('editor.arrange', 'Arrange panes')}</span>
              <span style={{ fontSize: 12, color: V.muted }}>{tr('editor.arrangeHint', 'Shows a header on every pane to change, split, pop out or close it in place.')}</span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(tree.headers)} onChange={(e) => useShell.getState().edit((t) => M.setMeta(t, { headers: e.target.checked || null }))} style={{ marginTop: 2 }} />
            <span>{tr('editor.headers', 'Always show pane headers')}</span>
          </label>
          <div role="radiogroup" aria-label={tr('editor.density', 'Row density')} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, width: 96 }}>{tr('editor.density', 'Row density')}</span>
            <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: V.field }}>
              {[[null, tr('editor.densityDefault', 'Default')], ['compact', tr('editor.compact', 'Compact')], ['comfortable', tr('editor.comfortable', 'Comfortable')], ['spacious', tr('editor.spacious', 'Spacious')]].map(([d, label]) => (
                <button
                  key={d || 'default'}
                  type="button"
                  role="radio"
                  aria-checked={density === d}
                  onClick={() => useShell.getState().edit((t) => M.setMeta(t, { density: d }))}
                  style={{
                    height: 24, padding: '0 10px', border: 0, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                    fontWeight: density === d ? 600 : 500, color: V.ink,
                    background: density === d ? V.content : 'transparent',
                    boxShadow: density === d ? `0 0 0 .5px ${V.line2}, 0 1px 2px rgba(0,0,0,.08)` : 'none',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section label={tr('editor.saveSection', 'Save')}>
          <SavedLayouts />
        </Section>

        <Section label={tr('editor.share', 'Export and import')}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={onImport} style={{ display: 'none' }} />
            <Btn onClick={exportCurrentLayout}><Icon name="export" size={14} />{tr('editor.exportJson', 'Export as JSON')}</Btn>
            <Btn onClick={() => fileRef.current?.click()}><Icon name="import" size={14} />{tr('editor.importJson', 'Import JSON…')}</Btn>
          </div>
          {message && <span role="status" style={{ fontSize: 12, color: message.ok ? V.muted : V.red }}>{message.text}</span>}
        </Section>
      </div>
    </div>
  );
}
