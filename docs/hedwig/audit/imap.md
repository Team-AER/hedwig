# Audit: IMAP sync on the Yahoo account (area E, 2026-09-24)

Scope: `backend/src/services/imapManager.js` (upstream file), imapflow 1.7.8 as vendored in
`backend/node_modules/imapflow`, `backend/src/hedwig/core/mailYield.js`. Evidence is read-only
production data: backend logs (`prodlogs.sh`) and SELECT queries (`prodsql.sh`).

## Summary

1. **The every-6-minutes failure is not a provider refusal.** Yahoo ends each persistent session
   about 300 s after it connects. The reconnect happens *inside* a sync tick and the tick
   interval is 60 s, so the fifth tick after every reconnect fires at the same moment the session
   is cut. That tick's pending command is rejected with imapflow's generic
   `Connection not available`. `isConnectionRefusal` matches that text, so the tick is lost and a
   30 s refusal cooldown is armed. The next tick reconnects, and the cycle repeats phase-locked.
2. **The cost is one lost tick in six, plus side effects of the cooldown.** INBOX was not
   silently falling 40 minutes behind. The cooldown map is shared, so every false "refusal" also
   paused the folder-status monitor (`Folder status cycle failed … Provider connection cooldown
   active`, 13 times in 12 h), Hedwig's body fetches (`mailYield.upstreamBusy`), and the health
   check.
3. **COMPRESS=DEFLATE corrupts on Yahoo.** There were four zlib errors in 12 h
   (`invalid distance code`, `invalid distance too far back`, `invalid literal/length code`).
   Each one killed a connection.
4. **Ticks were not silent, and the audit premise needs correcting.** `email_accounts.last_sync`
   is stamped only by `syncMessages`. It advances every minute at hh:mm:43, which is the tick
   phase, on the same session that later dies at 300 s. So the 60 s ticks do reach Yahoo, and the
   300 s cut happened on a connection that was sending UID FETCH every minute. The older packet
   capture ("client sent nothing for 300 s") does not match what current production does.
   Keeping the session busy may therefore not stop the cut. The same-tick reconnect below makes
   it harmless either way.
5. **Nothing was missing from INBOX.** No INBOX mail has arrived for this account since
   2026-09-23 02:47 UTC: 5 INBOX messages in 48 h, all at or before 02:47, against 120 in Bulk.
   Backfill reports 303/303. The staleness probe logs a warning whenever a fresh login sees UIDs
   above our watermark, and it has never logged one. Bulk mail lands within 0–3 min. So the
   missing `IMAP EXISTS` lines in 12 h mean no INBOX arrivals, not proof that IDLE is broken. The
   user's "mails are not loading" is more likely the classic shell, missing bodies
   (`fetchMessageBody … no body after retry`), and the Trash snippet indexer being refused
   (`UID FETCH Server error - Please try again later`). Those belong to other areas.

## Trace: what happens on the Yahoo persistent connection

### connectAccount

- `connectImapClient(account, resolved, { enableIdle: true, idleKeepaliveMs: 240000 })` builds the
  client from `makeClientCfg`: `commandTimeout 30000`, `maxIdleTime 240000` (Yahoo
  `idleKeepaliveMs`), `autoIdleDelay 3000` (`AUTO_IDLE_DELAY_MS`), and imapflow's default
  `socketTimeout 300000`. Before this change there was no `disableCompression`, so imapflow's
  `startSession()` ran `compress()`. Yahoo advertises COMPRESS=DEFLATE, the stream was set up
  (socket → inflate → parser, PassThrough → deflate → socket), and every byte after login was
  compressed. The zlib errors prove it was active.
- A `'close'` listener removes the client from `this.connections` if it is still the current one
  and logs `IMAP connection closed for …`. The listener in the in-tick reconnect path (see below)
  did the same but logged nothing, so every close after the first reconnect was invisible.
- Initial sync: `syncFolders` (LIST) and then `syncMessages(INBOX, 20, noBodyParts)` on the same
  client. The pool pre-warm, backfill and snippet indexer each use their own connections.
- `_startSyncInterval(account, 60000)`: the user has no `syncInterval` preference, so the default
  applies. The first tick is jittered, then `setInterval` every 60 s. In production that phase
  is hh:mm:42.

### _syncTick → syncMessages

- `activeClient = this.connections.get(id)`. If it is missing, the tick reconnects in place
  (`Reconnecting…` / `Reconnected`) and then syncs on the new client in the same tick.
- `syncMessages` runs `getMailboxLock('INBOX')`. The first call SELECTs. Later calls take
  imapflow's fast path (mailbox already selected, same mode), which sends nothing. It then runs
  `SELECT MAX(uid)` in the DB and an unconditional `UID FETCH <max+1>:*`. That FETCH is the
  traffic that stamps `last_sync` every minute. Next comes the modseq-gated flag scan
  ('unchanged' skips it), and finally `lock.release()` in a `finally`.
