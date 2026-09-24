// Hedwig icon set: 24×24 stroke icons drawn with currentColor in the Lucide style (lucide.dev):
// 1.5px stroke at 16px, round caps and joins. Views and plugins name an icon in
// registerView({ icon: 'ask' }); <Icon name="ask" /> renders it, and an unknown name renders
// nothing rather than throwing. Decorative by default (aria-hidden) — the button around an icon
// carries the label. The names the redesign contract guarantees are listed in CONTRACT_ICONS.

const PATHS = {
  owl: (
    <>
      <path d="M12 3c-4 0-7 3-7 7v6c0 3 3 5 7 5s7-2 7-5v-6c0-4-3-7-7-7z" />
      <circle cx="9.5" cy="11" r="1.4" />
      <circle cx="14.5" cy="11" r="1.4" />
      <path d="M11 14.5l1 1 1-1" />
      <path d="M5 8l-2-3M19 8l2-3" />
    </>
  ),
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  layout: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  'split-right': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
  'split-down': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  popout: <><path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-left': <path d="M15 18l-6-6 6-6" />,
  'chevron-right': <path d="M9 18l6-6-6-6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  inbox: <><path d="M4 4h16v16H4z" /><path d="M4 14h5l1.5 2h3L15 14h5" /></>,
  ask: <path d="M21 12a8 8 0 01-11.6 7.2L4 21l1.8-5.4A8 8 0 1121 12z" />,
  people: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></>,
  // square-pen
  compose: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12.4 14.6a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z" /></>,
  needs: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /></>,
  timeline: <><path d="M4 6h16M4 12h10M4 18h13" /><circle cx="18" cy="12" r="2" /></>,
  insights: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  agent: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" /></>,
  plugin: <><path d="M12 3l9 4.5-9 4.5-9-4.5z" /><path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" /></>,
  nav: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  thread: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  context: <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="9" r="2.5" /><path d="M8 16a4 4 0 018 0" /></>,
  contacts: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0" /><path d="M16 4.5a3.5 3.5 0 010 7M18.5 20a6.5 6.5 0 00-2.5-5.1" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6L9 17l-5-5" />,
  sync: <><path d="M21 12a9 9 0 01-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0115.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>,
  classic: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16M3 10h5" /></>,
  export: <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4" /></>,
  import: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4" /></>,
  tabs: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M3 11h18M8 7V4h6v3" /></>,
  arrange: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><path d="M17 3v7M13.5 6.5H20.5M7 13v7M3.5 16.5h7" /></>,
  dock: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M17 10l-2 2 2 2" /></>,
  receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><path d="M14 8H8M16 12H8M13 16H8" /></>,
  digest: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5" /></>,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
};

