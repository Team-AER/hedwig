import { describe, it, expect } from 'vitest';
import { messageText } from './text.js';
import { splitBody,splitHtml } from './indexer/parse.js';
import { convert } from './htmlToText.js';
import { detectOrders } from './cards/detect/orders.js';
import { snippetFromBody } from '../services/messageParser.js';

export const order = {
  body_text: 'This is a HTML email and your email client software does not support HTML email!',
  body_html: '<p>Thank you for your order.</p><table><tr><th>Order ID</th><td>1547718</td></tr><tr><th>Order Status</th><td>Payment Received</td></tr><tr><th>Shipping</th><td>Expected delivery within 4 days</td></tr></table>',
};

describe('HTML evidence reaches intelligence', () => {
  it.each([
    ['models and tools', (r) => messageText(r)],
    ['summaries and index', (r) => splitBody(r).newText],
    ['mail previews', (r) => snippetFromBody(r.body_text, r.body_html)],
  ])('%s reads the order instead of the MIME notice', (_name, read) => {
    expect(read(order)).toContain('Payment Received');
    expect(read(order)).not.toContain('does not support HTML');
  });
  it('keeps a distinct plain alternative when HTML quote segmentation runs', () => {
    const r={body_text:'Please bring your signed contract and budget documents to the office meeting tomorrow.',
      body_html:'<p>Your order 1547718 is confirmed. Payment received ₹1240 INR. Items ship to Delhi within four working days. Shipment tracking is available from your account page.</p><div class="gmail_signature">Shop support</div>'};
    expect(messageText(r)).toContain('signed contract');
    expect(splitBody(r).newText).toContain('signed contract');
    expect(splitBody(r).newText).toContain('1547718');
  });
  it('honors selected plain evidence when a different HTML part has quote markup', () => {
    const text='Please bring your signed contract and budget documents to the office meeting tomorrow.';
    const row={body_text:text,body_html:'<p>Hello</p><div class="gmail_quote">Old unrelated text</div>'};
    expect(splitBody(row).newText).toBe(text);
  });
  it('bounds structural quote segmentation before building a deep DOM', () => {
    expect(splitHtml('<div class="gmail_quote">'+'<div>'.repeat(512)+'old'+'</div>'.repeat(512)+'</div>')).toBeNull();
  });
  it('keeps table cells separate', () => {
    expect(convert('<table><tr><td>Order</td><td>1547718</td><td>Total</td><td>₹1,240</td></tr></table>')).toMatch(/Order\s+\|\s+1547718\s+\|\s+Total\s+\|\s+₹1,240/);
  });
  it('detects references and totals in HTML table cells without a subject reference', () => {
    const cards=detectOrders({ id:'order',subject:'Order confirmation',body_html:'<p>Thank you for your order</p><table><tr><th>Order ID</th><td>1547718</td></tr><tr><th>Total</th><td>₹1,240.00</td></tr></table>' });
    expect(cards[0].fields.orderNumber).toBe('1547718');
    expect(cards[0].fields.total).toBe(1240);
  });
  it('keeps link destinations and excludes hidden bait', () => {
    const text = convert('<div style="display:none">Hidden promotion</div><a href="https://shop.example/track/123">Track order</a>');
    expect(text).toContain('https://shop.example/track/123');
    expect(text).not.toContain('Hidden promotion');
  });
});
