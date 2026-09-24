import { useStore } from '../../store/index.js';

// The bottom tab bar (spec §g): 49px of frosted bar flush with the bottom edge, plus the safe area.
export const TAB_BAR_HEIGHT = 49;
const TAB_BAR_OFFSET = 0;

// Whether the tab bar is on screen, and the style MailApp applies to its content so nothing
// sits under the bar: bottom padding, and a larger --sab so upstream's floating buttons and
// toasts (which position themselves from --sab) clear it too.
export function useHedwigTabBar(active) {
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const visible = active && !selectedMessageId;
  return {
    visible,
    contentStyle: visible ? {
      paddingBottom: `calc(${TAB_BAR_HEIGHT + TAB_BAR_OFFSET}px + env(safe-area-inset-bottom, 0px))`,
      '--sab': `calc(env(safe-area-inset-bottom, 0px) + ${TAB_BAR_HEIGHT + TAB_BAR_OFFSET}px)`,
    } : null,
  };
}
