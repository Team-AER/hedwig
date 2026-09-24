// Seed a development database with a realistic multi-account mailbox for Hedwig work.
//   node scripts/hedwig-seed.mjs            (idempotent: removes and recreates the demo user)
// Login: demo / hedwig-demo-password
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { pool, query } from '../src/services/db.js';

const EMAIL = 'demo';
const PASSWORD = 'hedwig-demo-password';
const now = Date.now();
const day = 86400_000;
const at = (daysAgo, hour = 9) => new Date(now - daysAgo * day + (hour - 12) * 3600_000);

const ACCOUNTS = [
  { key: 'personal', name: 'Gmail · personal', email: 'prakhar.demo@gmail.com', color: '#C14A3A', host: 'imap.gmail.com' },
  { key: 'work', name: 'Outlook · work', email: 'prakhar@vantage.example', color: '#2B5FAE', host: 'outlook.office365.com' },
  { key: 'domain', name: 'prafiles.in', email: 'me@prafiles.example', color: '#1F6B66', host: 'mail.prafiles.example' },
];

// HTML bodies for the reader: a newsletter (600px table layout, remote images, a pull quote), an
// order confirmation (logo, order table, tracking number) and a reply whose history sits in a
// gmail_quote block. Remote images are https so the body route serves them from the cache. The
// newsletter also carries one inline (data:) illustration, which shows even with remote images
// blocked, so dark mode's counter-inverted images can be checked.
const NEWSLETTER_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;background:#ffffff;font-family:Georgia,serif;color:#222">
<tr><td style="padding:20px 32px;border-bottom:3px solid #c0392b"><img src="https://placehold.co/160x40/png?text=The+Ken" width="160" height="40" alt="The Ken"></td></tr>
<tr><td><img src="https://placehold.co/600x260/png?text=Dark+stores" width="600" height="260" alt="A dark store at night" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:16px 32px 0"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='200' viewBox='0 0 600 200'%3E%3Cdefs%3E%3ClinearGradient id='s' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%232B4C9B'/%3E%3Cstop offset='.55' stop-color='%23F27A54'/%3E%3Cstop offset='1' stop-color='%23FFC56E'/%3E%3C/linearGradient%3E%3CradialGradient id='g' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23FFF4C2'/%3E%3Cstop offset='1' stop-color='%23FFB347'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='600' height='200' fill='url%28%23s%29'/%3E%3Ccircle cx='430' cy='128' r='42' fill='url%28%23g%29'/%3E%3Cpath d='M0 150 Q120 110 240 142 T480 136 T600 128 V200 H0Z' fill='%231F6B3A'/%3E%3Cpath d='M0 172 Q150 146 300 168 T600 160 V200 H0Z' fill='%230F3D22'/%3E%3Cg fill='%2316213E'%3E%3Crect x='60' y='96' width='34' height='70'/%3E%3Crect x='100' y='74' width='26' height='92'/%3E%3Crect x='132' y='112' width='40' height='54'/%3E%3C/g%3E%3C/svg%3E" width="536" height="179" alt="Illustration: dusk over the city's dark stores" style="display:block;width:100%;height:auto;border-radius:4px"></td></tr>
<tr><td style="padding:24px 32px 8px"><h1 style="margin:0 0 12px;font-size:26px;line-height:1.25">Quick commerce is a real-estate war</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">The ten-minute delivery promise is not won with apps. It is won with leases: whoever holds the small, ugly warehouses inside dense neighbourhoods sets the price for everyone else.</p>
<blockquote style="margin:18px 0;padding:0 0 0 16px;border-left:3px solid #c0392b;font-size:19px;line-height:1.45;font-style:italic">"We stopped thinking of ourselves as a grocer. We are a landlord that happens to sell milk."</blockquote>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Rents for sub-2,000 sq ft units near metro stations have risen 38% in eighteen months, and the three largest players now hold a majority of them in Bengaluru.</p>
<p style="margin:0 0 24px"><a href="https://the-ken.example/story/quick-commerce-real-estate" style="background:#c0392b;color:#fff;padding:10px 18px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px">Read the full story</a></p></td></tr>
<tr><td style="padding:16px 32px;background:#faf8f3;font-family:Arial,sans-serif;font-size:12px;color:#777">Delivered to prakhar.demo@gmail.com. Subscriber to The Ken Daily. <a href="https://the-ken.example/unsubscribe" style="color:#777">Unsubscribe</a></td></tr>
</table></td></tr></table>`;

const ORDER_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
<tr><td style="padding:20px 0"><img src="https://placehold.co/140x40/png?text=Northwind" width="140" height="40" alt="Northwind Store"></td></tr>
<tr><td style="padding:0 0 12px"><h2 style="margin:0;font-size:22px">Thanks, your order is confirmed</h2>
<p style="margin:8px 0 0;font-size:14px;color:#555">Order NW-58213 · placed 23 September 2026</p></td></tr>
<tr><td><table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:14px">
<tr style="background:#f5f5f7"><th align="left">Item</th><th align="center">Qty</th><th align="right">Price</th></tr>
<tr><td style="border-bottom:1px solid #e5e5ea"><img src="https://placehold.co/48x48/png?text=Hub" width="48" height="48" alt="" style="vertical-align:middle;margin-right:8px">Anker 7-in-1 USB-C hub</td><td align="center" style="border-bottom:1px solid #e5e5ea">1</td><td align="right" style="border-bottom:1px solid #e5e5ea">£39.99</td></tr>
<tr><td style="border-bottom:1px solid #e5e5ea">USB-C cable, 2 m</td><td align="center" style="border-bottom:1px solid #e5e5ea">2</td><td align="right" style="border-bottom:1px solid #e5e5ea">£17.98</td></tr>
<tr><td colspan="2" align="right"><strong>Total</strong></td><td align="right"><strong>£57.97</strong></td></tr>
</table></td></tr>
<tr><td style="padding:16px 0;font-size:14px">Shipping with Royal Mail Tracked 24. Tracking number: <span style="font-family:Menlo,monospace">RM284615093GB</span><br>Arriving Friday 26 September.</td></tr>
<tr><td style="padding:12px 0 24px"><a href="https://northwind-store.example/orders/NW-58213" style="color:#0062cc">View or manage your order</a></td></tr>
</table></td></tr></table>`;

