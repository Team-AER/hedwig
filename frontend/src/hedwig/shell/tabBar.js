import { useStore } from '../../store/index.js';

// The floating tab bar: 52px tabs in a sheet with 6px padding, 18px above the bottom edge.
export const TAB_BAR_HEIGHT = 64;
const TAB_BAR_OFFSET = 18;

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