- **Does the mailbox stay SELECTED after `lock.release()`?** Yes. Release only clears
  `currentLock`, calls `autoidle()` and schedules the next queued lock. Nothing in
  `imapManager.js` calls `mailboxClose`, `mailboxOpen` or `idle()` on the persistent client, and
  the periodic `syncFolders` only issues LIST.
- **Is anything left pending so that `connectionBusy()` stays true?** Not permanently. The
  `for await` new-mail FETCH is drained. The one leak is the flag scan's 20 s
  `FLAG_SCAN_TIMEOUT_MS` race: if the timeout wins, the abandoned FETCH stays in `currentRequest`
  until it finishes or hits `commandTimeout` (30 s). `run()`'s `finally` then calls `autoidle()`
  again, so IDLE is postponed, not cancelled. The lock is always released.
- **Auto-IDLE.** `autoidle()` arms a 3 s timer only when `state === SELECTED` and
  `!connectionBusy()`. At fire time it re-checks both and calls `idle()`. So about 3 s after each
  tick the connection is in IDLE. `maxIdleTime` restarts IDLE after 240 s, but a 60 s tick breaks
  it first (`preCheck` sends DONE). The health check needs 3 consecutive "not idling"
  observations to warn, and `_idleMissStreak` is not reset by an in-tick reconnect. The warning
  never fired, so IDLE was observed at least once in every three checks. IDLE runs.

### The 300 s cut, as imapflow sees it

- Yahoo sends FIN (or the zlib stream breaks). imapflow's socket `'end'`/`'close'` handler calls
  `close()` synchronously, which:
  - sets `usable = false` and `idling = false`, and runs the IDLE `preCheck` if one is installed;
  - rejects the current request, every queued request, and every queued lock with
    `createNoConnectionError()`: code `NoConnection`, message `Connection not available`;
  - destroys the socket, sets `socket = null` and `state = LOGOUT`;
  - emits `mailboxClose` and then `'close'` exactly once (guarded by `isClosed`).
- **Does `'close'` fire? Does the next tick see the dead client?** `'close'` fires, and our
  listener deletes the client from `connections`. So a tick that starts *after* the cut does not
  find the dead client; it reconnects cleanly. The initial session shows this: connected
  21:49:13–19, closed unsolicited at 21:54:15 with no tick in flight, and the tick at 21:54:42
  reconnected without an error.
- **Why the error every time after that:** every later session is created by a tick at hh:mm:42.4.
  Its TCP connect lands about 0.3 s later, so the 300 s cut lands at hh:(mm+5):42.7–43.3. That
  is 0.3–1 s into the tick that fired at hh:(mm+5):42.35. The tick's lock or FETCH is pending
  when `close()` rejects it, so the error surfaces inside `syncMessages`
  (`Message sync error … Connection not available`) rather than as an absent client. Timestamps
  from 22:00 to 23:00 match this to the second on every cycle: reconnect at :42, failure at :43
  five minutes later.

### Why that was treated as a refusal, and what the cooldown did

- `isConnectionRefusal()` includes `connection not available` on purpose. When Gmail refuses a
  *new* connection under a burst, it surfaces the same imapflow error (#384). The function only
  sees the text, not whether the socket belonged to an established session, so every
  NoConnection from a dying session matched.
- `_syncTick`'s catch then called `_noteConnectionRefusal` (30 s, always `refusal #1` because the
  next successful reconnect clears it) and `_recordAccountError` (deferred by
  `ACCOUNT_ERROR_MIN_STREAK`, so the UI was not painted red). It also skipped the rest of the
  tick.
- Cost: that tick's INBOX sync was lost. The next tick, 60 s later and past the 30 s cooldown,
  reconnected and synced. Worst-case INBOX latency was therefore about 2 min, once every 6 min.
  Meanwhile the shared `_connectCooldown` made `folderStatus` skip a cycle, made
  `mailYield.upstreamBusy` defer Hedwig body fetches, and made the health check skip the account.

## Changes (imapManager.js, kept small for upstream)

1. **Provider profile.** `yahoo.disableCompression: true` and `yahoo.keepaliveNoopMs: 240000`,
   both documented in the profile header. `makeClientCfg` sets `cfg.disableCompression` from the
   profile, so the persistent, pool, backfill, snippet, poll-only and staleness-probe clients all
   run uncompressed.
