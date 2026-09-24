// One of the day's questions (GET /labels/questions): a sentence in the summary box style (no
// serif, no italic) and one button per option. Answers go to POST /labels/questions/:id/answer with always: false: an
// answer is about this one message. An option the server marks `always` (it can become a rule)
// gets a second, explicit button ("Yes, always"); with more than two options that would crowd the
// row, so a single "Always for this sender" checkbox does the same. "Not now" skips it.
import { useId, useState } from 'react';
import { v2Api, announceSortChange } from './client.js';
import { Btn, LinkBtn, Slip, V } from './primitives.jsx';
import { Icon } from '../icons.jsx';
import { tv } from './i18n.js';

export function Question({ question, index, total, onDone, compact = false, phone = false }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [alwaysBox, setAlwaysBox] = useState(false);
  const boxId = useId();
  if (!question) return null;
  const options = Array.isArray(question.options) && question.options.length
    ? question.options
    : [{ id: 'yes', label: tv('hedwig.v2.question.yes', 'Yes') }, { id: 'no', label: tv('hedwig.v2.question.no', 'No') }];

  const pairs = options.length <= 2;
  const canAlways = options.some((o) => o.always);

  const act = async (kind, option, always = false) => {
    setBusy(option ? `${option.id}${always ? ':always' : ''}` : kind);
    setError(null);
    try {
      if (kind === 'answer') {
        const asRule = Boolean(option.always) && (always || (!pairs && alwaysBox));
        await v2Api.post(`/labels/questions/${encodeURIComponent(question.id)}/answer`, { optionId: option.id, always: asRule });
        announceSortChange({ questionId: question.id });
      } else {
        await v2Api.post(`/labels/questions/${encodeURIComponent(question.id)}/skip`, {});
      }
      onDone?.(question.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Slip as="section" aria-label={tv('hedwig.v2.question.label', 'A question from Hedwig')} style={{ gap: 10, padding: compact ? '12px 14px' : '14px 16px' }}>
      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: compact ? 13 : 14, lineHeight: compact ? '19px' : '20px', fontWeight: 600, textWrap: 'pretty' }}>
        <span style={{ color: V.accent, display: 'inline-flex', paddingTop: 3, flexShrink: 0 }}><Icon name="sparkles" size={compact ? 13 : 14} /></span>
        {question.question}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o, i) => (
          <span key={o.id} style={{ display: 'contents' }}>
            <Btn accent={i === 0} size={phone ? 'phone' : 'md'} disabled={Boolean(busy)} onClick={() => act('answer', o)}>{o.label}</Btn>
            {pairs && o.always && (
              <Btn size={phone ? 'phone' : 'md'} disabled={Boolean(busy)} onClick={() => act('answer', o, true)}>
                {tv('hedwig.v2.question.always', '{{label}}, always', { label: o.label })}
              </Btn>
            )}
          </span>
        ))}
        {!pairs && canAlways && (
          <label htmlFor={boxId} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: phone ? 44 : 28, fontSize: 13, cursor: 'pointer' }}>
            <input id={boxId} type="checkbox" checked={alwaysBox} onChange={(e) => setAlwaysBox(e.target.checked)} style={{ accentColor: 'var(--hw-accent)' }} />
            {tv('hedwig.v2.why.scope.sender', 'Always for this sender')}
          </label>
        )}
        <LinkBtn muted hit={phone} disabled={Boolean(busy)} onClick={() => act('skip')} style={{ color: V.inkSoft }}>{tv('hedwig.v2.question.skip', 'Not now')}</LinkBtn>
        {total > 0 && (
          <span style={{ fontSize: 12, color: V.inkSoft, marginLeft: 6 }}>
            {tv('hedwig.v2.question.count', 'Question {{i}} of {{n}} today. Answers teach Hedwig.', { i: (index ?? 0) + 1, n: total })}
          </span>
        )}
      </div>
      {error && <span role="alert" style={{ fontSize: 12, color: V.red }}>{error.message || String(error)}</span>}
    </Slip>
  );
}
