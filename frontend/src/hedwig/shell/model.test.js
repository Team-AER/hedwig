// Run with: node --test src/hedwig/shell/model.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validTree, normalise, view, split, tabs, findNode, listPanes, panesHosting, neighbourPane,
  splitPane, closePane, replaceView, updateProps, resizeChild, resetSize, moveBy, movePane,
  addTab, setActiveTab, reveal, setMeta, setDirection, parseLayoutJson, exportLayoutJson, treeDepth,
  MIN_PANE_PX, MAX_SPLIT_CHILDREN,
} from './model.js';
import { TEMPLATES, buildTemplate, getTemplate } from './templates.js';
import { deviceClass, pickLayout, templateIdForName } from './layouts.js';
import { parseKeys, chordFromEvent, upstreamConflict, createMatcher, normaliseChord } from './keymap.js';
import { buildKeyMap, buildModKeyMap } from '../../utils/defaultShortcuts.js';

const ids = (tree) => listPanes(tree).map((p) => p.node.id);
const three = () => normalise(split('row', [view('core.nav'), view('core.list'), view('core.thread')], [220, 360, null]));

describe('validTree mirrors the backend validator', () => {
  it('accepts views, splits and tabs', () => {
    assert.ok(validTree({ type: 'view', id: 'core.list' }));
    assert.ok(validTree({ type: 'split', dir: 'row', children: [{ type: 'view', id: 'a' }] }));
    assert.ok(validTree({ type: 'tabs', children: [{ type: 'view', id: 'a' }] }));
  });

  it('rejects what the backend rejects', () => {
    assert.equal(validTree(null), false);
    assert.equal(validTree({ type: 'view' }), false);
    assert.equal(validTree({ type: 'view', id: 'x'.repeat(128) }), false);
    assert.equal(validTree({ type: 'split', dir: 'diagonal', children: [{ type: 'view', id: 'a' }] }), false);
    assert.equal(validTree({ type: 'split', dir: 'row', children: [] }), false);
    assert.equal(validTree({ type: 'split', dir: 'row', children: Array.from({ length: 9 }, () => ({ type: 'view', id: 'a' })) }), false);
    assert.equal(validTree({ type: 'tabs', children: Array.from({ length: 13 }, () => ({ type: 'view', id: 'a' })) }), false);
    assert.equal(validTree({ type: 'pane', id: 'a' }), false);
  });

  it('rejects trees deeper than the backend allows', () => {
    let node = { type: 'view', id: 'leaf' };
    for (let i = 0; i < 9; i++) node = { type: 'split', dir: i % 2 ? 'row' : 'column', children: [node] };
    assert.equal(validTree(node), false);
  });

  it('every template builds a tree the backend accepts', () => {
    for (const t of TEMPLATES) {
      const tree = buildTemplate(t.id);
      assert.ok(validTree(tree), `${t.id} is invalid`);
    }
  });
});

describe('normalise', () => {
  it('assigns keys and aligns sizes', () => {
    const t = normalise({ type: 'split', dir: 'row', children: [{ type: 'view', id: 'a' }, { type: 'view', id: 'b' }] });
    assert.deepEqual(t.sizes, [null, null]);
    assert.ok(t.key && t.children.every((c) => c.key));
  });

  it('collapses single-child splits and single tabs, keeping root settings', () => {
    const t = normalise({ type: 'split', dir: 'row', density: 'compact', children: [{ type: 'tabs', children: [{ type: 'view', id: 'a' }] }] });
    assert.equal(t.type, 'view');
    assert.equal(t.id, 'a');
    assert.equal(t.density, 'compact');
  });

  it('lifts a nested split of the same direction into its parent with its sizes', () => {
    const t = normalise({
      type: 'split', dir: 'row', sizes: [200, null],
      children: [{ type: 'view', id: 'a' }, { type: 'split', dir: 'row', sizes: [300, null], children: [{ type: 'view', id: 'b' }, { type: 'view', id: 'c' }] }],
    });
    assert.deepEqual(ids(t), ['a', 'b', 'c']);
    assert.deepEqual(t.sizes, [200, 300, null]);
  });

  it('clamps sizes and keeps one flexible child', () => {
    const t = normalise({ type: 'split', dir: 'row', sizes: [10, 99999], children: [{ type: 'view', id: 'a' }, { type: 'view', id: 'b' }] });
    assert.equal(t.sizes[0], MIN_PANE_PX);
    assert.equal(t.sizes[1], null);
    const all = normalise({ type: 'split', dir: 'row', sizes: [200, 500], children: [{ type: 'view', id: 'a' }, { type: 'view', id: 'b' }] });
    assert.deepEqual(all.sizes, [200, null]);
  });

  it('drops invalid nodes and garbage values', () => {
    const t = normalise({ type: 'split', dir: 'sideways', sizes: ['x', null], children: [{ type: 'view', id: '' }, { type: 'nope' }, { type: 'view', id: 'b', props: 'bad', follows: 3 }] });
    assert.equal(t.type, 'view');
    assert.equal(t.id, 'b');
    assert.equal(t.props, undefined);
    assert.equal(t.follows, undefined);
    assert.equal(normalise(null), null);
    assert.equal(normalise({ type: 'split', dir: 'row', children: [] }), null);
  });

  it('drops an unknown density', () => {
    assert.equal(normalise({ type: 'view', id: 'a', density: 'huge' }).density, undefined);
  });
});

