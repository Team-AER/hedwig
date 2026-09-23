// sort.bundleDescribe — turns a user's description of a custom bundle into a classifier hint and
// example keywords. Owned by Stream C.
const SYSTEM = `A person wants a new bundle (a group their email is sorted into) described in their own words.
Return: "key" (a short lowercase slug, a-z and hyphens, not one of the existing keys), "hint" (one sentence, at most
140 characters, telling an email sorter exactly which mail belongs), "keywords" (5 to 12 lowercase words or short phrases
that typically appear in the sender, subject or text of such mail), and "stream" ("records" for things to keep such as
receipts, statements and notifications; "reading" for things to read such as newsletters and articles).
Reply with JSON only: {"key":…,"hint":…,"keywords":[…],"stream":…}.`;

export default {
  id: 'sort.bundleDescribe',
  version: '2026-09-23.1',
  tier: 'reflex',
  system: SYSTEM,
  user: (v) => `Bundle name: ${v.name}\nDescription: ${v.description}\nExisting keys: ${(v.existing || []).join(', ') || '(none)'}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'hint', 'keywords', 'stream'],
    properties: {
      key: { type: 'string' },
      hint: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      stream: { type: 'string', enum: ['reading', 'records'] },
    },
  },
  maxTokens: 400,
  temperature: 0,
};
