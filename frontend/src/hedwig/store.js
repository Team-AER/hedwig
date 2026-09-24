// Hedwig UI state shared between panes. Views coordinate through these keys instead of knowing
// about each other: the thread view writes selectedEntityId, the context card reads it, and so on.
// Upstream's store (store/index.js) still owns accounts, messages and the selected message.
import { create } from 'zustand';
import { hedwigApi } from './api.js';

export const SHELL_KEY = 'hedwig_shell';
// Set once the v2 shell choice has been made in this browser. A 'classic' stored before v2 (when
// the classic shell was one click away in the top bar and hid every v2 view) is moved to 'hedwig'
// exactly once; after the stamp, whatever the user picks sticks.
export const SHELL_STAMP = 'hedwig_shell_v2';

function safeStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The shell to start in, running the one-time v2 move from 'classic' to 'hedwig'. */
export function initialShellMode(storage) {
  if (!storage) return 'hedwig';
  try {
    const stored = storage.getItem(SHELL_KEY);
    if (!storage.getItem(SHELL_STAMP)) {
      storage.setItem(SHELL_STAMP, '1');
      if (stored === 'classic') storage.setItem(SHELL_KEY, 'hedwig');
      return 'hedwig';
    }
    return stored === 'classic' ? 'classic' : 'hedwig';
  } catch {
    return 'hedwig';
  }
}

// One GET /status at a time: the session start, the shell's init and the minute poll can all ask
// at once on a first load; they share the request in flight.
let statusInflight = null;
function fetchStatus() {
  if (!statusInflight) statusInflight = hedwigApi.get('/status').finally(() => { statusInflight = null; });
  return statusInflight;
}

export const useHedwig = create((set, get) => ({
  status: null,                 // /api/hedwig/status
  loadStatus: async () => {
    try { set({ status: await fetchStatus() }); } catch { set({ status: { ready: false } }); }
  },
  featureOn: (name) => {
    const s = get().status;
    return Boolean(s?.ready && s?.enabled && s?.features?.[name]);
  },

  // Cross-pane context keys.
  selectedEntityId: null,
  selectedTopicId: null,
  askPrompt: '',
  triageFilter: 'needs_you',    // 'needs_you' | 'waiting_on' | category name
  setSelectedEntity: (id) => set({ selectedEntityId: id }),
  setSelectedTopic: (id) => set({ selectedTopicId: id }),
  setAskPrompt: (q) => set({ askPrompt: q }),
  setTriageFilter: (f) => set({ triageFilter: f }),

  // Shell requests. The shell subscribes to these and focuses or opens a pane for the view.
  // `openView('hedwig.ask', { question })` – focus an existing pane hosting the view, otherwise
  // open it in the overlay pane.
  viewRequest: null,            // { id, props, nonce }
  openView: (id, props = {}) => set({ viewRequest: { id, props, nonce: Date.now() + Math.random() } }),

  // Active layout (pane tree) per device, persisted through /api/hedwig/layouts.
  activeLayout: null,
  setActiveLayout: (layout) => set({ activeLayout: layout }),

  // Classic MailFlow shell vs Hedwig pane shell. Persisted in localStorage (see initialShellMode).
  shellMode: initialShellMode(safeStorage()),
  setShellMode: (mode) => {
    const next = mode === 'classic' ? 'classic' : 'hedwig';
    try {
      localStorage.setItem(SHELL_KEY, next);
      localStorage.setItem(SHELL_STAMP, '1');
    } catch { /* storage unavailable */ }
    set({ shellMode: next });
  },

  // Refresh /status without dropping what is known when the request fails (the tier indicator
  // polls it; a failed poll must not read as "Hedwig is off").
  // An unchanged answer is not set again, so the poll does not re-render every pane each minute.
  refreshStatus: async () => {
    try {
      const next = await fetchStatus();
      if (JSON.stringify(next) !== JSON.stringify(get().status)) set({ status: next });
    } catch { /* keep the last status */ }
  },
}));
