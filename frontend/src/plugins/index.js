// Frontend plugin registrations — import each bundled plugin for its side-effecting slot
// registrations. Imported once at app startup (main.jsx) before the tree renders, so a plugin's
// slot contributions exist by first paint. Mirrors the backend's loadBundledPlugins.
import './gtd/index.jsx';
// Hedwig plugin runtime v2 first-party plugins (their views register only while activated).
import './receipts/index.jsx'; import './digest/index.jsx'; import './pensieve/index.jsx'; import './sendguard/index.jsx';
