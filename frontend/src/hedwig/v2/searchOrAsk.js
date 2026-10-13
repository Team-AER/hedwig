// "Search or ask" (the list header's field, rows.jsx ListSearch): which one a line of text is.
// Mail search matches words in messages, so a sentence ("find out all the AI expenses my team has
// mailed to me") finds nothing there; Ask reads the mail and answers. Short keywords and search
// operators stay a search. Pure so node --test can pin it.

const OPERATOR = /(^|\s)-?(from|to|cc|bcc|subject|has|is|in|before|after|label|folder|filename):\S|"[^"]+"/i;
const ADDRESS = /^\S+@\S+\.\S+$/;
const QUESTION = /^(what|what's|whats|when|who|whom|whose|where|why|how|which|did|does|do|is|are|was|were|am|can|could|should|would|will|has|have|had|any)\b/i;
const REQUEST = /^(please\s+)?(find|show|list|summari[sz]e|tell|give|get|fetch|pull|compare|count|total|sum|add up|calculate|work out|explain|remind|check|look (up|for|into)|search (for|my|through)|help|i (need|want)|i'?d like|let me know)\b/i;
// Five words or more reads as a sentence, not keywords.
const SENTENCE_WORDS = 5;

/** 'ask' or 'search' for the text typed in "Search or ask" (blank is 'search'). */
export function searchOrAsk(text) {
  const q = String(text || '').trim();
  if (!q || OPERATOR.test(q) || ADDRESS.test(q)) return 'search';
  if (/\?$/.test(q) || QUESTION.test(q) || REQUEST.test(q)) return 'ask';
  return q.split(/\s+/).length >= SENTENCE_WORDS ? 'ask' : 'search';
}
