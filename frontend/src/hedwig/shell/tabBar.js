import { useStore } from '../../store/index.js';

export const TAB_BAR_HEIGHT = 58;

// Whether the tab bar is on screen, and the style MailApp applies to its content so nothing
// sits under the bar: bottom padding, and a larger --sab so upstream's floating buttons and
// toasts (which position themselves from --sab) clear it too.
export function useHedwigTabBar(active) {
  const selectedMessageId = useStore((s) => s.selectedMessageId);
  const visible = active && !selectedMessageId;
  return {
    visible,
    contentStyle: visible ? {
      paddingBottom: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
      '--sab': `calc(env(safe-area-inset-bottom, 0px) + ${TAB_BAR_HEIGHT}px)`,
    } : null,
  };
}
