// First-party (tier 1) v2 plugins shipped in this build. Each lives in backend/src/plugins/<name>/,
// exports its manifest and a default activate(hedwig), and imports nothing from core
// (eslint.plugins-boundary.js enforces that).
import * as receipts from '../../plugins/receipts/index.js';
import * as digest from '../../plugins/digest/index.js';
import * as pensieve from '../../plugins/pensieve/index.js';
import * as sendguard from '../../plugins/sendguard/index.js';

export const BUNDLED = [receipts, digest, pensieve, sendguard].map((m) => ({ manifest: m.manifest, activate: m.default }));
