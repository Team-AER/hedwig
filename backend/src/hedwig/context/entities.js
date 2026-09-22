// Pipeline step `entities`: people and organisations from From/To/Cc.
//
// Addresses map to entities through hedwig_entity_addresses, so several addresses can belong to
// one entity (all of the user's own addresses share one 'self' entity). Counts are bumped only for
// hedwig_message_entities rows this run actually inserted, which makes re-running a batch a no-op.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { addressesOf, domainOf } from '../text.js';
import { cleanName, isAutomatedAddress, isBulkMessage, orgNameFromDomain, registrableDomain } from './util.js';

/**
 * Pure: who takes part in each message, and one record per distinct address.
 * @returns {{ addresses: Map<string, object>, links: {messageId, email, role}[], messages: Map<string, object> }}
 */
export function planEntities(rows, { freemail = [] } = {}) {
  const free = new Set((freemail || []).map((d) => String(d).toLowerCase()));
  const addresses = new Map();
  const links = [];
  const messages = new Map();
  for (const r of rows) {
    const mine = r.user_addresses || new Set();
    messages.set(r.id, { date: r.date ? new Date(r.date) : null, outgoing: Boolean(r.is_outgoing), bulk: isBulkMessage(r) });
    const parts = [];
    const from = String(r.from_email || '').trim().toLowerCase();
    if (from.includes('@')) parts.push({ email: from, name: r.from_name, role: 'from' });
    for (const a of addressesOf(r.to_addresses)) parts.push({ ...a, role: 'to' });
    for (const a of addressesOf(r.cc_addresses)) parts.push({ ...a, role: 'cc' });
    const seen = new Set();
    for (const p of parts) {
      const key = `${p.email}|${p.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ messageId: r.id, email: p.email, role: p.role });
      // Mail in Sent from an alias the account does not list is still the user's own.
      const self = mine.has(p.email) || (p.role === 'from' && Boolean(r.is_outgoing));
      let rec = addresses.get(p.email);
      if (!rec) {
        const domain = domainOf(p.email);
        const reg = domain ? registrableDomain(domain) : null;
        rec = {
          email: p.email,
          name: null,
          nameFromHeader: false,
          self,
          domain,
          orgDomain: reg && !free.has(domain) && !free.has(reg) ? reg : null,
          automated: isAutomatedAddress(p.email),
        };
        addresses.set(p.email, rec);
      }
      rec.self = rec.self || self;
      const name = cleanName(p.name, p.email);
      // Prefer the name people give themselves (From) over what the user's client typed (To).
      if (name && (!rec.name || (p.role === 'from' && !rec.nameFromHeader))) {
        rec.name = name;
        rec.nameFromHeader = p.role === 'from';
      }
    }
  }
  for (const rec of addresses.values()) if (rec.self) rec.orgDomain = null;
  return { addresses, links, messages };
}

/**
 * Pure: count increments per entity from the links this run inserted.
 * `inserted` rows are { message_id, entity_id, role }.
 */
export function entityDeltas(inserted, messages) {
  const acc = new Map();
  for (const l of inserted) {
    const m = messages.get(l.message_id);
    if (!m) continue;
    let d = acc.get(l.entity_id);
    if (!d) {
      d = { id: l.entity_id, msgs: new Set(), recv: new Set(), sent: new Set(), bulk: new Set(), first: null, last: null };
      acc.set(l.entity_id, d);
    }
    d.msgs.add(l.message_id);
    if (l.role === 'from' && !m.outgoing) {
      d.recv.add(l.message_id);
      if (m.bulk) d.bulk.add(l.message_id);
    }
    if (l.role !== 'from' && m.outgoing) d.sent.add(l.message_id);
    if (m.date && !Number.isNaN(m.date.getTime())) {
      if (!d.first || m.date < d.first) d.first = m.date;
      if (!d.last || m.date > d.last) d.last = m.date;
    }
  }
  return [...acc.values()].map((d) => ({
    id: d.id, n: d.msgs.size, recv: d.recv.size, sent: d.sent.size, bulk: d.bulk.size, first: d.first, last: d.last,
  }));
}

const ENTITY_KEY = '(user_id, kind, (lower(COALESCE(primary_email, domain))))';

async function selfEntityId(userId, rec) {
  const { rows } = await query(
    "SELECT id FROM hedwig_entities WHERE user_id = $1 AND kind = 'self' ORDER BY created_at LIMIT 1",
    [userId],
  );
  if (rows.length) return rows[0].id;
  const ins = await query(
    `INSERT INTO hedwig_entities (user_id, kind, display_name, primary_email, domain)
     VALUES ($1, 'self', $2, $3, $4)
     ON CONFLICT ${ENTITY_KEY} DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId, rec.name, rec.email, rec.domain],
  );
  return ins.rows[0].id;
}