const DOCTOR_REPLY_HTML = `<div dir="ltr"><p>Just checking in: could you confirm which slot works? We will release them on Friday.</p><p>Kind regards,<br>Reception, Anand Clinic</p></div>
<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, 17 Sep 2026 at 09:02, Dr Anand &lt;reception@anandclinic.example&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><div dir="ltr">We have Tuesday 10:30 or Thursday 16:00 available for your follow-up. Which would you prefer?</div></blockquote></div>`;

// thread: [account, folder, fromName, fromEmail, to, subject, body, daysAgo, opts]
const T = [];
let uid = 1000;
function msg(account, folder, fromName, fromEmail, to, subject, body, daysAgo, opts = {}) {
  T.push({ account, folder, fromName, fromEmail, to, subject, body, date: at(daysAgo, opts.hour ?? 9), ...opts, uid: uid++ });
}

// Visa sponsorship: spans two accounts and three people.
msg('work', 'INBOX', 'Priya Nair', 'priya.nair@vantage.example', ['prakhar@vantage.example'], 'Visa sponsorship', 'Hi Prakhar,\n\nGood news: Vantage will sponsor your visa. HR will introduce a solicitor shortly.\n\nPriya', 132, { thread: 'visa', mid: 'visa-1' });
msg('personal', 'INBOX', 'Thomas Reed', 'thomas@reedlaw.example', ['prakhar.demo@gmail.com'], 'Sponsorship application – fees and timeline', 'Dear Prakhar,\n\nOur fee is £1,450 plus the government fee. The timeline is 8–10 weeks from submission. I will need your passport scan and degree certificate.\n\nKind regards,\nThomas Reed\nReed Immigration Law', 103, { thread: 'visa-sol', mid: 'visa-2' });
msg('work', 'INBOX', 'Priya Nair', 'priya.nair@vantage.example', ['prakhar@vantage.example'], 'Re: Visa sponsorship', 'Solicitor engaged (Thomas Reed). Expect a request for documents within two weeks.', 21, { thread: 'visa', mid: 'visa-3', replyTo: 'visa-1' });
msg('work', 'Sent Items', 'Prakhar', 'prakhar@vantage.example', ['priya.nair@vantage.example'], 'Re: Visa sponsorship', 'Thanks Priya. Passport scan and degree certificate attached. I will send the signed form once the solicitor confirms the reference number.', 15, { thread: 'visa', mid: 'visa-4', replyTo: 'visa-3', read: true, attachments: [{ part: '2', filename: 'passport.pdf', type: 'application/pdf', size: 120000 }, { part: '3', filename: 'degree.pdf', type: 'application/pdf', size: 90000 }] });
msg('personal', 'INBOX', 'Thomas Reed', 'thomas@reedlaw.example', ['prakhar.demo@gmail.com'], 'Re: Sponsorship application – reference number', 'Reference VNT-2026-0448 is confirmed. I will send biometrics appointment slots early next week.', 8, { thread: 'visa-sol', mid: 'visa-5', replyTo: 'visa-2', read: true });
msg('work', 'INBOX', 'Priya Nair', 'priya.nair@vantage.example', ['prakhar@vantage.example'], 'Re: Visa sponsorship — final documents by 30 Sep', 'Hi Prakhar, a reminder that the signed sponsorship form and your last three payslips are due to the solicitor by 30 September. Everything else from your side is in. Can you send them this week?\n\nPriya', 2, { thread: 'visa', mid: 'visa-6', replyTo: 'visa-4', read: false });

