import { describe, it, expect } from 'vitest';
import { looksLikeNewsletter, findWebVersionUrl, buildSavePayload, saveEndpoint, outcome, parseTags } from './push.js';

describe('web version link', () => {
  it('prefers the "view in browser" link', () => {
    const html = '<p><a href="https://track.example.com/u?x=1">Unsubscribe</a> <a href="https://news.example.com/issue/12?utm=x&amp;y=1">View this email in your browser</a></p>';
    expect(findWebVersionUrl({ html })).toBe('https://news.example.com/issue/12?utm=x&y=1');
  });
  it('reads plain-text newsletters', () => {
    expect(findWebVersionUrl({ text: 'Hi!\nRead online: https://letters.example.org/p/hello-world\n' })).toBe('https://letters.example.org/p/hello-world');
  });
  it('falls back to a post link and refuses non-http links', () => {
    expect(findWebVersionUrl({ html: '<a href="https://sam.substack.com/p/the-post?r=1">The post</a>' })).toBe('https://sam.substack.com/p/the-post?r=1');
    expect(findWebVersionUrl({ html: '<a href="javascript:alert(1)">View online</a>' })).toBeNull();
    expect(findWebVersionUrl({ html: '<a href="https://example.com/">Home</a>', text: 'nothing' })).toBeNull();
  });
});

describe('save payload', () => {
  const msg = { subject: 'Issue 12', from_name: 'Sam', from_email: 'sam@letters.example.org', html: '<p>hi</p>' };
  it('builds the POST /api/v1/save body', () => {
    expect(buildSavePayload(msg, 'https://x.example/p/1', { tags: 'Newsletter, hedwig,,', sendHtml: true })).toEqual({
      url: 'https://x.example/p/1', title: 'Issue 12', tags: ['newsletter', 'hedwig'], note: 'Newsletter from Sam <sam@letters.example.org>, saved by Hedwig.', html: '<p>hi</p>',
    });
    expect(buildSavePayload(msg, 'https://x.example/p/1', { sendHtml: false }).html).toBeUndefined();
  });
  it('targets /api/v1/save under the configured base URL', () => {
    expect(saveEndpoint('https://pensieve.brainfc.uk')).toBe('https://pensieve.brainfc.uk/api/v1/save');
    expect(saveEndpoint('https://example.com/pensieve/')).toBe('https://example.com/pensieve/api/v1/save');
  });
  it('maps Pensieve answers', () => {
    expect(outcome(201, { id: 'i1', open: 'https://p/items/i1' })).toEqual({ status: 'saved', itemId: 'i1', open: 'https://p/items/i1', created: true });
    expect(outcome(401, {}).status).toBe('auth_error');
    expect(outcome(422, { error: 'Only http and https links can be saved.' })).toEqual({ status: 'rejected', error: 'Only http and https links can be saved.' });
    expect(outcome(502, null).status).toBe('error');
  });
  it('detects newsletters and parses tags', () => {
    expect(looksLikeNewsletter({ from_email: 'sam@sam.substack.com' })).toBe(true);
    expect(looksLikeNewsletter({ from_email: 'no-reply@bank.example', has_list_unsubscribe: true, subject: 'Reset your password' })).toBe(false);
    expect(parseTags(' A , b ')).toEqual(['a', 'b']);
  });
});
