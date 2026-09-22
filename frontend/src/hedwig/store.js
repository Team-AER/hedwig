// Hedwig UI state shared between panes. Views coordinate through these keys instead of knowing
// about each other: the thread view writes selectedEntityId, the context card reads it, and so on.
// Upstream's store (store/index.js) still owns accounts, messages and the selected message.
import { create } from 'zustand';
import { hedwigApi } from './api.js';

export const useHedwig = create((set, get) => ({
  status: null,                 // /api/hedwig/status
  loadStatus: async () => {
    try { set({ status: await hedwigApi.get('/status') }); } catch { set({ status: { ready: false } }); }
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

  // Classic MailFlow shell vs Hedwig pane shell. Persisted in localStorage.
  shellMode: (() => { try { return localStorage.getItem('hedwig_shell') || 'hedwig'; } catch { return 'hedwig'; } })(),
  setShellMode: (mode) => {
    try { localStorage.setItem('hedwig_shell', mode); } catch { /* storage unavailable */ }
    set({ shellMode: mode });
  },
}));