async function lookupAddresses(userId, emails) {
  const { rows } = await query(
    `SELECT ea.email, ea.entity_id, e.kind FROM hedwig_entity_addresses ea JOIN hedwig_entities e ON e.id = ea.entity_id
      WHERE ea.user_id = $1 AND ea.email = ANY($2::text[])`,
    [userId, emails],
  );
  return new Map(rows.map((r) => [r.email, { id: r.entity_id, kind: r.kind }]));
}

/** Find or create the entity for every address. Returns Map email → { id, kind }. */
async function resolveEntities(userId, addresses) {
  const emails = [...addresses.keys()];
  let map = await lookupAddresses(userId, emails);

  const selfRecs = [...addresses.values()].filter((a) => a.self && map.get(a.email)?.kind !== 'self');
  if (selfRecs.length) {
    const selfId = await selfEntityId(userId, selfRecs[0]);
    await query(
      `INSERT INTO hedwig_entity_addresses (user_id, email, entity_id, name)
       SELECT $1, x.email, $2, x.name FROM UNNEST($3::text[], $4::text[]) AS x(email, name)
       ON CONFLICT (user_id, email) DO UPDATE SET entity_id = EXCLUDED.entity_id`,
      [userId, selfId, selfRecs.map((a) => a.email), selfRecs.map((a) => a.name)],
    );
  }

  const missing = [...addresses.values()].filter((a) => !a.self && !map.has(a.email));
  if (missing.length) {
    const created = await query(
      `INSERT INTO hedwig_entities (user_id, kind, display_name, primary_email, domain, meta)
       SELECT $1, 'person', x.name, x.email, x.domain, jsonb_build_object('name_from', x.nf)
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::boolean[]) AS x(email, name, domain, nf)
       ON CONFLICT ${ENTITY_KEY} DO UPDATE SET updated_at = NOW()
       RETURNING id, primary_email`,
      [userId, missing.map((a) => a.email), missing.map((a) => a.name), missing.map((a) => a.domain), missing.map((a) => a.nameFromHeader)],
    );
    const idByEmail = new Map(created.rows.map((r) => [String(r.primary_email).toLowerCase(), r.id]));
    const withId = missing.filter((a) => idByEmail.has(a.email));
    await query(
      `INSERT INTO hedwig_entity_addresses (user_id, email, entity_id, name)
       SELECT $1, x.email, x.entity_id, x.name FROM UNNEST($2::text[], $3::uuid[], $4::text[]) AS x(email, entity_id, name)
       ON CONFLICT (user_id, email) DO NOTHING`,
      [userId, withId.map((a) => a.email), withId.map((a) => idByEmail.get(a.email)), withId.map((a) => a.name)],
    );
  }
  if (selfRecs.length || missing.length) map = await lookupAddresses(userId, emails);

  // Names: fill blanks, and let a From-header name replace one the user's client made up.
  const named = [...addresses.values()].filter((a) => a.name && map.has(a.email));
  if (named.length) {
    await query(
      `UPDATE hedwig_entities e
          SET display_name = x.name, meta = e.meta || jsonb_build_object('name_from', x.nf), updated_at = NOW()
         FROM UNNEST($2::uuid[], $3::text[], $4::boolean[]) AS x(id, name, nf)
        WHERE e.id = x.id AND e.user_id = $1 AND e.kind <> 'org'
          AND (e.display_name IS NULL OR e.display_name = '' OR lower(e.display_name) = lower(COALESCE(e.primary_email, ''))
               OR (x.nf AND NOT COALESCE((e.meta->>'name_from')::boolean, false)))`,
      [userId, named.map((a) => map.get(a.email).id), named.map((a) => a.name), named.map((a) => a.nameFromHeader)],
    );
    await query(
      `UPDATE hedwig_entity_addresses ea SET name = x.name
         FROM UNNEST($2::text[], $3::text[], $4::boolean[]) AS x(email, name, nf)
        WHERE ea.user_id = $1 AND ea.email = x.email AND (ea.name IS NULL OR x.nf)`,
      [userId, named.map((a) => a.email), named.map((a) => a.name), named.map((a) => a.nameFromHeader)],
    );
  }
  return map;
}