describe('split, close, replace', () => {
  it('adds a sibling when splitting in the parent direction', () => {
    const t = three();
    const list = t.children[1].key;
    const out = splitPane(t, list, 'row', view('core.picker'));
    assert.deepEqual(ids(out), ['core.nav', 'core.list', 'core.picker', 'core.thread']);
    assert.deepEqual(out.sizes, [220, 360, null, null]);
  });

  it('wraps the pane when splitting across the parent direction', () => {
    const t = three();
    const thread = t.children[2].key;
    const out = splitPane(t, thread, 'column', view('hedwig.context'));
    assert.equal(out.children[2].type, 'split');
    assert.equal(out.children[2].dir, 'column');
    assert.deepEqual(ids(out.children[2]), ['core.thread', 'hedwig.context']);
    assert.deepEqual(out.sizes, [220, 360, null], 'the wrapped pane keeps its slot size');
  });

  it('splits before when asked', () => {
    const t = normalise(view('a'));
    const out = splitPane(t, t.key, 'row', view('b'), { before: true });
    assert.deepEqual(ids(out), ['b', 'a']);
  });

  it('splits a whole tab group rather than one tab', () => {
    const t = normalise(split('row', [view('a'), tabs([view('b'), view('c')])]));
    const c = t.children[1].children[1].key;
    const out = splitPane(t, c, 'column', view('d'));
    assert.equal(out.children[1].type, 'split');
    assert.equal(out.children[1].children[0].type, 'tabs');
  });

  it('stacks a tab instead of overflowing a full split', () => {
    let t = normalise(split('row', Array.from({ length: MAX_SPLIT_CHILDREN }, (_, i) => view(`v${i}`))));
    const last = t.children[MAX_SPLIT_CHILDREN - 1].key;
    t = splitPane(t, last, 'row', view('extra'));
    assert.ok(validTree(t));
    assert.equal(listPanes(t).length, MAX_SPLIT_CHILDREN + 1);
    assert.equal(t.children[MAX_SPLIT_CHILDREN - 1].type, 'tabs');
  });

  it('refuses a split that would exceed the depth limit', () => {
    let t = normalise(view('leaf'));
    let key = t.key;
    for (let i = 0; i < 12; i++) {
      t = splitPane(t, key, i % 2 ? 'row' : 'column', view(`n${i}`));
      key = panesHosting(t, `n${i}`)[0] || key;
    }
    assert.ok(validTree(t));
    assert.ok(treeDepth(t) <= 8);
  });

  it('closes a pane and collapses its split', () => {
    const t = normalise(split('row', [view('a'), split('column', [view('b'), view('c')])], [300, null]));
    const c = t.children[1].children[1].key;
    const out = closePane(t, c);
    assert.deepEqual(ids(out), ['a', 'b']);
    assert.equal(out.children[1].type, 'view');
    assert.deepEqual(out.sizes, [300, null]);
  });

  it('returns null when the last pane closes', () => {
    const t = normalise(view('a'));
    assert.equal(closePane(t, t.key), null);
  });

  it('keeps the right tab active after closing one', () => {
    const t = normalise(tabs([view('a'), view('b'), view('c')], 2));
    const out = closePane(t, t.children[0].key);
    assert.equal(out.active, 1);
    assert.equal(out.children[out.active].id, 'c');
    const out2 = closePane(t, t.children[2].key);
    assert.equal(out2.children[out2.active].id, 'b');
  });

  it('replaces a view and resets its props', () => {
    const t = normalise(view('a', { props: { q: 1 }, follows: 'x' }));
    const out = replaceView(t, t.key, 'b');
    assert.equal(out.id, 'b');
    assert.equal(out.key, t.key, 'the pane keeps its key');
    assert.equal(out.props, undefined);
    assert.equal(out.follows, undefined);
  });

  it('merges props', () => {
    const t = normalise(view('hedwig.ask', { props: { a: 1 } }));
    assert.deepEqual(updateProps(t, t.key, { question: 'q' }).props, { a: 1, question: 'q' });
    assert.deepEqual(updateProps(t, t.key, { question: 'q' }, { merge: false }).props, { question: 'q' });
  });

  it('does not mutate its input', () => {
    const t = three();
    const before = JSON.stringify(t);
    splitPane(t, t.children[0].key, 'column', view('x'));
    closePane(t, t.children[1].key);
    resizeChild(t, t.key, 0, 300);
    moveBy(t, t.children[0].key, 1);
    assert.equal(JSON.stringify(t), before);
  });
});

