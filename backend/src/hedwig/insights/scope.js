// SQL building blocks every insight query shares. All of them scope to one user's accounts through
// the email_accounts join, so a query built from these can never see another user's mail.
//
// A message is "outgoing" when it sits in a \Sent folder or was written from one of the user's own
// addresses (the same rule as pipeline.decorate). Junk, Trash and Drafts never count, and copies of
// one message in several folders (Gmail labels) count once per account.

/** CTE `addrs(e)`: the user's own addresses. Expects the user id as `$1`. */
export const ADDRS_CTE = `
  addrs AS (
    SELECT lower(a.email_address) AS e FROM email_accounts a WHERE a.user_id = $1
    UNION
    SELECT lower(al.email) FROM account_aliases al JOIN email_accounts a ON a.id = al.account_id WHERE a.user_id = $1
  )`;

/**
 * CTE `um`: the user's messages dated after `sinceExpr`, one row per (account, Message-ID).
 * Needs ADDRS_CTE before it and the user id as `$1`.
 */
export function userMessagesCte(sinceExpr, { name = 'um', extraColumns = '' } = {}) {
  return `
  ${name} AS (
    SELECT DISTINCT ON (m.account_id, COALESCE(m.message_id, m.id::text))
           m.id, m.account_id, m.folder, m.date, lower(m.from_email) AS from_email, m.from_name, m.subject,
           m.is_read, m.is_starred, m.thread_key, m.to_addresses,
           (COALESCE(m.is_bulk, false) OR m.list_unsubscribe IS NOT NULL) AS bulk,
           (COALESCE(f.special_use, '') = '\\Sent' OR lower(m.from_email) IN (SELECT e FROM addrs)) AS outgoing
           ${extraColumns}
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
     WHERE m.is_deleted = false
       AND m.date >= ${sinceExpr}
       AND m.date <= NOW() + INTERVAL '1 day'
       AND COALESCE(f.special_use, '') NOT IN ('\\Junk', '\\Trash', '\\Drafts')
       AND m.folder !~* '(^|[/.])(spam|junk|trash|bin|deleted items|deleted messages|drafts)$'
     ORDER BY m.account_id, COALESCE(m.message_id, m.id::text), (COALESCE(f.special_use, '') = '\\Sent') DESC, m.date DESC
  )`;
}
