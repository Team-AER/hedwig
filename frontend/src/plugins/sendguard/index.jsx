// aer.sendguard — frontend half: its settings view, while the plugin is activated.
import { registerView } from '../../hedwig/registry.js';
import { whenActivated } from '../runtimeLoader.js';
import Settings from './Settings.jsx';

whenActivated('aer.sendguard', () => [
  registerView({
    id: 'aer.sendguard.settings',
    title: 'Send guard',
    icon: 'shield',
    group: 'settings',
    pluginId: 'aer.sendguard',
    description: 'Rules checked before a message is sent.',
    component: Settings,
  }),
]);
