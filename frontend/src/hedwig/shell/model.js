// Pane tree model. Pure functions over plain JSON so layouts round-trip through
// PUT /api/hedwig/layouts unchanged and every operation is unit-testable without a DOM.
//
// Nodes:
//   { type: 'split', dir: 'row'|'column', sizes: [px|null], defaults?: [px|null], children }
//   { type: 'tabs', active: index, children: [view nodes] }
//   { type: 'view', id: viewId, props?: {}, follows?: viewId }
// Every node also carries `key`, a stable pane id the shell uses for focus and view requests.
// `sizes[i]` is a fixed size in px for child i, or null to share the remaining space; at least
// one child of every split is flexible. `defaults` holds the sizes a double-click restores.
// The root node may carry layout-wide settings: `density` and `headers`, and `version`, which the
// shell stamps on every tree it shows (LAYOUT_VERSION) so a layout saved before v2 can be told apart.
//
// Operations never mutate their input; each returns a normalised tree (or the input unchanged
// when the operation would produce a tree the backend would reject).

export const MAX_DEPTH = 8;
export const MAX_SPLIT_CHILDREN = 8;
export const MAX_TABS = 12;
export const MIN_PANE_PX = 120;
export const MAX_PANE_PX = 4000;
export const DENSITIES = ['compact', 'comfortable', 'spacious'];
const ROOT_META = ['density', 'headers', 'version'];
export const LAYOUT_VERSION = 2;

// Mirror of validTree in backend/src/hedwig/core/index.js. Keep the two in step: the shell
// validates before saving so a layout the server would 400 never leaves the browser.
export function validTree(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (node.type === 'view') return typeof node.id === 'string' && node.id.length < 128;
  if (node.type === 'split') {
    return ['row', 'column'].includes(node.dir) && Array.isArray(node.children)
      && node.children.length >= 1 && node.children.length <= 8
      && node.children.every((c) => validTree(c, depth + 1));
  }
  if (node.type === 'tabs') {
    return Array.isArray(node.children) && node.children.length >= 1 && node.children.length <= 12
      && node.children.every((c) => validTree(c, depth + 1));
  }
  return false;
}

let seq = 0;
export function newKey() {
  seq = (seq + 1) % 1679616;
  return 'p' + Math.random().toString(36).slice(2, 7) + seq.toString(36);
}

export function view(id, extra = {}) {
  return { type: 'view', key: newKey(), id, ...extra };
}

export function split(dir, children, sizes) {
  const s = sizes || children.map(() => null);
  return { type: 'split', key: newKey(), dir, sizes: s, defaults: [...s], children };
}

export function tabs(children, active = 0) {
  return { type: 'tabs', key: newKey(), active, children };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function cleanSize(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(MAX_PANE_PX, Math.max(MIN_PANE_PX, v)));
}

function viewLeaves(node) {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'view') return [node];
  if (Array.isArray(node.children)) return node.children.flatMap(viewLeaves);
  return [];
}

function normaliseView(node) {
  if (typeof node.id !== 'string' || !node.id || node.id.length >= 128) return null;
  const out = { type: 'view', key: typeof node.key === 'string' && node.key ? node.key : newKey(), id: node.id };
  if (isPlainObject(node.props) && Object.keys(node.props).length) out.props = node.props;
  if (typeof node.follows === 'string' && node.follows) out.follows = node.follows;
  return out;
}

function normaliseNode(node, depth) {
  if (!isPlainObject(node) || depth > MAX_DEPTH) return null;
  if (node.type === 'view') return normaliseView(node);

  if (node.type === 'tabs') {
    // Tabs hold views only; anything nested collapses to its view leaves.
    const children = (Array.isArray(node.children) ? node.children : [])
      .flatMap(viewLeaves).map(normaliseView).filter(Boolean).slice(0, MAX_TABS);
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const active = Number.isInteger(node.active) ? Math.min(children.length - 1, Math.max(0, node.active)) : 0;
    return { type: 'tabs', key: typeof node.key === 'string' && node.key ? node.key : newKey(), active, children };
  }

  if (node.type === 'split') {
    const dir = node.dir === 'column' ? 'column' : 'row';
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    const sizes = Array.isArray(node.sizes) ? node.sizes : [];
    const defaults = Array.isArray(node.defaults) ? node.defaults : sizes;
    let entries = [];
    rawChildren.forEach((child, i) => {
      const n = normaliseNode(child, depth + 1);
      if (!n) return;
      if (n.type === 'split' && n.dir === dir) {
        // A split inside a split of the same direction adds nothing: lift its children.
        n.children.forEach((c, j) => entries.push({ node: c, size: n.sizes[j], def: n.defaults?.[j] ?? null }));
      } else {
        entries.push({ node: n, size: cleanSize(sizes[i]), def: cleanSize(defaults[i]) });
      }
    });
    entries = entries.slice(0, MAX_SPLIT_CHILDREN);
    if (!entries.length) return null;
    if (entries.length === 1) return entries[0].node;
    if (entries.every((e) => e.size != null)) {
      // At least one pane must absorb leftover space; the widest fixed one is the natural pick.
      let widest = 0;
      entries.forEach((e, i) => { if (e.size > entries[widest].size) widest = i; });
      entries[widest] = { ...entries[widest], size: null };
    }
    return {
      type: 'split',
      key: typeof node.key === 'string' && node.key ? node.key : newKey(),
      dir,
      sizes: entries.map((e) => e.size),
      defaults: entries.map((e) => e.def),
      children: entries.map((e) => e.node),
    };
  }
  return null;
}