/** Upsert org entities for the given registrable domains and link people to them. Map domain → org id. */
async function resolveOrgs(userId, addresses, entityMap) {
  const people = [...addresses.values()].filter((a) => a.orgDomain && entityMap.get(a.email)?.kind === 'person');
  const domains = [...new Set(people.map((a) => a.orgDomain))];
  if (!domains.length) return new Map();
  const { rows } = await query(
    `INSERT INTO hedwig_entities (user_id, kind, display_name, domain)
     SELECT $1, 'org', x.name, x.domain FROM UNNEST($2::text[], $3::text[]) AS x(domain, name)
     ON CONFLICT ${ENTITY_KEY} DO UPDATE SET updated_at = NOW()
     RETURNING id, domain`,
    [userId, domains, domains.map((d) => orgNameFromDomain(d))],
  );
  const orgByDomain = new Map(rows.map((r) => [String(r.domain).toLowerCase(), r.id]));
  const linkable = people.filter((a) => orgByDomain.has(a.orgDomain));
  if (linkable.length) {
    await query(
      `UPDATE hedwig_entities e SET org_id = x.org_id, updated_at = NOW()
         FROM UNNEST($2::uuid[], $3::uuid[]) AS x(id, org_id)
        WHERE e.id = x.id AND e.user_id = $1 AND e.kind = 'person' AND e.org_id IS NULL`,
      [userId, linkable.map((a) => entityMap.get(a.email).id), linkable.map((a) => orgByDomain.get(a.orgDomain))],
    );
  }
  return orgByDomain;
}

async function processUser(userId, rows, cfg) {
  const plan = planEntities(rows, { freemail: cfg['context.freemailDomains'] });
  if (!plan.addresses.size) return;
  const entityMap = await resolveEntities(userId, plan.addresses);
  const orgByDomain = await resolveOrgs(userId, plan.addresses, entityMap);

  const linkKeys = new Set();
  const links = [];
  const automated = new Set();
  const add = (messageId, entityId, role) => {
    const k = `${messageId}|${entityId}|${role}`;
    if (linkKeys.has(k)) return;
    linkKeys.add(k);
    links.push([messageId, entityId, role]);
  };
  for (const l of plan.links) {
    const ent = entityMap.get(l.email);
    if (!ent) continue;
    add(l.messageId, ent.id, l.role);
    const rec = plan.addresses.get(l.email);
    if (rec.automated) automated.add(ent.id);
    // Orgs are linked like their people, so an org card lists the org's mail.
    const orgId = rec.orgDomain && ent.kind === 'person' ? orgByDomain.get(rec.orgDomain) : null;
    if (orgId) add(l.messageId, orgId, l.role);
  }
  if (!links.length) return;
  const { rows: inserted } = await query(
    `INSERT INTO hedwig_message_entities (message_id, entity_id, role)
     SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[])
     ON CONFLICT DO NOTHING
     RETURNING message_id, entity_id, role`,
    [links.map((l) => l[0]), links.map((l) => l[1]), links.map((l) => l[2])],
  );
  const deltas = entityDeltas(inserted, plan.messages);
  if (!deltas.length) return;
  await query(
    `UPDATE hedwig_entities e SET
        message_count = e.message_count + d.n,
        received_count = e.received_count + d.recv,
        sent_count = e.sent_count + d.sent,
        first_seen = LEAST(e.first_seen, d.first),
        last_seen = GREATEST(e.last_seen, d.last),
        meta = e.meta || jsonb_build_object('bulk_received', COALESCE((e.meta->>'bulk_received')::int, 0) + d.bulk),
        is_bulk = e.kind <> 'self' AND (d.automated
          OR (COALESCE((e.meta->>'bulk_received')::int, 0) + d.bulk) * 2 > (e.received_count + d.recv)),
        updated_at = NOW()
       FROM UNNEST($2::uuid[], $3::int[], $4::int[], $5::int[], $6::int[], $7::timestamptz[], $8::timestamptz[], $9::boolean[])
         AS d(id, n, recv, sent, bulk, first, last, automated)
      WHERE e.id = d.id AND e.user_id = $1`,
    [userId, deltas.map((d) => d.id), deltas.map((d) => d.n), deltas.map((d) => d.recv), deltas.map((d) => d.sent),
      deltas.map((d) => d.bulk), deltas.map((d) => d.first), deltas.map((d) => d.last), deltas.map((d) => automated.has(d.id))],
  );
}

export async function contextEnabled(userId) {
  const cfg = await getConfig(userId);
  return cfg.enabled && cfg['features.context'] ? cfg : null;
}

export function groupByUser(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r.user_id) continue;
    if (!out.has(r.user_id)) out.set(r.user_id, []);
    out.get(r.user_id).push(r);
  }
  return out;
}

export async function runEntitiesStep(rows) {
  for (const [userId, userRows] of groupByUser(rows)) {
    const cfg = await contextEnabled(userId);
    if (!cfg) continue;
    await processUser(userId, userRows, cfg);
    await query('UPDATE hedwig_msg SET entities_at = NOW() WHERE message_id = ANY($1::uuid[])', [userRows.map((r) => r.id)]);
  }
}
