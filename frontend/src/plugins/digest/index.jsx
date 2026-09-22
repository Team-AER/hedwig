// aer.digest — frontend half: the daily paper view and its command, while the plugin is activated.
import { registerView, registerCommand } from '../../hedwig/registry.js';
import { useHedwig } from '../../hedwig/store.js';
import { whenActivated } from '../runtimeLoader.js';
import Paper from './Paper.jsx';

whenActivated('aer.digest', () => [
  registerView({
    id: 'aer.digest.paper',
    title: 'Daily paper',
    icon: 'digest',
    group: 'plugins',
    pluginId: 'aer.digest',
    description: 'Today’s newsletters, one line each.',
    component: Paper,
  }),
  registerCommand({
    id: 'aer.digest.open',
    title: 'Open today’s paper',
    group: 'Newsletter digest',
    pluginId: 'aer.digest',
    run: () => useHedwig.getState().openView('aer.digest.paper'),
  }),
]);
