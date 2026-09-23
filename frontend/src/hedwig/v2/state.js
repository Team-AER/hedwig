// v2 client state shared by the rail, the tab bar and the views: the per-user ui.* settings
// (Power mode, blur, accent, and the two switches the frontend itself honours), the stream
// counts, the "Hedwig today" numbers and the thread the list panes have selected.
import { create } from 'zustand';
import { hedwigApi } from '../api.js';
import { useStore } from '../../store/index.js';
import { userVarsCss, DEFAULT_ACCENT, DEFAULT_BLUR, clampBlur, normaliseHex } from '../theme/tokens.js';
import { v2Api, listOf, isMockMode, lastLocalSortChange, COUNTS_EVENT } from './client.js';
import { tvn } from './i18n.js';

export const UI_DEFAULTS = {
  powerMode: false,
  blur: DEFAULT_BLUR,
  accent: DEFAULT_ACCENT,
  notifications: true,
  helpMeWrite: true,
};

const UI_KEYS = Object.keys(UI_DEFAULTS);
const VARS_ID = 'hedwig-user-vars';
const SCHEME_KEY = 'hedwig_scheme';

export function applyUserVars(prefs) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(VARS_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = VARS_ID;
    document.head.appendChild(el);
  }
  el.textContent = userVarsCss({ accent: prefs.accent, blur: prefs.blur });
}

/** ui.* values from GET /settings field descriptions ([{ key, value }]). */
export function prefsFromFields(fields) {
  const out = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f?.key?.startsWith('ui.')) continue;
    const k = f.key.slice(3);
    if (UI_KEYS.includes(k) && f.value !== undefined && f.value !== null) out[k] = f.value;
  }
  if (out.blur !== undefined) out.blur = clampBlur(out.blur);
  if (out.accent !== undefined) out.accent = normaliseHex(out.accent) || DEFAULT_ACCENT;
  return out;
}

