// schema.org markup in HTML mail (JSON-LD and microdata), as senders embed it for Gmail and
// Outlook: Order, Invoice, ParcelDelivery, Flight/Train/Bus/Lodging/RentalCar/EventReservation.
// Every field's source is the markup property it came from.
import { Parser } from 'htmlparser2';
import { normFields } from '../kinds.js';

const JSONLD_RE = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function typesOf(node) {
  const t = node?.['@type'] ?? node?.type;
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, ''));
}

/** Every typed object in a JSON-LD value (arrays, @graph, nested). */
function flatten(value, out = []) {
  if (Array.isArray(value)) { value.forEach((v) => flatten(v, out)); return out; }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value['@graph'])) flatten(value['@graph'], out);
  if (typesOf(value).length) out.push(value);
  return out;
}

/** JSON-LD blocks in an HTML body. Pure. */
export function jsonLdItems(html) {
  const items = [];
  for (const m of String(html || '').matchAll(JSONLD_RE)) {
    const raw = m[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
    let parsed = null;
    for (const candidate of [raw, decodeEntities(raw)]) {
      try { parsed = JSON.parse(candidate); break; } catch { /* try the next form */ }
    }
    if (parsed) items.push(...flatten(parsed).map((n) => ({ node: n, via: 'JSON-LD' })));
  }
  return items;
}

const VALUE_ATTRS = { meta: 'content', link: 'href', a: 'href', img: 'src', time: 'datetime', data: 'value', meter: 'value' };

/** Microdata (itemscope / itemtype / itemprop) as nested objects with @type. Pure. */
export function microdataItems(html) {
  const roots = [];
  const stack = []; // { tag, scope?, prop?, text, depth }
  let depth = 0;
  const scopes = []; // open scope objects with their element depth
  const parser = new Parser({
    onopentag(name, attrs) {
      depth++;
      const isScope = 'itemscope' in attrs;
      const prop = attrs.itemprop;
      let scope = null;
      if (isScope) {
        scope = { '@type': (attrs.itemtype || '').split(/\s+/).filter(Boolean).map((t) => t.replace(/^https?:\/\/schema\.org\//i, '')) };
        if (scope['@type'].length === 1) scope['@type'] = scope['@type'][0];
      }
      const parent = scopes[scopes.length - 1];
      if (prop && parent && !isScope) {
        const attr = VALUE_ATTRS[name];
        if (attr && attrs[attr] != null) addProp(parent.obj, prop, attrs[attr]);
        else if ('content' in attrs) addProp(parent.obj, prop, attrs.content);
        else stack.push({ depth, prop, text: '', target: parent.obj });
      }
      if (scope) {
        if (prop && parent) addProp(parent.obj, prop, scope);
        else roots.push(scope);
        scopes.push({ obj: scope, depth });
      }
    },
    ontext(text) {
      for (const s of stack) s.text += text;
    },
    onclosetag() {
      const top = stack[stack.length - 1];
      if (top && top.depth === depth) {
        stack.pop();
        addProp(top.target, top.prop, top.text.replace(/\s+/g, ' ').trim());
      }
      if (scopes.length && scopes[scopes.length - 1].depth === depth) scopes.pop();
      depth--;
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.write(String(html || ''));
  parser.end();
  return roots.flatMap((r) => flatten(r)).map((n) => ({ node: n, via: 'microdata' }));
}

function addProp(obj, prop, value) {
  for (const p of String(prop).split(/\s+/).filter(Boolean)) {
    if (obj[p] === undefined) obj[p] = value;
    else if (Array.isArray(obj[p])) obj[p].push(value);
    else obj[p] = [obj[p], value];
  }
}

// ── Mapping to cards ─────────────────────────────────────────────────────────

const first = (v) => (Array.isArray(v) ? v[0] : v);
const nameOf = (v) => {
  const x = first(v);
  if (x == null) return null;
  if (typeof x === 'string') return x;
  return x.name || x.legalName || x.alternateName || null;
};
const str = (v) => { const x = first(v); return x == null || typeof x === 'object' ? (x?.name ?? x?.['@value'] ?? null) : String(x); };
const placeOf = (v) => {
  const x = first(v);
  if (!x) return null;
  if (typeof x === 'string') return x;
  return x.iataCode || x.name || addressOf(x.address) || null;
};
function addressOf(a) {
  const x = first(a);
  if (!x) return null;
  if (typeof x === 'string') return x;
  return [x.streetAddress, x.addressLocality, x.postalCode, x.addressCountry?.name || x.addressCountry].filter((p) => p && typeof p === 'string').join(', ') || null;
}
const priceOf = (node) => {
  const due = first(node.totalPaymentDue) || first(node.minimumPaymentDue) || first(node.priceSpecification);
  if (due && typeof due === 'object') return { value: due.value ?? due.price, currency: due.currency || due.priceCurrency };
  return { value: first(node.price) ?? first(node.totalPrice), currency: first(node.priceCurrency) };
};

const STATUS = {
  orderintransit: 'in_transit', orderdelivered: 'delivered', orderpickupavailable: 'out_for_delivery', orderproblem: 'exception',
  orderreturned: 'exception', orderprocessing: 'ordered', orderpaymentdue: 'ordered', ordercancelled: 'exception',
};
const deliveryStatus = (v) => STATUS[String(str(v) || '').replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()] || null;
const PAYMENT = { paymentcomplete: 'paid', paymentdue: 'due', paymentpastdue: 'overdue', paymentautomaticallyapplied: 'paid' };

/** Record where each field came from: the markup type and property. */
function withSources(kind, fields, paths, { messageId, via, type }) {
  const clean = normFields(kind, fields);
  const sources = {};
  for (const k of Object.keys(clean)) {
    const shown = typeof clean[k] === 'object' ? JSON.stringify(clean[k]).slice(0, 120) : clean[k];
    sources[k] = { messageId, quote: `schema.org ${type}.${paths[k] || k} = ${shown}`, via: `schema.org ${via}` };
  }
  return { fields: clean, sources };
}

function card(kind, fields, paths, ctx, type) {
  const { fields: f, sources } = withSources(kind, fields, paths, { ...ctx, type });
  if (!Object.keys(f).length) return null;
  return { kind, messageId: ctx.messageId, fields: f, sources, confidence: 0.97, layer: 'schema_org' };
}

function fromNode(node, ctx) {
  const types = typesOf(node);
  const out = [];
  const has = (t) => types.includes(t);
  if (has('Order')) {
    const offers = [].concat(node.acceptedOffer || []).map(first).filter(Boolean);
    const p = priceOf(node);
    const items = offers.map((o) => ({ name: nameOf(o.itemOffered) || nameOf(o), quantity: str(o.eligibleQuantity?.value) || 1, price: first(o.price) }));
    out.push(card('receipt', {
      merchant: nameOf(node.seller) || nameOf(node.merchant) || nameOf(node.broker),
      orderNumber: str(node.orderNumber) || str(node.confirmationNumber),
      total: p.value ?? (offers.length ? offers.reduce((s, o) => s + (Number(first(o.price)) || 0), 0) || null : null),
      currency: p.currency || offers.map((o) => first(o.priceCurrency)).find(Boolean),
      date: str(node.orderDate),
      items,
      paymentMethod: str(node.paymentMethod)?.replace(/^https?:\/\/schema\.org\//i, ''),
    }, { merchant: 'seller.name', orderNumber: 'orderNumber', total: 'price', currency: 'priceCurrency', date: 'orderDate', items: 'acceptedOffer', paymentMethod: 'paymentMethod' }, ctx, 'Order'));
    for (const d of [].concat(node.orderDelivery || []).map(first).filter(Boolean)) {
      out.push(...fromNode({ ...d, '@type': 'ParcelDelivery', partOfOrder: d.partOfOrder || { merchant: node.seller || node.merchant, orderNumber: node.orderNumber, orderStatus: node.orderStatus } }, ctx));
    }
  }
  if (has('ParcelDelivery')) {
    const order = first(node.partOfOrder) || {};
    out.push(card('delivery', {
      carrier: nameOf(node.carrier) || nameOf(node.provider),
      trackingNumber: str(node.trackingNumber),
      trackingUrl: str(node.trackingUrl),
      status: deliveryStatus(node.deliveryStatus) || deliveryStatus(order.orderStatus) || (str(node.trackingNumber) ? 'shipped' : null),
      expectedDate: str(node.expectedArrivalUntil) || str(node.expectedArrivalFrom),
      merchant: nameOf(order.merchant) || nameOf(order.seller),
      item: nameOf(node.itemShipped),
    }, { carrier: 'carrier.name', trackingNumber: 'trackingNumber', trackingUrl: 'trackingUrl', status: 'deliveryStatus', expectedDate: 'expectedArrivalUntil', merchant: 'partOfOrder.merchant', item: 'itemShipped.name' }, ctx, 'ParcelDelivery'));
  }
  if (has('Invoice')) {
    const p = priceOf(node);
    out.push(card('invoice', {
      issuer: nameOf(node.provider) || nameOf(node.broker),
      invoiceNumber: str(node.confirmationNumber) || str(node.identifier) || str(node.accountId),
      amount: p.value,
      currency: p.currency,
      issuedDate: str(node.billingPeriod)?.split('/')[0] || null,
      dueDate: str(node.paymentDueDate) || str(node.paymentDue),
      status: PAYMENT[String(str(node.paymentStatus) || '').replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()] || null,
    }, { issuer: 'provider.name', invoiceNumber: 'confirmationNumber', amount: 'totalPaymentDue.value', currency: 'totalPaymentDue.currency', issuedDate: 'billingPeriod', dueDate: 'paymentDueDate', status: 'paymentStatus' }, ctx, 'Invoice'));
  }
  const res = first(node.reservationFor) || {};
  const common = { reference: str(node.reservationNumber), passenger: nameOf(node.underName) };
  const commonPaths = { reference: 'reservationNumber', passenger: 'underName.name' };
  if (has('FlightReservation')) {
    const airline = first(res.airline) || {};
    out.push(card('travel', {
      type: 'flight', ...common,
      provider: nameOf(airline) || nameOf(node.provider),
      flightNumber: [airline.iataCode, str(res.flightNumber)].filter(Boolean).join(' ').replace(/^(\w+) \1/, '$1') || null,
      from: placeOf(res.departureAirport), to: placeOf(res.arrivalAirport),
      departAt: str(res.departureTime), arriveAt: str(res.arrivalTime),
    }, { ...commonPaths, type: '@type', provider: 'reservationFor.airline', flightNumber: 'reservationFor.flightNumber', from: 'reservationFor.departureAirport', to: 'reservationFor.arrivalAirport', departAt: 'reservationFor.departureTime', arriveAt: 'reservationFor.arrivalTime' }, ctx, 'FlightReservation'));
  }
  if (has('TrainReservation') || has('BusReservation')) {
    const train = has('TrainReservation');
    out.push(card('travel', {
      type: train ? 'train' : 'bus', ...common,
      provider: nameOf(res.provider) || nameOf(train ? res.trainCompany : res.busCompany) || nameOf(node.provider),
      flightNumber: str(train ? res.trainNumber : res.busNumber),
      from: placeOf(train ? res.departureStation : res.departureBusStop), to: placeOf(train ? res.arrivalStation : res.arrivalBusStop),
      departAt: str(res.departureTime), arriveAt: str(res.arrivalTime),
    }, { ...commonPaths, type: '@type', provider: 'reservationFor.provider', flightNumber: train ? 'reservationFor.trainNumber' : 'reservationFor.busNumber', from: 'reservationFor.departureStation', to: 'reservationFor.arrivalStation', departAt: 'reservationFor.departureTime', arriveAt: 'reservationFor.arrivalTime' }, ctx, train ? 'TrainReservation' : 'BusReservation'));
  }
  if (has('LodgingReservation')) {
    out.push(card('travel', {
      type: 'hotel', ...common,
      provider: nameOf(res) || nameOf(node.provider),
      checkIn: str(node.checkinTime) || str(node.checkinDate), checkOut: str(node.checkoutTime) || str(node.checkoutDate),
      departAt: str(node.checkinTime), location: addressOf(res.address) || nameOf(res),
    }, { ...commonPaths, type: '@type', provider: 'reservationFor.name', checkIn: 'checkinTime', checkOut: 'checkoutTime', departAt: 'checkinTime', location: 'reservationFor.address' }, ctx, 'LodgingReservation'));
  }
  if (has('RentalCarReservation')) {
    out.push(card('travel', {
      type: 'car', ...common,
      provider: nameOf(res.rentalCompany) || nameOf(node.provider),
      departAt: str(node.pickupTime), checkIn: str(node.pickupTime), checkOut: str(node.dropoffTime),
      location: placeOf(node.pickupLocation),
    }, { ...commonPaths, type: '@type', provider: 'reservationFor.rentalCompany', departAt: 'pickupTime', checkIn: 'pickupTime', checkOut: 'dropoffTime', location: 'pickupLocation' }, ctx, 'RentalCarReservation'));
  }
  if (has('EventReservation')) {
    out.push(card('event', {
      title: nameOf(res),
      start: str(res.startDate), end: str(res.endDate),
      location: placeOf(res.location), organizer: nameOf(res.organizer),
      uid: str(node.reservationNumber) ? `reservation:${str(node.reservationNumber)}` : null,
      status: String(str(node.reservationStatus) || '').replace(/^https?:\/\/schema\.org\//i, '') || null,
    }, { title: 'reservationFor.name', start: 'reservationFor.startDate', end: 'reservationFor.endDate', location: 'reservationFor.location', organizer: 'reservationFor.organizer', uid: 'reservationNumber', status: 'reservationStatus' }, ctx, 'EventReservation'));
  }
  return out.filter(Boolean);
}

/**
 * Cards from schema.org markup in a message's HTML. Pure.
 * @param {{ id: string, body_html?: string }} row
 */
export function detectSchemaOrg(row) {
  const html = row?.body_html;
  if (!html || !/schema\.org|ld\+json/i.test(html)) return [];
  const items = [...jsonLdItems(html), ...microdataItems(html)];
  const out = [];
  const seen = new Set();
  for (const { node, via } of items) {
    for (const c of fromNode(node, { messageId: row.id, via })) {
      const key = `${c.kind}:${JSON.stringify(c.fields)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
