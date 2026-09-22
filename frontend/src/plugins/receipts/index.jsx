// aer.receipts — frontend half. Registered only while the user has the plugin activated.
import { registerView, registerCommand } from '../../hedwig/registry.js';
import { useHedwig } from '../../hedwig/store.js';
import { whenActivated } from '../runtimeLoader.js';
import Ledger from './Ledger.jsx';

whenActivated('aer.receipts', () => [
  registerView({
    id: 'aer.receipts.ledger',
    title: 'Receipts',
    icon: 'receipt',
    group: 'plugins',
    pluginId: 'aer.receipts',
    description: 'Receipts and invoices found in your mail, with monthly totals and CSV export.',
    component: Ledger,
  }),
  registerCommand({
    id: 'aer.receipts.open',
    title: 'Open receipts ledger',
    group: 'Receipts',
    pluginId: 'aer.receipts',
    run: () => useHedwig.getState().openView('aer.receipts.ledger'),
  }),
]);
