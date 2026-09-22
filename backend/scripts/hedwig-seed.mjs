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
msg('work', 'Sent Items', 'Prakhar', 'prakhar@vantage.example', ['priya.nair@vantage.example'], 'Re: Visa sponsorship', 'Thanks Priya. Passport scan and degree certificate attached. I will send the signed form once the solicitor confirms the reference number.', 15, { thread: 'visa', mid: 'visa-4', replyTo: 'visa-3', read: true, attachments: [{ filename: 'passport.pdf', size: 120000 }, { filename: 'degree.pdf', size: 90000 }] });
msg('personal', 'INBOX', 'Thomas Reed', 'thomas@reedlaw.example', ['prakhar.demo@gmail.com'], 'Re: Sponsorship application – reference number', 'Reference VNT-2026-0448 is confirmed. I will send biometrics appointment slots early next week.', 8, { thread: 'visa-sol', mid: 'visa-5', replyTo: 'visa-2', read: true });
msg('work', 'INBOX', 'Priya Nair', 'priya.nair@vantage.example', ['prakhar@vantage.example'], 'Re: Visa sponsorship — final documents by 30 Sep', 'Hi Prakhar, a reminder that the signed sponsorship form and your last three payslips are due to the solicitor by 30 September. Everything else from your side is in. Can you send them this week?\n\nPriya', 2, { thread: 'visa', mid: 'visa-6', replyTo: 'visa-4', read: false });

// Invoice that contradicts a quote.
msg('domain', 'INBOX', 'Marta Kowalski', 'marta@kowalski-design.example', ['me@prafiles.example'], 'Quote for the landing page redesign', 'Hello! As discussed, the landing page redesign will be €1,600 all-in, delivered by end of August.\n\nMarta', 103, { thread: 'marta', mid: 'marta-1', read: true });
msg('domain', 'Sent', 'Prakhar', 'me@prafiles.example', ['marta@kowalski-design.example'], 'Re: Quote for the landing page redesign', 'Sounds good, let us go ahead at €1,600.', 102, { thread: 'marta', mid: 'marta-2', replyTo: 'marta-1', read: true });
msg('domain', 'INBOX', 'Marta Kowalski', 'marta@kowalski-design.example', ['me@prafiles.example'], 'Invoice 2041', 'Please find invoice 2041 attached for the landing page work: €1,840 due within 14 days.\n\nThanks!', 0.4, { thread: 'marta', mid: 'marta-3', replyTo: 'marta-2', read: false, attachments: [{ filename: 'invoice-2041.pdf', size: 80000 }] });

// Doctor and landlord asking questions.
msg('personal', 'INBOX', 'Dr Anand', 'reception@anandclinic.example', ['prakhar.demo@gmail.com'], 'Follow-up appointment options', 'We have Tuesday 10:30 or Thursday 16:00 available for your follow-up. Which would you prefer?', 7, { thread: 'doc', mid: 'doc-1', read: true });
msg('personal', 'INBOX', 'Dr Anand', 'reception@anandclinic.example', ['prakhar.demo@gmail.com'], 'Re: Follow-up appointment options', 'Just checking in — could you confirm which slot works? We will release them on Friday.', 1, { thread: 'doc', mid: 'doc-2', replyTo: 'doc-1', read: false });
msg('domain', 'INBOX', 'Sam Wilson', 'sam.wilson@lettings.example', ['me@prafiles.example'], 'Boiler inspection Thursday?', 'Hi, the engineer can come on Thursday between 8 and 12 for the annual boiler inspection. Is someone going to be in?', 1.1, { thread: 'boiler', mid: 'boiler-1', read: false });

// Waiting on: user asked, nobody answered.
msg('work', 'Sent Items', 'Prakhar', 'prakhar@vantage.example', ['ops@vantage.example'], 'Laptop replacement request', 'Hi Ops, my laptop battery is failing. Can we get a replacement before the offsite on the 10th?', 6, { thread: 'laptop', mid: 'laptop-1', read: true });

// Personal money thread.
msg('personal', 'INBOX', 'Amaan Qureshi', 'amaan.q@gmail.com', ['prakhar.demo@gmail.com'], 'Trip photos + splitting the cabin cost', 'Photos are in the shared album. Cabin was £640 total, so £160 each — can you send yours when you get a sec?', 3, { thread: 'trip', mid: 'trip-1', read: true });

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
    for (const [path, special] of [['INBOX', null], ['Sent', '\\Sent'], ['Sent Items', '\\Sent'], ['Junk', '\\Junk']]) {
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
                            in_reply_to, thread_id, is_bulk, list_unsubscribe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$7,$9,'[]',$10,$11,$12,$13,false,$14,$15,$16,$17,$18,$19)`,
      [id, accountIds[m.account], m.uid, m.folder, messageId, m.subject, m.fromName, m.fromEmail,
        JSON.stringify(m.to.map((address) => ({ address, name: '' }))), m.date, m.body.slice(0, 180), m.body,
        m.read ?? false, Boolean(m.attachments), JSON.stringify(m.attachments || []), inReplyTo, threadId,
        Boolean(m.bulk), m.bulk ? `<mailto:unsubscribe@${m.fromEmail.split('@')[1]}>` : null],
    );
  }
  console.log(`Seeded ${T.length} messages across ${ACCOUNTS.length} accounts. Login: ${EMAIL} / ${PASSWORD}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