describe('sizes', () => {
  it('resizes and clamps a child', () => {
    const t = three();
    assert.equal(resizeChild(t, t.key, 1, 500).sizes[1], 500);
    assert.equal(resizeChild(t, t.key, 1, 20).sizes[1], MIN_PANE_PX);
  });

  it('resets to the template default on double-click', () => {
    const t = buildTemplate('triage');
    const moved = resizeChild(t, t.key, 1, 600);
    assert.equal(moved.sizes[1], 600);
    assert.equal(resetSize(moved, moved.key, 1).sizes[1], 420);
  });

  it('keeps defaults aligned when panes are added and removed', () => {
    const t = buildTemplate('triage');
    const added = splitPane(t, t.children[0].key, 'row', view('x'));
    assert.deepEqual(added.defaults, [220, null, 420, null, 320]);
    const removed = closePane(added, added.children[1].key);
    assert.deepEqual(removed.defaults, [220, 420, null, 320]);
  });
});

describe('direction', () => {
  it('flips a split and merges it into a parent of the new direction', () => {
    const t = normalise(split('row', [view('a'), split('column', [view('b'), view('c')])]));
    const flipped = setDirection(t, t.children[1].key, 'row');
    assert.deepEqual(ids(flipped), ['a', 'b', 'c']);
    assert.equal(flipped.children.length, 3);
    assert.equal(setDirection(t, t.key, 'diagonal'), t);
  });
});

describe('moving panes and tabs', () => {
  it('reorders within a split, sizes following', () => {
    const t = three();
    const out = moveBy(t, t.children[0].key, 1);
    assert.deepEqual(ids(out), ['core.list', 'core.nav', 'core.thread']);
    assert.deepEqual(out.sizes, [360, 220, null]);
    assert.equal(moveBy(t, t.children[0].key, -1), t, 'moving past the edge is a no-op');
  });

  it('moves a pane next to another', () => {
    const t = three();
    const out = movePane(t, t.children[0].key, t.children[2].key, 'bottom');
    assert.deepEqual(ids(out), ['core.list', 'core.thread', 'core.nav']);
    assert.equal(out.children[1].dir, 'column');
  });

  it('stacks panes as tabs and reveals them', () => {
    const t = three();
    const out = movePane(t, t.children[1].key, t.children[2].key, 'tab');
    const group = out.children[1];
    assert.equal(group.type, 'tabs');
    assert.deepEqual(group.children.map((c) => c.id), ['core.thread', 'core.list']);
    assert.equal(group.active, 1);
    const back = setActiveTab(out, group.key, 0);
    assert.equal(back.children[1].active, 0);
    const revealed = reveal(back, group.children[1].key);
    assert.equal(revealed.children[1].active, 1);
    const visible = listPanes(back).filter((p) => p.visible).map((p) => p.node.id);
    assert.deepEqual(visible, ['core.nav', 'core.thread']);
  });

  it('adds a tab to an existing group', () => {
    const t = normalise(tabs([view('a'), view('b')]));
    const out = addTab(t, t.children[0].key, view('c'));
    assert.deepEqual(out.children.map((c) => c.id), ['a', 'b', 'c']);
    assert.equal(out.active, 2);
  });
});