// Normalise a whole tree: keys assigned, sizes aligned and clamped, redundant splits and single
// tabs collapsed, invalid nodes dropped. Root-level settings survive a root collapse. Returns
// null when nothing valid remains.
export function normalise(tree) {
  if (!isPlainObject(tree)) return null;
  const out = normaliseNode(tree, 0);
  if (!out) return null;
  for (const k of ROOT_META) {
    if (tree[k] !== undefined) out[k] = tree[k];
  }
  if (out.density !== undefined && !DENSITIES.includes(out.density)) delete out.density;
  if (out.headers !== undefined && typeof out.headers !== 'boolean') delete out.headers;
  if (out.version !== undefined && !Number.isInteger(out.version)) delete out.version;
  return out;
}

function copyMeta(from, to) {
  if (!to) return to;
  const out = { ...to };
  for (const k of ROOT_META) {
    if (from?.[k] !== undefined) out[k] = from[k];
    else delete out[k];
  }
  return out;
}

// ── Queries ─────────────────────────────────────────────────────────────────

// { node, parent, index, depth } for the node with this key, or null.
export function findNode(tree, key, parent = null, index = -1, depth = 0) {
  if (!tree) return null;
  if (tree.key === key) return { node: tree, parent, index, depth };
  if (Array.isArray(tree.children)) {
    for (let i = 0; i < tree.children.length; i++) {
      const hit = findNode(tree.children[i], key, tree, i, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// Every view node in reading order. `visible` is false for tabs that are not the active one.
export function listPanes(tree, visible = true, out = []) {
  if (!tree) return out;
  if (tree.type === 'view') out.push({ node: tree, visible });
  else if (tree.type === 'tabs') tree.children.forEach((c, i) => listPanes(c, visible && i === tree.active, out));
  else if (Array.isArray(tree.children)) tree.children.forEach((c) => listPanes(c, visible, out));
  return out;
}

export function panesHosting(tree, viewId) {
  return listPanes(tree).filter((p) => p.node.id === viewId).map((p) => p.node.key);
}

export function treeDepth(node) {
  if (!node || !Array.isArray(node.children)) return 0;
  return 1 + Math.max(0, ...node.children.map(treeDepth));
}

export function countPanes(tree) {
  return listPanes(tree).length;
}

// The next or previous visible pane key from `key`, wrapping around.
export function neighbourPane(tree, key, delta) {
  const panes = listPanes(tree).filter((p) => p.visible).map((p) => p.node.key);
  if (!panes.length) return null;
  const i = panes.indexOf(key);
  if (i < 0) return panes[delta < 0 ? panes.length - 1 : 0];
  return panes[(i + delta + panes.length) % panes.length];
}

// ── Structural edits ────────────────────────────────────────────────────────

// Rebuild the tree with `fn(node)` applied to the node with `key`. fn returns a replacement node,
// or null to delete it.
function replaceNode(tree, key, fn) {
  if (!tree) return tree;
  if (tree.key === key) return fn(tree);
  if (!Array.isArray(tree.children)) return tree;
  let changed = false;
  const nextChildren = [];
  const nextSizes = [];
  const nextDefaults = [];
  tree.children.forEach((c, i) => {
    const r = replaceNode(c, key, fn);
    if (r !== c) changed = true;
    if (r) {
      nextChildren.push(r);
      nextSizes.push(tree.sizes?.[i] ?? null);
      nextDefaults.push(tree.defaults?.[i] ?? null);
    }
  });
  if (!changed) return tree;
  const out = { ...tree, children: nextChildren };
  if (tree.type === 'split') { out.sizes = nextSizes; out.defaults = nextDefaults; }
  if (tree.type === 'tabs' && nextChildren.length < tree.children.length) {
    const removed = tree.children.findIndex((c) => c.key === key);
    let active = tree.active;
    if (removed > -1 && removed < active) active -= 1;
    out.active = Math.max(0, Math.min(active, nextChildren.length - 1));
  }
  return out;
}

function commit(original, next) {
  const n = normalise(copyMeta(original, next));
  return n && validTree(n) ? n : original;
}

// Split the pane `key` in direction `dir`, putting `newNode` after it (or before). When the pane
// already sits in a split of that direction the new pane becomes a sibling; otherwise the pane is
// wrapped in a new split. A pane inside tabs splits the whole tab group.
export function splitPane(tree, key, dir, newNode, { before = false } = {}) {
  const hit = findNode(tree, key);
  if (!hit) return tree;
  if (hit.parent?.type === 'tabs') return splitPane(tree, hit.parent.key, dir, newNode, { before });
  const incoming = normaliseNode(newNode, 0);
  if (!incoming) return tree;
  if (hit.parent?.type === 'split' && hit.parent.dir === dir && hit.parent.children.length >= MAX_SPLIT_CHILDREN) {
    // A full row cannot take another column (a nested row would be flattened straight back
    // into it), so the new pane stacks as a tab with the one being split.
    return addTab(tree, key, incoming);
  }
  if (hit.parent?.type === 'split' && hit.parent.dir === dir) {
    const p = hit.parent;
    const at = before ? hit.index : hit.index + 1;
    const next = replaceNode(tree, p.key, (node) => ({
      ...node,
      children: [...node.children.slice(0, at), incoming, ...node.children.slice(at)],
      sizes: [...node.sizes.slice(0, at), null, ...node.sizes.slice(at)],
      defaults: [...(node.defaults || node.sizes).slice(0, at), null, ...(node.defaults || node.sizes).slice(at)],
    }));
    return kept(tree, commit(tree, next), incoming.key);
  }
  const next = replaceNode(tree, key, (node) => ({
    type: 'split', key: newKey(), dir,
    sizes: [null, null], defaults: [null, null],
    children: before ? [incoming, node] : [node, incoming],
  }));
  return kept(tree, commit(tree, next), incoming.key);
}

// An edit that would push a pane past the depth limit gets it dropped by normalise; treat that
// as a refused edit rather than silently losing the pane.
function kept(original, next, key) {
  return findNode(next, key) ? next : original;
}

// Remove a pane. Returns null when it was the last one.
export function closePane(tree, key) {
  if (!findNode(tree, key)) return tree;
  if (tree.key === key) return null;
  const next = replaceNode(tree, key, () => null);
  const n = normalise(copyMeta(tree, next));
  return n && validTree(n) ? n : null;
}

// Point the pane at a different view. Props and follows reset unless given.
export function replaceView(tree, key, viewId, props, follows) {
  const next = replaceNode(tree, key, (node) => {
    if (node.type !== 'view') return node;
    const out = { type: 'view', key: node.key, id: viewId };
    if (props && Object.keys(props).length) out.props = props;
    if (follows) out.follows = follows;
    return out;
  });
  return commit(tree, next);
}

export function updateProps(tree, key, props, { merge = true } = {}) {
  const next = replaceNode(tree, key, (node) => {
    if (node.type !== 'view') return node;
    const merged = merge ? { ...(node.props || {}), ...(props || {}) } : { ...(props || {}) };
    const out = { ...node, props: merged };
    if (!Object.keys(merged).length) delete out.props;
    return out;
  });
  return commit(tree, next);
}

export function setFollows(tree, key, follows) {
  const next = replaceNode(tree, key, (node) => {
    const out = { ...node };
    if (follows) out.follows = follows; else delete out.follows;
    return out;
  });
  return commit(tree, next);
}

export function setDirection(tree, splitKey, dir) {
  if (dir !== 'row' && dir !== 'column') return tree;
  const next = replaceNode(tree, splitKey, (node) => (node.type === 'split' ? { ...node, dir } : node));
  return commit(tree, next);
}

export function setSizes(tree, splitKey, sizes) {
  const next = replaceNode(tree, splitKey, (node) => (node.type === 'split' ? { ...node, sizes: node.children.map((_, i) => sizes[i] ?? null) } : node));
  return commit(tree, next);
}

export function resizeChild(tree, splitKey, index, px) {
  const hit = findNode(tree, splitKey);
  if (!hit || hit.node.type !== 'split') return tree;
  const sizes = [...hit.node.sizes];
  sizes[index] = px == null ? null : cleanSize(px);
  return setSizes(tree, splitKey, sizes);
}

// Restore child `index` of a split to its default size (the template's, or flexible).
export function resetSize(tree, splitKey, index) {
  const hit = findNode(tree, splitKey);
  if (!hit || hit.node.type !== 'split') return tree;
  const sizes = [...hit.node.sizes];
  sizes[index] = hit.node.defaults?.[index] ?? null;
  return setSizes(tree, splitKey, sizes);
}

// Swap a pane with its neighbour inside its parent split or tab group.
export function moveBy(tree, key, delta) {
  const hit = findNode(tree, key);
  if (!hit?.parent) return tree;
  const p = hit.parent;
  const j = hit.index + delta;
  if (j < 0 || j >= p.children.length) return tree;
  const swap = (arr) => {
    const a = [...arr];
    [a[hit.index], a[j]] = [a[j], a[hit.index]];
    return a;
  };
  const next = replaceNode(tree, p.key, (node) => {
    const out = { ...node, children: swap(node.children) };
    if (node.type === 'split') { out.sizes = swap(node.sizes); out.defaults = swap(node.defaults || node.sizes); }
    if (node.type === 'tabs' && node.active === hit.index) out.active = j;
    return out;
  });
  return commit(tree, next);
}

// Move pane `key` next to pane `targetKey`: 'left'|'right'|'top'|'bottom' split around the
// target, 'tab' stacks it with the target.
export function movePane(tree, key, targetKey, where) {
  if (key === targetKey) return tree;
  const hit = findNode(tree, key);
  const target = findNode(tree, targetKey);
  if (!hit || !target || hit.node.type !== 'view') return tree;
  if (findNode(hit.node, targetKey)) return tree;
  const moving = hit.node;
  const without = closePane(tree, key);
  if (!without) return tree;
  let next;
  if (where === 'tab') next = addTab(without, targetKey, moving);
  else {
    const dir = where === 'left' || where === 'right' ? 'row' : 'column';
    next = splitPane(without, targetKey, dir, moving, { before: where === 'left' || where === 'top' });
  }
  return next === without ? tree : next;
}

// Stack `newNode` as a tab with pane `key` (joining its tab group if it has one).
export function addTab(tree, key, newNode) {
  const hit = findNode(tree, key);
  if (!hit) return tree;
  const incoming = normaliseNode(newNode, 0);
  if (!incoming || incoming.type !== 'view') return tree;
  if (hit.parent?.type === 'tabs') {
    if (hit.parent.children.length >= MAX_TABS) return tree;
    const next = replaceNode(tree, hit.parent.key, (node) => ({
      ...node, children: [...node.children, incoming], active: node.children.length,
    }));
    return kept(tree, commit(tree, next), incoming.key);
  }
  if (hit.node.type === 'tabs') {
    if (hit.node.children.length >= MAX_TABS) return tree;
    const next = replaceNode(tree, key, (node) => ({ ...node, children: [...node.children, incoming], active: node.children.length }));
    return kept(tree, commit(tree, next), incoming.key);
  }
  if (hit.node.type !== 'view') return tree;
  const next = replaceNode(tree, key, (node) => ({ type: 'tabs', key: newKey(), active: 1, children: [node, incoming] }));
  return kept(tree, commit(tree, next), incoming.key);
}

export function setActiveTab(tree, tabsKey, index) {
  const next = replaceNode(tree, tabsKey, (node) => (node.type === 'tabs' ? { ...node, active: index } : node));
  return commit(tree, next);
}

// Make the pane with `key` visible: activates it within its tab group if it is in one.
export function reveal(tree, key) {
  const hit = findNode(tree, key);
  if (!hit || hit.parent?.type !== 'tabs' || hit.parent.active === hit.index) return tree;
  return setActiveTab(tree, hit.parent.key, hit.index);
}

export function setMeta(tree, patch) {
  const out = { ...tree };
  for (const k of ROOT_META) {
    if (k in patch) {
      if (patch[k] === undefined || patch[k] === null) delete out[k];
      else out[k] = patch[k];
    }
  }
  return normalise(out) || tree;
}

// Fresh keys throughout — used when copying a template or importing JSON so two layouts never
// share pane keys.
export function rekey(tree) {
  if (!isPlainObject(tree)) return tree;
  const out = { ...tree, key: newKey() };
  if (Array.isArray(tree.children)) out.children = tree.children.map(rekey);
  return out;
}

// Parse layout JSON from an export (either a bare tree or { name, tree }). Throws with a
// readable message when it is not a usable layout.
export function parseLayoutJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
  const raw = isPlainObject(data) && isPlainObject(data.tree) ? data.tree : data;
  const tree = normalise(rekey(raw));
  if (!tree || !validTree(tree)) throw new Error('That JSON is not a Hedwig layout.');
  return { name: isPlainObject(data) && typeof data.name === 'string' ? data.name.slice(0, 80) : null, tree };
}

export function exportLayoutJson(name, tree) {
  return JSON.stringify({ hedwigLayout: 1, name, tree }, null, 2);
}

// Structural equality ignoring keys — "is this still the template it started as?".
export function sameShape(a, b) {
  const withoutKeys = (k, v) => (k === 'key' ? undefined : v);
  return JSON.stringify(a, withoutKeys) === JSON.stringify(b, withoutKeys);
}
