// Reasoning-trace removal, in one place. Models on the gateway may wrap their reasoning in
// <think>…</think> inside `content`; nothing Hedwig shows or parses should contain it.
// llm.js applies it to chat() content and to chatStream() deltas; callers never need to.

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Remove reasoning from a complete text: closed <think> blocks, an unclosed trailing <think>…,
 * and a leading "…</think>" left when the template opened the block inside the prompt.
 */
export function stripThinking(text) {
  let s = String(text ?? '');
  if (!/<\/?think>/i.test(s)) return s.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/i, '');
  const orphan = s.search(/<\/think>/i);
  if (orphan >= 0) s = s.slice(orphan + CLOSE.length);
  return s.trim();
}

/**
 * Streaming variant. `push(delta)` returns the visible part of the delta (possibly ''), holding back
 * a partial tag split across chunks; `flush()` returns whatever was held back at the end.
 */
export function createThinkFilter() {
  let inThink = false;
  let pending = '';
  let emitted = false;

  function partialTagSuffix(s, tag) {
    const lower = s.toLowerCase();
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
      if (tag.startsWith(lower.slice(-n))) return n;
    }
    return 0;
  }

  function push(delta) {
    let s = pending + String(delta ?? '');
    pending = '';
    let out = '';
    for (;;) {
      const lower = s.toLowerCase();
      if (inThink) {
        const end = lower.indexOf(CLOSE);
        if (end < 0) { pending = s.slice(s.length - partialTagSuffix(s, CLOSE)); return finish(out); }
        s = s.slice(end + CLOSE.length);
        inThink = false;
        if (!emitted) s = s.replace(/^\s+/, '');
        continue;
      }
      const start = lower.indexOf(OPEN);
      if (start < 0) {
        const hold = partialTagSuffix(s, OPEN);
        out += s.slice(0, s.length - hold);
        pending = hold ? s.slice(s.length - hold) : '';
        return finish(out);
      }
      out += s.slice(0, start);
      s = s.slice(start + OPEN.length);
      inThink = true;
    }
  }

  function finish(out) {
    if (!emitted) out = out.replace(/^\s+/, '');
    if (out) emitted = true;
    return out;
  }

  function flush() {
    const rest = inThink ? '' : pending;
    pending = '';
    return finish(rest);
  }

  return { push, flush };
}