describe('queries', () => {
  it('finds panes and cycles focus', () => {
    const t = three();
    const [nav, list, thread] = t.children.map((c) => c.key);
    assert.equal(findNode(t, list).index, 1);
    assert.deepEqual(panesHosting(t, 'core.thread'), [thread]);
    assert.equal(neighbourPane(t, nav, 1), list);
    assert.equal(neighbourPane(t, nav, -1), thread);
    assert.equal(neighbourPane(t, 'missing', 1), nav);
  });
});

describe('settings and JSON', () => {
  it('sets and clears root settings', () => {
    const t = three();
    const dense = setMeta(t, { density: 'compact', headers: true });
    assert.equal(dense.density, 'compact');
    assert.equal(dense.headers, true);
    assert.equal(setMeta(dense, { density: null }).density, undefined);
  });

  it('keeps root settings through structural edits', () => {
    const t = setMeta(three(), { density: 'spacious' });
    const out = closePane(closePane(t, t.children[0].key), t.children[1].key);
    assert.equal(out.density, 'spacious');
  });

  it('round-trips export and import with fresh keys', () => {
    const t = buildTemplate('triage');
    const { name, tree } = parseLayoutJson(exportLayoutJson('Mine', t));
    assert.equal(name, 'Mine');
    assert.deepEqual(ids(tree), ids(t));
    assert.notEqual(tree.key, t.key);
    assert.equal(tree.children[3].follows, 'core.thread');
  });

  it('imports a bare tree and rejects junk', () => {
    assert.equal(parseLayoutJson(JSON.stringify({ type: 'view', id: 'core.list' })).tree.id, 'core.list');
    assert.throws(() => parseLayoutJson('{nope'), /valid JSON/);
    assert.throws(() => parseLayoutJson(JSON.stringify({ type: 'split', dir: 'row', children: [] })), /not a Hedwig layout/);
  });
});

describe('templates', () => {
  it('triage matches the spec', () => {
    const t = buildTemplate('triage');
    assert.deepEqual(ids(t), ['core.nav', 'hedwig.needs', 'core.thread', 'hedwig.context']);
    assert.deepEqual(t.sizes, [220, 420, null, 320]);
    assert.equal(t.children[3].follows, 'core.thread');
  });

  it('research matches the spec', () => {
    const t = buildTemplate('research');
    assert.deepEqual(ids(t), ['hedwig.ask', 'hedwig.timeline']);
    assert.deepEqual(t.sizes, [640, null]);
  });

  it('reproduces upstream presets', () => {
    assert.deepEqual(buildTemplate('wide').sizes, [220, 560, null]);
    assert.deepEqual(buildTemplate('focused').sizes, [220, 210, null]);
    const v = buildTemplate('vertical');
    assert.equal(v.children[1].dir, 'column');
    assert.deepEqual(ids(v), ['core.nav', 'core.list', 'core.thread']);
    assert.equal(getTemplate('compact').upstreamLayout, 'compact');
  });

  it('falls back to triage for an unknown id', () => {
    assert.deepEqual(ids(buildTemplate('nope')), ids(buildTemplate('triage')));
  });
});

