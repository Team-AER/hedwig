// Hedwig icon set: 24×24 stroke icons drawn with currentColor. Views and plugins name an icon
// in registerView({ icon: 'ask' }); <Icon name="ask" /> renders it, and an unknown name renders
// nothing rather than throwing. Decorative by default (aria-hidden) — the button around an icon
// carries the label.

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
  compose: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></>,
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
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  digest: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5" /></>,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
};

// Names the views use for the same shapes.
Object.assign(PATHS, {
  topic: PATHS.timeline,
  chart: PATHS.insights,
  bot: PATHS.agent,
  plug: PATHS.plugin,
  filter: <path d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />,
});

export const ICON_NAMES = Object.keys(PATHS);

export function Icon({ name, size = 16, strokeWidth = 1.8, style, title }) {
  if (name && typeof name === 'object') return name; // a React element passed through
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
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
