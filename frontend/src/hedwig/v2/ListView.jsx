// hedwig.list: Reply Later, Set Aside or Snoozed. "Focus and Reply" opens the oldest thread in
// the list so replies can be worked through one after another.
import { useV2Resource } from './hooks.js';
import { listOf } from './client.js';
import { openThread } from './nav.js';
import { ListItems, listPath } from './StreamView.jsx';
import { LinkBtn, ViewBody, ViewHead, usePhone } from './primitives.jsx';
import { tv } from './i18n.js';

export function listTitle(list) {
  if (list === 'setAside') return tv('hedwig.v2.rail.setAside', 'Set Aside');
  if (list === 'snoozed') return tv('hedwig.v2.rail.snoozed', 'Snoozed');
  return tv('hedwig.v2.rail.replyLater', 'Reply Later');
}

export default function ListView({ props }) {
  const list = ['replyLater', 'setAside', 'snoozed'].includes(props?.list) ? props.list : 'replyLater';
  const phone = Boolean(usePhone()?.phone);
  const res = useV2Resource(listPath(list));
  const items = listOf(res.data, 'items');
  const oldest = [...items].filter((i) => i.messageId).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[0];
  const action = list === 'replyLater' && oldest
    ? <LinkBtn onClick={() => openThread(oldest)}>{tv('hedwig.v2.people.focusReply', 'Focus and Reply')}</LinkBtn>
    : null;
  return (
    <ViewBody phone={phone} label={listTitle(list)} padded={!phone}>
      <ViewHead phone={phone} title={listTitle(list)} sub={items.length ? String(items.length) : null} actions={action} />
      <div style={{ padding: phone ? '0 16px' : 0 }}><ListItems list={list} phone={phone} /></div>
    </ViewBody>
  );
}