// Invoice that contradicts a quote.
msg('domain', 'INBOX', 'Marta Kowalski', 'marta@kowalski-design.example', ['me@prafiles.example'], 'Quote for the landing page redesign', 'Hello! As discussed, the landing page redesign will be €1,600 all-in, delivered by end of August.\n\nMarta', 103, { thread: 'marta', mid: 'marta-1', read: true });
msg('domain', 'Sent', 'Prakhar', 'me@prafiles.example', ['marta@kowalski-design.example'], 'Re: Quote for the landing page redesign', 'Sounds good, let us go ahead at €1,600.', 102, { thread: 'marta', mid: 'marta-2', replyTo: 'marta-1', read: true });
msg('domain', 'INBOX', 'Marta Kowalski', 'marta@kowalski-design.example', ['me@prafiles.example'], 'Invoice 2041', 'Please find invoice 2041 attached for the landing page work: €1,840 due within 14 days.\n\nThanks!', 0.4, { thread: 'marta', mid: 'marta-3', replyTo: 'marta-2', read: false, attachments: [{ part: '2', filename: 'invoice-2041.pdf', type: 'application/pdf', size: 80000 }] });

// Doctor and landlord asking questions.
msg('personal', 'INBOX', 'Dr Anand', 'reception@anandclinic.example', ['prakhar.demo@gmail.com'], 'Follow-up appointment options', 'We have Tuesday 10:30 or Thursday 16:00 available for your follow-up. Which would you prefer?', 7, { thread: 'doc', mid: 'doc-1', read: true });
msg('personal', 'INBOX', 'Dr Anand', 'reception@anandclinic.example', ['prakhar.demo@gmail.com'], 'Re: Follow-up appointment options', 'Just checking in: could you confirm which slot works? We will release them on Friday.\n\nKind regards,\nReception, Anand Clinic\n\nOn Wed, 17 Sep 2026 at 09:02, Dr Anand <reception@anandclinic.example> wrote:\n> We have Tuesday 10:30 or Thursday 16:00 available for your follow-up. Which would you prefer?', 1, { thread: 'doc', mid: 'doc-2', replyTo: 'doc-1', read: false, html: DOCTOR_REPLY_HTML });
msg('domain', 'INBOX', 'Sam Wilson', 'sam.wilson@lettings.example', ['me@prafiles.example'], 'Boiler inspection Thursday?', 'Hi, the engineer can come on Thursday between 8 and 12 for the annual boiler inspection. Is someone going to be in?', 1.1, { thread: 'boiler', mid: 'boiler-1', read: false });