2. **A dead socket is not a refusal.** `isClientUsable(client)` checks `usable !== false` and
   that the socket is not nulled or destroyed. `isDeadConnectionFailure(err, client)` returns
   true when the client is no longer usable, unless the BYE reason (`err.reason`) or the rest of
   the error text is itself a refusal ("Too many connections", `[LIMIT]`, throttle, "Maximum
   number of connections"). In `_syncTick`:
   - a client that is already unusable at tick start is dropped and the tick reconnects in place;
   - an inherited client that dies during the sync does not arm the cooldown. The tick logs
     `Persistent IMAP connection for … died during sync (…, session Ns old); not a provider
     refusal, reconnecting and syncing again now`, releases its guard, and re-runs itself once
     (`deadSocketRetry`). The re-run takes the reconnect path and syncs;
   - a client that this tick *just* connected and that dies at once still arms the refusal
     backoff, as does a retry whose replacement also dies. There is no loop, and a provider that
     really is pushing back still gets backed off. Connect-time classification
     (`isConnectionRefusal('Connection not available') === true`) is unchanged.
3. **Keepalive and IDLE verification.** Both the connect path and the in-tick reconnect install
   the client through `_trackPersistentClient`, which:
   - records when the session connected;
   - logs once what it negotiated: `IMAP session for …: compression=off (disabled for provider),
     idle=on (re-issued every 240s), keepalive=NOOP every 240s when not idling`. Compression is
     read from imapflow's live `_inflate`, so the line reports what was negotiated, not what was
     configured;
   - arms `_armPersistentKeepalive` for profiles with `keepaliveNoopMs`. Every 240 s, if the
     client is still current, usable, not idling, and no sync or connect is running, it takes an
     INBOX lock (which re-SELECTs INBOX if needed), sends NOOP and releases the lock, which
     re-arms auto-IDLE. There is deliberately no `raceTimeout` around the lock, because an
     abandoned lock request that is granted later would stay held forever. The timer is
     `unref`'d, belongs to one client, and is cleared on close, replacement and disconnect.

   After each successful tick, `_verifyIdleAfterSync` looks at `client.idling` 5 s later
   (`AUTO_IDLE_DELAY_MS` + 2 s). It logs once per connection either `IMAP IDLE active for …` or
   `IMAP IDLE not active for … (selected: …; busy: lock held / FETCH in flight / …)`, and logs the
   later transition to active once. The `'close'` log now carries the session age and whether IDLE
   was ever seen, and it fires for reconnect-path sessions too:
   `IMAP connection closed for … after 300s (IDLE was seen on it)`.
4. **A success line.** `_reportInboxSyncOk` logs `INBOX sync OK for …: +N new in Mms (session Ss
   old)`. It is logged at `logger.info` on the first successful tick of each session, whenever
   mail was inserted, and otherwise at most every 10 min (with `; K successful ticks since the last
   report`). Every other tick logs at `logger.debug`. Production runs at the default info level,
   so debug alone would have stayed invisible.
5. Not changed: the sync interval semantics, the pool, backfill, the snippet indexer,
   `isConnectionRefusal`, `mailYield.js`.

## What to look for on production after deploy

- `IMAP session for p***@yahoo.com: compression=off (disabled for provider), idle=on …` on every
  (re)connect. `compression=on` would mean the option did not take.
- No more `invalid distance …` or `invalid literal/length code` lines.
- `INBOX sync OK for p***@yahoo.com: +0 new in …ms (session …s old)` after each connect and about
  every 10 min.
- `IMAP IDLE active for p***@yahoo.com (session …s old): push is on`, once per session. If
  `IMAP IDLE not active …` appears instead, its `busy:` list says why.
- `IMAP connection closed for p***@yahoo.com after Ns`. If N is still about 300 with compression
  off, Yahoo enforces a session lifetime and the same-tick reconnect is the mitigation. If closes
  stop, or N grows, the corrupt compressed stream was the trigger.
- `Persistent IMAP connection … died during sync (Connection not available, session ~300s old);
  not a provider refusal, reconnecting and syncing again now`, followed by `Reconnecting…`,
  `Reconnected` and `INBOX sync OK` within about 4 s. There should be no
  `Connection refused … backing off 30s` and no `Folder status cycle failed … cooldown active`
  from this cause.
- `IMAP keepalive: NOOP sent …` appears only if IDLE is not running when the 240 s timer fires.
  That is expected to be rare, because the 60 s ticks keep IDLE cycling.

## Open

- Why Yahoo cuts at 300 s while ticks are sending UID FETCH every minute is not established.
  Candidates are a Yahoo session-lifetime policy for this client or IP, or compression. The first
  close lines after deploy will tell. If it persists, a proactive recycle before 300 s at a quiet
  moment would avoid the ~3 s hit on every fifth tick. That is not done here, to keep the
  upstream diff small.
- The health check's `_idleMissStreak` is not reset by an in-tick reconnect (only by
  `disconnectAccount`), so its streak can straddle sessions. It is minor and left as is.
- The flag scan's `FLAG_SCAN_TIMEOUT_MS` race leaves an abandoned FETCH running for up to
  `commandTimeout`, which postpones IDLE. It is harmless, but visible in the new "IDLE not active"
  line if it happens.
- Other areas: Trash snippet batches refused by Yahoo (`UID FETCH Server error - Please try
  again later`), `fetchMessageBody … no body after retry` for Sent and Personal, and the classic
  shell. INBOX data completeness checks out (303/303, no staleness misses).
