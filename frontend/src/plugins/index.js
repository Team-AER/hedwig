// Frontend plugin registrations — import each bundled plugin for its side-effecting slot
// registrations. Imported once at app startup (main.jsx) before the tree renders, so a plugin's
// slot contributions exist by first paint. Mirrors the backend's loadBundledPlugins.
// Upstream's GTD is left out of Hedwig (backend loadPlugins.js HEDWIG_HIDDEN_PLUGINS): it keeps its
// states as label folders on the mail server, which Hedwig never adds; its lists live in Hedwig.
// Hedwig plugin runtime v2 first-party plugins (their views register only while activated).
import './receipts/index.jsx'; import './digest/index.jsx'; import './pensieve/index.jsx'; import './sendguard/index.jsx';