// Two saved drafts in the personal account's Drafts folder: a reply at the end of the clinic
// thread (the reader shows it as a draft block with Edit draft) and a new message with no
// recipient yet (the Drafts view shows "No recipient").
msg('personal', 'Drafts', 'Prakhar', 'prakhar.demo@gmail.com', ['reception@anandclinic.example'], 'Re: Follow-up appointment options', 'Hi, Thursday 16:00 works for me. Could you also send the', 0.1, { thread: 'doc', mid: 'doc-draft', replyTo: 'doc-2', read: true, hour: 11 });
msg('personal', 'Drafts', 'Prakhar', 'prakhar.demo@gmail.com', [], 'Cabin trip: what I owe', 'Amaan, sending my £160 for the cabin tonight. Also, for next year', 1.6, { mid: 'trip-draft', read: true });

// Waiting on: user asked, nobody answered.
msg('work', 'Sent Items', 'Prakhar', 'prakhar@vantage.example', ['ops@vantage.example'], 'Laptop replacement request', 'Hi Ops, my laptop battery is failing. Can we get a replacement before the offsite on the 10th?', 6, { thread: 'laptop', mid: 'laptop-1', read: true });

// Personal money thread.
msg('personal', 'INBOX', 'Amaan Qureshi', 'amaan.q@gmail.com', ['prakhar.demo@gmail.com'], 'Trip photos + splitting the cabin cost', 'Photos are in the shared album. Cabin was £640 total, so £160 each — can you send yours when you get a sec?', 3, { thread: 'trip', mid: 'trip-1', read: true });

// A newsletter and an order confirmation with real layouts (HTML bodies).
msg('personal', 'INBOX', 'The Ken', 'daily@the-ken.example', ['prakhar.demo@gmail.com'], 'Quick commerce is a real-estate war', 'Quick commerce is a real-estate war\n\nThe ten-minute delivery promise is not won with apps. It is won with leases.\n\n"We stopped thinking of ourselves as a grocer. We are a landlord that happens to sell milk."\n\nRead the full story: https://the-ken.example/story/quick-commerce-real-estate\n\nDelivered to prakhar.demo@gmail.com. Subscriber to The Ken Daily.', 0.25, { bulk: true, read: false, mid: 'ken-1', html: NEWSLETTER_HTML });
msg('personal', 'INBOX', 'Northwind Store', 'orders@northwind-store.example', ['prakhar.demo@gmail.com'], 'Order NW-58213 confirmed: Anker 7-in-1 USB-C hub', 'Thanks, your order is confirmed.\n\nOrder NW-58213\nAnker 7-in-1 USB-C hub x1  £39.99\nUSB-C cable, 2 m x2  £17.98\nTotal £57.97\n\nTracking number: RM284615093GB (Royal Mail Tracked 24). Arriving Friday 26 September.', 0.5, { bulk: true, read: false, mid: 'order-1', html: ORDER_HTML });

// Notifications and newsletters (bulk).
const bulk = [
  ['GitHub', 'notifications@github.com', 'personal', '[Team-AER/pensieve] CI failed on main', 'Run failed: test (3.12). 2 tests failed in tests/test_ai.py.'],
  ['GitHub', 'notifications@github.com', 'personal', '[Team-AER/hedwig] New issue: plugin loader', 'Opened by a contributor: plugin loader should support git URLs.'],
  ['Money Stuff', 'newsletter@moneystuff.example', 'personal', 'Money Stuff: The bond market is weird again', 'Today: bonds, crypto ETFs, and a very strange merger.'],
  ['Money Stuff', 'newsletter@moneystuff.example', 'personal', 'Money Stuff: Everything is securities fraud', 'A long-running theme returns.'],
  ['The Batch', 'thebatch@deeplearning.example', 'personal', 'The Batch: new open-weight models', 'This week in AI: open-weight releases and benchmark debates.'],
  ['LinkedIn', 'messages-noreply@linkedin.example', 'work', 'You appeared in 12 searches this week', 'See who is looking at your profile.'],
  ['Hetzner', 'info@hetzner.example', 'domain', 'Server auction: your watched config is available', 'The AX52 configuration you watched is available at €39/month for the next 48 hours.'],
  ['Amazon', 'order-update@amazon.example', 'personal', 'Your order has shipped: USB-C dock', 'Order 204-5521 shipped. Total £89.99. Arriving Thursday.'],
  ['Uber Receipts', 'receipts@uber.example', 'personal', 'Your Thursday evening trip with Uber', 'Total £23.40. Thanks for riding.'],
  ['Notion', 'team@notion.example', 'work', 'What is new in Notion this month', 'Product updates you might have missed.'],
];
bulk.forEach(([name, email, account, subject, body], i) => {
  for (let k = 0; k < 3; k++) {
    msg(account, 'INBOX', name, email, [ACCOUNTS.find((a) => a.key === account).email], k ? `${subject} (${k + 1})` : subject, body, i * 1.3 + k * 9 + 0.2, { bulk: true, read: k > 0 || i % 2 === 0, mid: `bulk-${i}-${k}` });
  }
});