describe('layout selection', () => {
  it('classifies devices by width', () => {
    assert.equal(deviceClass(390), 'phone');
    assert.equal(deviceClass(767), 'phone');
    assert.equal(deviceClass(768), 'tablet');
    assert.equal(deviceClass(1099), 'tablet');
    assert.equal(deviceClass(1440), 'desktop');
  });

  it('prefers the active saved layout for the device', () => {
    const tree = { type: 'split', dir: 'row', children: [{ type: 'view', id: 'core.list' }, { type: 'view', id: 'core.thread' }] };
    const rows = [
      { name: 'Other', device: 'desktop', tree: { type: 'view', id: 'x' }, is_active: false },
      { name: 'Mine', device: 'desktop', tree, is_active: true },
    ];
    const got = pickLayout(rows, 'desktop', 'research');
    assert.equal(got.name, 'Mine');
    assert.equal(got.source, 'saved');
    assert.deepEqual(ids(got.tree), ['core.list', 'core.thread']);
  });

  it('lets a tablet borrow the desktop layout, then falls back to the default template', () => {
    const rows = [{ name: 'Triage', device: 'desktop', tree: buildTemplate('triage'), is_active: true }];
    assert.equal(pickLayout(rows, 'tablet', 'research').name, 'Triage');
    assert.equal(pickLayout(rows, 'tablet', 'research').templateId, 'triage');
    const fresh = pickLayout([], 'desktop', 'research');
    assert.equal(fresh.templateId, 'research');
    assert.equal(fresh.source, 'template');
    assert.equal(pickLayout(null, 'desktop', 'bogus').templateId, 'triage');
  });

  it('skips a saved layout that no longer validates', () => {
    const rows = [{ name: 'Broken', device: 'desktop', tree: { type: 'split', dir: 'row', children: [] }, is_active: true }];
    assert.equal(pickLayout(rows, 'desktop', 'compact').templateId, 'compact');
  });

  it('maps saved names back to templates', () => {
    assert.equal(templateIdForName('Triage'), 'triage');
    assert.equal(templateIdForName('My layout'), null);
  });
});

describe('keymap', () => {
  it('parses sequences and modifier combos', () => {
    assert.deepEqual(parseKeys('g a'), ['g', 'a']);
    assert.deepEqual(parseKeys('mod+\\'), ['mod+\\']);
    assert.deepEqual(parseKeys('ctrl+K'), ['mod+k']);
    assert.equal(normaliseChord('shift+F6'), 'shift+f6');
    assert.deepEqual(parseKeys(''), []);
  });

  it('reads chords from events', () => {
    assert.equal(chordFromEvent({ key: 'g' }), 'g');
    assert.equal(chordFromEvent({ key: '\\', metaKey: true }), 'mod+\\');
    assert.equal(chordFromEvent({ key: '?', shiftKey: true }), '?');
    assert.equal(chordFromEvent({ key: 'F6', shiftKey: true }), 'shift+f6');
    assert.equal(chordFromEvent({ key: 'Shift', shiftKey: true }), null);
  });

  it('matches sequences and recovers from dead prefixes', () => {
    const m = createMatcher([{ id: 'needs', seq: ['g', 'n'] }, { id: 'split', seq: ['mod+\\'] }]);
    assert.deepEqual(m.feed('g'), { pending: true });
    assert.deepEqual(m.feed('n'), { run: 'needs' });
    assert.deepEqual(m.feed('mod+\\'), { run: 'split' });
    assert.deepEqual(m.feed('g'), { pending: true });
    assert.deepEqual(m.feed('g'), { pending: true }, 'a repeated prefix restarts the sequence');
    assert.deepEqual(m.feed('n'), { run: 'needs' });
    assert.equal(m.feed('x'), null);
  });

  it('never shadows upstream shortcuts', () => {
    const plain = buildKeyMap({});
    const mod = buildModKeyMap({});
    assert.equal(upstreamConflict(parseKeys('g i'), plain, mod), 'goInbox');
    assert.equal(upstreamConflict(parseKeys('g n'), plain, mod), null);
    assert.equal(upstreamConflict(parseKeys('e x'), plain, mod), 'archive');
    assert.equal(upstreamConflict(parseKeys('mod+p'), plain, mod), 'printMessage');
    assert.equal(upstreamConflict(parseKeys('mod+\\'), plain, mod), null);
    // A user override that frees 'gi' frees it for Hedwig too.
    assert.equal(upstreamConflict(parseKeys('g i'), buildKeyMap({ goInbox: 'gh' }), mod), null);
  });
});
