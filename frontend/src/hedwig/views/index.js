// Registers every core Hedwig view, the palette/keymap commands, and the classic-shell context
// sidebar. Imported once by hedwig/index.js. The v2 views (streams, Screener, thread, Brief,
// Hedwig today, the rail) register first, from ../v2/index.js; the v1 views stay registered so
// saved layouts that name them keep working.
import { createElement } from 'react';
import { registerCommand, registerView } from '../registry.js';
import { useHedwig } from '../store.js';
import { registerSlot } from '../../plugins/registry.js';
import NeedsYou from './NeedsYou.jsx';
import ContextCard from './ContextCard.jsx';
import ContextSidebar from './ContextSidebar.jsx';
import Ask from './Ask.jsx';
import Timeline from './Timeline.jsx';
import People from './People.jsx';
import Insights from './Insights.jsx';
import Agent from './Agent.jsx';
import TriageSettings from './settings/TriageSettings.jsx';
import PluginSettings from './settings/PluginSettings.jsx';
import ModelSettings from './settings/ModelSettings.jsx';
import PersonalSettings from './settings/PersonalSettings.jsx';
import { registerV2 } from '../v2/index.js';

export const HEDWIG_VIEWS = [
  { id: 'hedwig.needs', title: 'Needs you', icon: 'inbox', group: 'mail', requires: 'triage', component: NeedsYou,
    description: 'Mail ranked by what needs you, with the reason for each.' },
  { id: 'hedwig.context', title: 'Context', icon: 'people', group: 'context', requires: 'context', component: ContextCard,
    description: 'Who the open message is from, where things stand, what is owed.' },
  { id: 'hedwig.ask', title: 'Ask', icon: 'ask', group: 'context', requires: 'context', component: Ask,
    description: 'Ask a question across all your mail; answers cite their sources.' },
  { id: 'hedwig.timeline', title: 'Topic timeline', icon: 'topic', group: 'context', requires: 'context', component: Timeline,
    description: 'A topic as a dated timeline of who said what and what is owed.' },
  { id: 'hedwig.people', title: 'Correspondents', icon: 'contacts', group: 'context', requires: 'context', component: People,
    description: 'Everyone you correspond with, most recent first.' },
  { id: 'hedwig.insights', title: 'Insights', icon: 'chart', group: 'insights', requires: 'insights', component: Insights,
    description: 'Volume, reply times, top senders, insight cards and the daily briefing.' },
  { id: 'hedwig.agent', title: 'Agent', icon: 'bot', group: 'agent', requires: 'agent', component: Agent,
    description: 'Chat with the agent and manage scheduled automations.' },
  { id: 'hedwig.settings.triage', title: 'Triage settings', icon: 'filter', group: 'settings', requires: 'triage', component: TriageSettings,
    description: 'Triage accuracy, recent decisions, sender rules and thresholds.' },
  { id: 'hedwig.settings.plugins', title: 'Plugins', icon: 'plug', group: 'settings', component: PluginSettings,
    description: 'Enable plugins and choose what they may access.' },
  { id: 'hedwig.settings.models', title: 'Models and pipeline', icon: 'settings', group: 'settings', component: ModelSettings,
    description: 'Admin: model gateway, embeddings, budgets, pipeline health.' },
  { id: 'hedwig.settings.personal', title: 'Hedwig settings', icon: 'settings', group: 'settings', component: PersonalSettings,
    description: 'Your Hedwig features, preferences and today’s model usage.' },
];

const open = (id, props = {}) => () => useHedwig.getState().openView(id, props);
const on = (feature) => () => useHedwig.getState().featureOn(feature);

export const HEDWIG_COMMANDS = [
  { id: 'hedwig.ask', title: 'Ask across all mail', keys: 'g a', when: on('context'), run: open('hedwig.ask', { question: '' }) },
  { id: 'hedwig.needs', title: 'Needs you', keys: 'g n', when: on('triage'),
    run: () => { useHedwig.getState().setTriageFilter('needs_you'); useHedwig.getState().openView('hedwig.needs', {}); } },
  { id: 'hedwig.insights', title: 'Insights', keys: 'g s', when: on('insights'), run: open('hedwig.insights') },
  { id: 'hedwig.agent', title: 'Agent', keys: 'g .', when: on('agent'), run: open('hedwig.agent') },
  { id: 'hedwig.people', title: 'Correspondents', when: on('context'), run: open('hedwig.people') },
  { id: 'hedwig.briefing', title: 'Daily briefing', when: on('insights'), run: open('hedwig.insights', { focus: 'briefing' }) },
  { id: 'hedwig.settings', title: 'Hedwig settings', run: open('hedwig.settings.personal') },
];

let registered = false;

export function registerHedwigViews() {
  if (registered) return;
  registered = true;
  registerV2();
  for (const v of HEDWIG_VIEWS) registerView(v);
  for (const c of HEDWIG_COMMANDS) registerCommand({ group: 'Hedwig', ...c });

  // Classic MailFlow shell: show the context card in upstream's right sidebar for the selected
  // message. The slot is gated on store.enabledPlugins containing 'hedwig' (see PluginSlot.jsx);
  // order 10 keeps GTD's rail first when both are live, since MailApp renders only the first.
  registerSlot('right-sidebar', {
    pluginId: 'hedwig',
    order: 10,
    isActive: () => {
      const h = useHedwig.getState();
      return h.shellMode === 'classic' && h.featureOn('context');
    },
    render: (ctx) => createElement(ContextSidebar, { onCollapse: ctx.onCollapse, toggleHint: ctx.toggleHint }),
  });
}

registerHedwigViews();