// The redesign set (docs/hedwig/design/REDESIGN-BUILD-2026-09-24.md, Foundation contract).
Object.assign(PATHS, {
  'door-open': <><path d="M13 4h3a2 2 0 0 1 2 2v14" /><path d="M2 20h3M13 20h9" /><path d="M10 12v.01" /><path d="M13 4.56v16.16a1 1 0 0 1-1.24.97L5 20V5.56a2 2 0 0 1 1.52-1.94l4-1A2 2 0 0 1 13 4.56z" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  'book-open': <><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></>,
  'shopping-bag': <><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  plane: <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />,
  package: <><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="m7.5 4.27 9 5.15" /></>,
  reply: <><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
  'reply-all': <><path d="M7 17 2 12l5-5" /><path d="m12 17-5-5 5-5" /><path d="M22 18v-2a4 4 0 0 0-4-4H7" /></>,
  forward: <><path d="m15 17 5-5-5-5" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></>,
  'alarm-clock': <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6M22 6l-3-3" /><path d="M6.38 18.7 4 21M17.64 18.67 20 21" /></>,
  bookmark: <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  hourglass: <><path d="M5 22h14M5 2h14" /><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22" /><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" /></>,
  newspaper: <><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M18 14h-8M15 18h-5" /><path d="M10 6h8v4h-8z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  'circle-check': <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  'folder-input': <><path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" /><path d="M2 13h10" /><path d="m9 16 3-3-3-3" /></>,
  flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>,
  ellipsis: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  sparkles: <><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" /><path d="M20 3v4M22 5h-4M4 17v2M5 18H3" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>,
  'circle-alert': <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  bolt: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  'image-off': <><path d="m2 2 20 20" /><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" /><path d="M13.5 13.5 6 21M18 12l3 3" /><path d="M3.59 3.59A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59" /><path d="M21 15V5a2 2 0 0 0-2-2H9" /></>,
  paperclip: <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  'list-filter': <path d="M3 6h18M7 12h10M10 18h4" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>,
  'mail-open': <><path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z" /><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" /></>,
  printer: <><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></>,
  ban: <><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  minus: <path d="M5 12h14" />,
  'arrow-left': <path d="m12 19-7-7 7-7M19 12H5" />,
  'arrow-right': <path d="M5 12h14M12 5l7 7-7 7" />,
  calendar: <><path d="M8 2v4M16 2v4" /><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  bell: <><path d="M10.27 21a2 2 0 0 0 3.46 0" /><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33" /></>,
  archive: <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  // The reader's Delete (to Trash) and Junk.
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></>,
  'alert-octagon': <><path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" /><path d="M12 8v4M12 16h.01" /></>,
  'shield-off': <><path d="m2 2 20 20" /><path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71" /><path d="M9.31 3.84A13 13 0 0 0 12 2.24a1.19 1.19 0 0 1 1.52 0C15.5 3.8 17.5 5 20 5a1 1 0 0 1 1 1v7a9.3 9.3 0 0 1-.3 2.32" /></>,
});
PATHS['trash-2'] = PATHS.trash;
PATHS['more-horizontal'] = PATHS.ellipsis;
PATHS['square-pen'] = PATHS.compose;
PATHS.zap = PATHS.bolt;
PATHS['external-link'] = PATHS.external;
PATHS['refresh-cw'] = PATHS.refresh;

/** The icon names the redesign contract guarantees (R, L and P code against these). */
export const CONTRACT_ICONS = [
  'search', 'compose', 'door-open', 'users', 'book-open', 'receipt', 'shopping-bag', 'repeat', 'plane', 'package',
  'reply', 'reply-all', 'forward', 'alarm-clock', 'bookmark', 'hourglass', 'newspaper', 'history', 'settings',
  'circle-check', 'folder-input', 'flag', 'ellipsis', 'sparkles', 'info', 'circle-alert', 'bolt', 'image-off',
  'paperclip', 'list-filter', 'chevron-down', 'chevron-right', 'chevron-left', 'x', 'check', 'mail-open', 'mail',
  'printer', 'ban', 'external', 'plus', 'minus', 'arrow-left', 'arrow-right', 'calendar', 'clock', 'download',
  'file', 'image', 'more-horizontal', 'refresh', 'sync', 'user',
];

// Names the views use for the same shapes.
Object.assign(PATHS, {
  topic: PATHS.timeline,
  chart: PATHS.insights,
  bot: PATHS.agent,
  plug: PATHS.plugin,
  filter: <path d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />,
});

export const ICON_NAMES = Object.keys(PATHS);

/** `fill` fills the shape (a flag that is on: fill="currentColor"); the stroke stays. */
export function Icon({ name, size = 16, strokeWidth = 1.5, style, title, fill = 'none' }) {
  if (name && typeof name === 'object') return name; // a React element passed through
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      style={{ flexShrink: 0, display: 'block', ...style }}
    >
      {title && <title>{title}</title>}
      {body}
    </svg>
  );
}

export function OwlMark({ size = 22 }) {
  return <Icon name="owl" size={size} strokeWidth={1.6} />;
}

export default Icon;
