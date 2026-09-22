// aer.pensieve — frontend half: the sync status view, while the plugin is activated.
import { registerView, registerCommand } from '../../hedwig/registry.js';
import { useHedwig } from '../../hedwig/store.js';
import { whenActivated } from '../runtimeLoader.js';
import Status from './Status.jsx';

whenActivated('aer.pensieve', () => [
  registerView({
    id: 'aer.pensieve.status',
    title: 'Pensieve',
    icon: 'sync',
    group: 'plugins',
    pluginId: 'aer.pensieve',
    description: 'Newsletters sent to your Pensieve reading list.',
    component: Status,
  }),
  registerCommand({
    id: 'aer.pensieve.open',
    title: 'Open Pensieve bridge',
    group: 'Pensieve bridge',
    pluginId: 'aer.pensieve',
    run: () => useHedwig.getState().openView('aer.pensieve.status'),
  }),
]);