// The user's explicit choice ('auto' | 'light' | 'dark'), or null when they never made one: then
// the theme they saved in upstream's Appearance settings stands and the system is not followed.
function readScheme() {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    return v === 'auto' || v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

// One page this size is what the stream views load first, so the counts and the views ask for
// the same URL and share the request.
export const STREAM_PAGE = 100;
export const streamPath = (stream, { needsYou = false } = {}) => `/sort/stream/${stream}?${needsYou ? 'needsYou=1&' : ''}limit=${STREAM_PAGE}`;
// Pages walked for the Needs you count (there is no counts route; the needsYou=1 list is short).
const NEEDS_PAGES = 5;
// A local change within this window explains a count going up: no toast for the user's own act.
const OWN_CHANGE_MS = 5000;

let countsSeq = 0;
let probe = null;

async function needsYouCount() {
  let path = streamPath('people', { needsYou: true });
  let n = 0;
  for (let i = 0; i < NEEDS_PAGES; i++) {
    const d = await v2Api.get(path);
    if (typeof d?.total === 'number') return { n: d.total, more: false };
    n += listOf(d, 'items').filter((x) => x.needsYou).length;
    if (!d?.next) return { n, more: false };
    path = `${streamPath('people', { needsYou: true })}&cursor=${encodeURIComponent(d.next)}`;
  }
  return { n, more: true };
}

/** "12", or "100+" when the count comes from a page that has more after it. */
export function countText(counts, more, key) {
  const n = counts?.[key];
  if (n == null || n === 0) return '';
  return more?.[key] ? `${n}+` : String(n);
}

const EMPTY_COUNTS = { screener: null, people: null, reading: null, records: null, replyLater: null, setAside: null, snoozed: null };

export const useV2 = create((set, get) => ({
  prefs: { ...UI_DEFAULTS },
  prefsLoaded: false,
  settingsFields: null,     // the raw GET /settings list, for the Simple switches
  scheme: readScheme(),     // 'auto' | 'light' | 'dark' | null (no choice: upstream's saved theme stands)

  counts: { ...EMPTY_COUNTS },
  countsMore: {},           // { reading: true } when a count is a lower bound ("100+")
  today: null,              // { screened, bundled, rescued, blocked }
  selected: null,           // stream item whose thread the thread pane shows
  caps: { work: null },     // work routes: null = not asked yet, true / false once answered

  /** Back to signed-out state (the session stopped or another user signed in). */
  reset() {
    countsSeq++;
    probe = null;
    set({ counts: { ...EMPTY_COUNTS }, countsMore: {}, today: null, selected: null, caps: { work: null }, prefs: { ...UI_DEFAULTS }, prefsLoaded: false, settingsFields: null });
  },

  /** Ask once whether the work routes exist (GET /work/lists); a 404 hides their controls. */
  probeWork() {
    if (get().caps.work !== null) return Promise.resolve(get().caps.work);
    if (!probe) {
      probe = v2Api.get('/work/lists').then(
        (d) => { get().applyListCounts(d); return true; },
        (err) => (err?.status === 404 || err?.status === 501 ? false : null),
      );
    }
    const mine = probe;
    return mine.then((work) => {
      if (work === null) { if (probe === mine) probe = null; return null; } // not an answer: ask again next time
      if (get().caps.work === null) set({ caps: { work } });
      return work;
    });
  },

  applyListCounts(d) {
    if (!d || typeof d !== 'object') return;
    const pick = (camel, snake) => (typeof d[camel] === 'number' ? d[camel] : typeof d[snake] === 'number' ? d[snake] : null);
    set({ counts: { ...get().counts, replyLater: pick('replyLater', 'reply_later'), setAside: pick('setAside', 'set_aside'), snoozed: pick('snoozed', 'snoozed') } });
  },

  async loadPrefs() {
    applyUserVars(get().prefs);
    if (isMockMode()) { set({ prefsLoaded: true }); return; }
    try {
      const fields = await hedwigApi.get('/settings');
      const prefs = { ...UI_DEFAULTS, ...prefsFromFields(fields) };
      set({ prefs, settingsFields: Array.isArray(fields) ? fields : null, prefsLoaded: true });
      applyUserVars(prefs);
    } catch (err) {
      console.warn('[hedwig] could not load ui settings:', err?.message || err);
      set({ prefsLoaded: true });
    }
  },

  /** Set one ui.* value: applied at once, then saved per user. Reverts if the save fails. */
  async setPref(key, value) {
    if (!UI_KEYS.includes(key)) return;
    const prev = get().prefs;
    const prefs = { ...prev, [key]: value };
    set({ prefs });
    applyUserVars(prefs);
    if (isMockMode()) return;
    try {
      const fields = await hedwigApi.patch('/settings', { [`ui.${key}`]: value });
      if (Array.isArray(fields)) set({ settingsFields: fields });
    } catch (err) {
      set({ prefs: prev });
      applyUserVars(prev);
      useStore.getState().addNotification?.({ type: 'error', title: 'Hedwig', body: err?.message || String(err) });
    }
  },

  setSettingsFields(fields) {
    if (!Array.isArray(fields)) return;
    const prefs = { ...get().prefs, ...prefsFromFields(fields) };
    set({ settingsFields: fields, prefs });
    applyUserVars(prefs);
  },

  togglePower() { return get().setPref('powerMode', !get().prefs.powerMode); },

  setScheme(scheme) {
    try { localStorage.setItem(SCHEME_KEY, scheme); } catch { /* storage unavailable */ }
    set({ scheme });
    syncScheme(scheme);
  },

  /** The scheme to show in menus: the explicit choice, or what the current theme is. */
  effectiveScheme() {
    return get().scheme || (isDarkNow() ? 'dark' : 'light');
  },

  select(item) { set({ selected: item || null }); },

  /**
   * Refresh the rail and tab-bar counts. There is no counts route: Needs you walks the short
   * needsYou=1 list, Reading and Records count unread on their first page (a "+" when there is
   * more), the Screener counts senders, the lists come from GET /work/lists. `poll` is the
   * background timer: only a poll may toast, and only when the user did not just change
   * something here; a poll that moves a count also tells the stream lists to reload.
   */
  async refreshCounts({ poll = false } = {}) {
    const my = ++countsSeq;
    const work = get().caps.work;
    const [screener, people, reading, records, lists, today] = await Promise.allSettled([
      v2Api.get('/sort/screener'),
      needsYouCount(),
      v2Api.get(streamPath('reading')),
      v2Api.get(streamPath('records')),
      work === false ? Promise.reject(Object.assign(new Error('off'), { status: 404 })) : v2Api.get('/work/lists'),
      v2Api.get('/sort/today'),
    ]);
    if (my !== countsSeq) return;
    if (work === null) {
      if (lists.status === 'fulfilled') set({ caps: { work: true } });
      else if (lists.reason?.status === 404 || lists.reason?.status === 501) set({ caps: { work: false } });
    }
    const prev = get().counts;
    const prevMore = get().countsMore;
    const val = (r, fn, old) => (r.status === 'fulfilled' ? fn(r.value) : old);
    const unread = (d) => listOf(d, 'items').filter((i) => i.unread).length;
    const listN = (camel, snake) => (d) => (typeof d?.[camel] === 'number' ? d[camel] : typeof d?.[snake] === 'number' ? d[snake] : null);
    const counts = {
      screener: val(screener, (d) => listOf(d, 'senders').length, prev.screener),
      people: val(people, (d) => d.n, prev.people),
      reading: val(reading, unread, prev.reading),
      records: val(records, unread, prev.records),
      replyLater: val(lists, listN('replyLater', 'reply_later'), prev.replyLater),
      setAside: val(lists, listN('setAside', 'set_aside'), prev.setAside),
      snoozed: val(lists, listN('snoozed', 'snoozed'), prev.snoozed),
    };
    const countsMore = {
      people: val(people, (d) => d.more, prevMore.people),
      reading: val(reading, (d) => Boolean(d?.next), prevMore.reading),
      records: val(records, (d) => Boolean(d?.next), prevMore.records),
    };
    const t = today.status === 'fulfilled' ? today.value : null;
    set({
      counts,
      countsMore,
      today: t ? { screened: t.screened || 0, bundled: t.bundled || 0, rescued: t.rescued || 0, blocked: t.blocked || 0 } : get().today,
    });
    if (!poll) return;
    const moved = ['screener', 'people', 'reading', 'records'].some((k) => prev[k] != null && counts[k] !== prev[k]);
    if (moved && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(COUNTS_EVENT));
    const own = Date.now() - lastLocalSortChange() < OWN_CHANGE_MS;
    if (!own && get().prefs.notifications && prev.people != null && counts.people != null && counts.people > prev.people) {
      const n = counts.people - prev.people;
      useStore.getState().addNotification?.({
        type: 'info',
        title: tvn(n, ['hedwig.v2.notify.needsYouOne', 'A new message needs you'], ['hedwig.v2.notify.needsYouMany', '{{n}} new messages need you']),
      });
    }
  },
}));

// ── Colour scheme: follow the system, or a manual light / dark choice ─────────

const LIGHT = 'hedwig';
const DARK = 'hedwig-night';

function systemDark() {
  try { return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches); } catch { return false; }
}

