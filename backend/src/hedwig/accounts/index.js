// accounts module: helps Settings → Accounts → Add account pick the sign-in for an address.
// Not gated on Hedwig intelligence being on: adding a mailbox is plain mail. See
// docs/hedwig/PLAN-CLICK-TO-SIGN-IN.md and docs/hedwig/API.md.
import { discoverProvider } from './discover.js';

export default {
  name: 'accounts',

  routes(r) {
    r.get('/accounts/discover', async (req, res) => {
      try {
        res.json(await discoverProvider(req.query.email));
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[hedwig] accounts/discover failed:', err);
        res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
      }
    });
  },
};
