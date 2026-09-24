// hedwig.list: Reply Later, Set Aside or Snoozed, as a message list (DESIGN-AUDIT-2026-09-24 §b):
// the search field, the title with its count, then the rows. "Focus and Reply" opens the oldest
// thread in Reply Later so replies can be worked through one after another.
import { useV2Resource } from './hooks.js';
import { listOf } from './client.js';
import { openThread } from './nav.js';
import { ListItems, listPath } from './StreamView.jsx';
import { ListSearch } from './rows.jsx';
import { LinkBtn, V, ViewBody, ViewHead, usePhone } from './primitives.jsx';
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
    ? <LinkBtn hit={phone} onClick={() => openThread(oldest)} style={{ fontSize: phone ? 15 : 12, color: V.accentInk, textDecorationColor: 'transparent', alignSelf: 'center' }}>{tv('hedwig.v2.people.focusReply', 'Focus and Reply')}</LinkBtn>
    : null;
  const sub = items.length ? String(items.length) : null;
  if (phone) {
    return (
      <ViewBody phone label={listTitle(list)} padded={false}>
        <ViewHead phone title={listTitle(list)} sub={sub} actions={action}><ListSearch phone /></ViewHead>
        <div style={{ padding: '0 8px' }}><ListItems list={list} phone /></div>
      </ViewBody>
    );
  }
  return (
    <ViewBody label={listTitle(list)} padded={false} style={{ padding: '10px 0 0' }}>
      <ViewHead title={listTitle(list)} sub={sub} actions={action} before={<ListSearch style={{ marginBottom: 2 }} />} />
      <div style={{ padding: '0 6px 16px' }}><ListItems list={list} /></div>
    </ViewBody>
  );
}
