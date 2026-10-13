# Connectors: Hedwig in Claude, ChatGPT and other MCP apps

Hedwig is a remote [MCP](https://modelcontextprotocol.io) server. Anyone with a Hedwig account can
add it to Claude, ChatGPT, Claude Code or another MCP client and use their mail from there: list
what needs them, read and summarise conversations, ask questions across all their accounts,
re-sort mail, archive, snooze, keep work lists and save reply drafts.

The connector URL is your Hedwig address followed by `/mcp`, for example
`https://hedwig.example.com/mcp`. Settings → Connectors shows it with a copy button.

## Adding it

| App | Where |
| --- | --- |
| Claude (web, desktop, mobile) | Settings → Connectors → Add custom connector. Paste the URL, choose Connect. |
| ChatGPT | Settings → Apps & Connectors → Advanced settings, turn on Developer mode. Create, paste the URL, choose OAuth. |
| Claude Code | `claude mcp add --transport http hedwig https://hedwig.example.com/mcp`, then `/mcp` to sign in. |
| Others | Any client that speaks Streamable HTTP and OAuth 2.1 with dynamic client registration. |

The app opens Hedwig's **/connect** page. Sign in to Hedwig if you are not already, check which app
is asking and where it will send you back to, and choose **Allow**. Untick "Also let it organise your
mail" to connect read-only. Settings → Connectors lists every connected app with when it was last
used, the changes it made, and a Disconnect button that stops it at once.

## What a connected app can do

Read (always):

| Tool | |
| --- | --- |
| `search`, `fetch` | Find messages and read one in full (the shapes ChatGPT's deep research uses) |
| `ask` | Hedwig's Ask: searches several ways and answers with cited sources |
| `list_mail` | Needs you, People, Reading, Records, the Screener or Spam, with one-line summaries |
| `list_categories`, `explain_category`, `sorting_log`, `list_screener` | How Hedwig sorts, why a message landed where it did, today's changes |
| `summarize_thread`, `get_thread` | The story of a conversation, its timeline, deadline and quick replies |
| `get_list`, `list_waiting_on`, `list_cards` | Work lists, unanswered questions, receipts/bills/deliveries/travel |
| `search_mail`, `get_person`, `list_topics`, `get_topic`, `list_commitments`, `get_briefing`, `get_overview`, `list_accounts`, `today`, `list_automations` | The agent's read tools |

Organise (only when allowed on /connect):

| Tool | |
| --- | --- |
| `categorize`, `screen_sender`, `undo_sorting` | Re-sort a message (optionally everything from its sender or list), decide on a new sender, undo |
| `archive_message`, `move_message`, `mark_read`, `star_message`, `snooze` | Mail changes, each reversible |
| `add_to_list`, `remove_from_list`, `remind_if_no_reply` | Reply later, set aside, pin, done, reminders, waiting-on watches |
| `draft_reply` | Saves a reply in the account's Drafts folder for you to send |
| `create_commitment`, `complete_commitment`, `update_commitment` | Commitments Hedwig tracks |

Nothing sends or deletes mail. Plugin tools appear too, for plugins you enabled and granted.

## How it works

- `POST /mcp`: Streamable HTTP with JSON responses, stateless (no session id), protocol versions
  2024-11-05 to 2025-11-25. `GET` and `DELETE` answer 405.
- OAuth 2.1 (`backend/src/hedwig/mcp/oauth.js`): protected-resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource/mcp`, server metadata (RFC 8414) at
  `/.well-known/oauth-authorization-server`, dynamic client registration (RFC 7591) at
  `/mcp/oauth/register`, PKCE S256 only, resource indicators (RFC 8707), the `iss` authorization
  response parameter (RFC 9207), and revocation (RFC 7009). Scopes: `mail.read`, `mail.write`.
- Access tokens last an hour, refresh tokens 90 days and rotate on use. Tokens, codes and client
  secrets are stored as SHA-256 hashes only.
- The reverse proxy must pass `/mcp`, `/mcp/oauth/` and `/.well-known/oauth-` to the API
  (`frontend/nginx.conf` and `contrib/nginx.conf` do), and `APP_URL` must be the public origin.
