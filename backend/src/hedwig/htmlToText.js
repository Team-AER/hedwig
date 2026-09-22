// Minimal HTML → text for model input. Uses htmlparser2 (already a dependency).
import { Parser } from 'htmlparser2';

const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'section', 'article', 'header', 'footer', 'ul', 'ol']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

export function convert(html) {
  if (!html) return '';
  let out = '';
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (SKIP.has(name)) skipDepth++;
      else if (BLOCK.has(name)) out += '\n';
      if (name === 'li') out += '- ';
    },
    ontext(text) {
      if (!skipDepth) out += text;
    },
    onclosetag(name) {
      if (SKIP.has(name)) skipDepth = Math.max(0, skipDepth - 1);
      else if (BLOCK.has(name)) out += '\n';
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