// Spam.
msg('domain', 'INBOX', 'Account Security', 'billing@fast-crypto-win.example', ['me@prafiles.example'], 'URGENT: verify your wallet to claim 2.4 BTC', 'Click here immediately to verify your wallet or lose your reward forever.', 0.3, { mid: 'spam-1', read: false });

// Older history for people cards.
for (let i = 0; i < 12; i++) {
  msg('work', 'INBOX', 'Priya Nair', 'priya.nair@vantage.example', ['prakhar@vantage.example'], `Team update ${i + 1}`, `Weekly HR notes #${i + 1}: holidays, benefits window, and the offsite plan.`, 30 + i * 14, { bulk: false, read: true, mid: `hr-${i}` });
}

async function main() {
  await query('DELETE FROM users WHERE username = $1', [EMAIL]);
  const userId = randomUUID();
  await query(
    `INSERT INTO users (id, username, password_hash, display_name, is_admin, preferences) VALUES ($1, $2, $3, 'Prakhar (demo)', true, $4)`,
    [userId, EMAIL, await bcrypt.hash(PASSWORD, 12), JSON.stringify({ enabledPlugins: [] })],
  );
  const accountIds = {};
  for (const a of ACCOUNTS) {
    const id = randomUUID();
    accountIds[a.key] = id;
    await query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, color, protocol, imap_host, smtp_host, auth_user, enabled)
       VALUES ($1,$2,$3,$4,$5,'imap',$6,$6,$4,false)`,
      [id, userId, a.name, a.email, a.color, a.host],
    );
    for (const [path, special] of [['INBOX', null], ['Sent', '\\Sent'], ['Sent Items', '\\Sent'], ['Drafts', '\\Drafts'], ['Junk', '\\Junk']]) {
      await query('INSERT INTO folders (account_id, path, name, special_use) VALUES ($1,$2,$2,$3) ON CONFLICT DO NOTHING', [id, path, special]);
    }
  }
  const midToRowId = {};
  for (const m of T) {
    const id = randomUUID();
    const messageId = `<${m.mid || randomUUID()}@hedwig.test>`;
    midToRowId[m.mid] = messageId;
    const inReplyTo = m.replyTo ? `<${m.replyTo}@hedwig.test>` : null;
    const threadId = m.thread ? `<${m.thread}-root@hedwig.test>` : null;
    await query(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, sender_email, sender_name,
                            to_addresses, cc_addresses, date, snippet, body_text, is_read, is_starred, has_attachments, attachments,
                            in_reply_to, thread_id, is_bulk, list_unsubscribe, body_html)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$7,$9,'[]',$10,$11,$12,$13,false,$14,$15,$16,$17,$18,$19,$20)`,
      [id, accountIds[m.account], m.uid, m.folder, messageId, m.subject, m.fromName, m.fromEmail,
        JSON.stringify(m.to.map((address) => ({ address, name: '' }))), m.date, m.body.slice(0, 180), m.body,
        m.read ?? false, Boolean(m.attachments), JSON.stringify(m.attachments || []), inReplyTo, threadId,
        Boolean(m.bulk), m.bulk ? `<mailto:unsubscribe@${m.fromEmail.split('@')[1]}>` : null, m.html || null],
    );
  }
  console.log(`Seeded ${T.length} messages across ${ACCOUNTS.length} accounts. Login: ${EMAIL} / ${PASSWORD}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
