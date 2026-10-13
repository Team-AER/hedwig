// /connect: the page Claude, ChatGPT or another MCP client sends the person to when they add Hedwig
// as a connector. It says which app is asking, where they go back to, and what the app will be able
// to do; the person allows it (optionally read-only) or cancels, and goes back to the app. The
// OAuth side is backend/src/hedwig/mcp/oauth.js.
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { hedwigApi } from '../api.js';
import { useStore } from '../../store/index.js';
import { OwlMark, Icon } from '../icons.jsx';
import { T, Button, Spinner } from '../views/ui.jsx';
import { tv } from '../v2/i18n.js';
import { forgetRequest, pendingRequest, requestFromUrl } from './pending.js';

function Monogram({ name }) {
  const letter = (String(name || '?').trim()[0] || '?').toUpperCase();
  return (
    <span aria-hidden="true" style={{
      width: 44, height: 44, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: T.raised, border: `1px solid ${T.line}`, color: T.ink, fontSize: 20, fontWeight: 600,
    }}>{letter}</span>
  );
}

function Can({ icon, children }) {
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, lineHeight: '20px', color: T.ink }}>
      <span style={{ color: T.accent, display: 'inline-flex', marginTop: 2, flexShrink: 0 }}><Icon name={icon} size={16} strokeWidth={1.8} /></span>
      <span>{children}</span>
    </li>
  );
}

const page = {
  minHeight: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg-primary)', padding: '24px 16px', boxSizing: 'border-box', fontFamily: T.body,
};
const card = {
  width: '100%', maxWidth: 420, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 16,
  padding: '28px 24px 22px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 18,
};

export default function ConnectPage() {
  const location = useLocation();
  const user = useStore((s) => s.user);
  // Read once: the stored id is forgotten as soon as the page has it.
  const [id] = useState(() => requestFromUrl(location.pathname, location.search) || pendingRequest(sessionStorage));
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(null);
  const [write, setWrite] = useState(true);
  const [phase, setPhase] = useState('ask'); // ask | allowing | declining | leaving
  const [leaving, setLeaving] = useState(null); // { allowed }

  useEffect(() => {
    forgetRequest(sessionStorage);
    if (!id) { setError('expired'); return; }
    let live = true;
    hedwigApi.get(`/mcp/requests/${id}`)
      .then((r) => { if (live) setRequest(r); })
      .catch((e) => { if (live) setError(e.status === 404 ? 'expired' : e.message || 'error'); });
    return () => { live = false; };
  }, [id]);

  const decide = async (allow) => {
    setPhase(allow ? 'allowing' : 'declining');
    try {
      const out = allow
        ? await hedwigApi.post(`/mcp/requests/${id}/approve`, { write: write && request.scopes.includes('mail.write') })
        : await hedwigApi.post(`/mcp/requests/${id}/deny`);
      setLeaving({ allowed: allow });
      setPhase('leaving');
      window.location.assign(out.redirect);
    } catch (e) {
      setPhase('ask');
      setError(e.status === 404 ? 'expired' : e.message || 'error');
    }
  };

  const app = request?.client?.name || '';
  const host = request?.redirectHost || '';
  const asksWrite = Boolean(request?.scopes?.includes('mail.write'));
  const who = user?.email || user?.username || '';

  return (
    <main style={page}>
      <div style={card} role="dialog" aria-labelledby="connect-title">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {request ? <Monogram name={app} /> : <span style={{ width: 44 }} />}
          <span style={{ color: T.muted, display: 'inline-flex' }}><Icon name="chevron-right" size={16} /></span>
          <span style={{
            width: 44, height: 44, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: T.tealTint, color: T.accent,
          }}><OwlMark size={26} /></span>
        </div>

        {error === 'expired' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h1 id="connect-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: T.ink }}>{tv('hedwig.connect.expiredTitle', 'This link has expired')}</h1>
            <p style={{ margin: 0, fontSize: 14, color: T.muted }}>{tv('hedwig.connect.expired', 'The connection request has expired or was already used. Start again from the app you were connecting.')}</p>
            <div><Button onClick={() => window.location.assign('/')}>{tv('hedwig.connect.backToHedwig', 'Back to Hedwig')}</Button></div>
          </div>
        )}

        {error && error !== 'expired' && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: T.red, textAlign: 'center' }}>{error}</p>
        )}

        {!request && !error && <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner size={22} /></div>}

        {request && error !== 'expired' && phase === 'leaving' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', padding: '8px 0' }}>
            <h1 id="connect-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: T.ink }}>
              {leaving?.allowed ? tv('hedwig.connect.connected', 'Connected') : tv('hedwig.connect.notConnected', 'Not connected')}
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: T.muted, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <Spinner size={14} />{tv('hedwig.connect.returning', 'Taking you back to {{host}}…', { host })}
            </p>
          </div>
        )}

        {request && error !== 'expired' && phase !== 'leaving' && (
          <>
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1 id="connect-title" style={{ margin: 0, fontSize: 19, fontWeight: 600, color: T.ink, overflowWrap: 'anywhere' }}>
                {tv('hedwig.connect.title', 'Connect {{app}} to Hedwig', { app })}
              </h1>
              <p style={{ margin: 0, fontSize: 14, color: T.muted, overflowWrap: 'anywhere' }}>
                {tv('hedwig.connect.asking', '{{app}} is asking to use your mail. You will go back to {{host}} afterwards.', { app, host })}
              </p>
            </div>

            <section aria-labelledby="connect-can" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 id="connect-can" style={{ margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', color: T.muted }}>
                {tv('hedwig.connect.canTitle', 'It will be able to')}
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Can icon="search">{tv('hedwig.connect.canSearch', 'Search and read your mail in every account')}</Can>
                <Can icon="inbox">{tv('hedwig.connect.canSorted', 'See how Hedwig sorted it, what needs you, your lists and summaries')}</Can>
                <Can icon="ask">{tv('hedwig.connect.canAsk', 'Ask Hedwig questions about your mail')}</Can>
              </ul>
            </section>

            {asksWrite ? (
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: T.field, border: `1px solid ${T.line}`, cursor: 'pointer' }}>
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--hw-accent, #007AFF)' }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{tv('hedwig.connect.organize', 'Also let it organise your mail')}</span>
                  <span style={{ fontSize: 13, color: T.muted }}>{tv('hedwig.connect.organizeSub', 'Archive, move, star, snooze, re-sort and save reply drafts. It can never send or delete mail.')}</span>
                </span>
              </label>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: T.muted }}>{tv('hedwig.connect.readOnly', 'It asked to read only, so it cannot change anything.')}</p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button onClick={() => decide(false)} busy={phase === 'declining'} disabled={phase !== 'ask'}>{tv('common.cancel', 'Cancel')}</Button>
              <Button variant="primary" onClick={() => decide(true)} busy={phase === 'allowing'} disabled={phase !== 'ask'}>{tv('hedwig.connect.allow', 'Allow')}</Button>
            </div>

            <p style={{ margin: 0, fontSize: 12, color: T.muted, textAlign: 'center', lineHeight: '17px' }}>
              {who ? `${tv('hedwig.connect.signedInAs', 'Signed in as {{who}}', { who })} · ` : ''}
              {tv('hedwig.connect.revokeNote', 'You can disconnect it at any time in Settings → Connectors.')}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