/** Point the upstream theme at the Hedwig theme the scheme asks for; other themes are left alone. */
export function syncScheme(scheme = useV2.getState().scheme) {
  const st = useStore.getState();
  if (!scheme || (st.theme !== LIGHT && st.theme !== DARK)) return;
  const want = scheme === 'light' ? LIGHT : scheme === 'dark' ? DARK : (systemDark() ? DARK : LIGHT);
  if (st.theme !== want) st.setTheme(want);
}

let schemeWatch = null;
/**
 * Follow the system's light / dark setting, but only when the user chose "auto". With a manual
 * choice, or no choice at all (the theme saved in upstream's Appearance settings), a sign-in
 * never flips the theme.
 */
export function watchSystemScheme() {
  if (schemeWatch || typeof window === 'undefined' || !window.matchMedia) return;
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (useV2.getState().scheme === 'auto') syncScheme('auto'); };
    mq.addEventListener?.('change', onChange);
    schemeWatch = { mq, onChange };
    onChange();
  } catch { /* matchMedia unavailable */ }
}

export function unwatchSystemScheme() {
  if (!schemeWatch) return;
  try { schemeWatch.mq.removeEventListener?.('change', schemeWatch.onChange); } catch { /* ignore */ }
  schemeWatch = null;
}

export function isDarkNow() {
  return useStore.getState().theme === DARK;
}
