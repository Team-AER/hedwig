// Settings → Accounts → Add account. Pick a provider; Google and Microsoft open their sign-in
// window straight away, Yahoo and iCloud take an app password with the servers filled in, and
// Other finds the provider from the address. See docs/hedwig/PLAN-CLICK-TO-SIGN-IN.md.
//
// Styled with the Settings panel's own variables (var(--bg-tertiary), var(--accent)…) because it
// renders inside that panel. The full IMAP form stays upstream's AccountForm, passed in as
// ManualForm (importing it here would be a cycle through AdminPanel.jsx).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import { hedwigApi } from '../api.js';
import { tv } from '../v2/i18n.js';
import { Icon } from '../icons.jsx';
import {
  PROVIDERS, providerById, providerFlow, providerForDiscovery, looksLikeAddress,
  redirectUriFor, appPasswordAccount, manualFormStart,
} from './providers.js';
import { openSignIn, listenForSignIn } from './signIn.js';

// ─── Provider marks ───────────────────────────────────────────────────────────
function GoogleMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function MicrosoftMark({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function ProviderMark({ id, size = 32 }) {
  const box = {
    width: size, height: size, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  if (id === 'google') return <span style={{ ...box, background: '#fff', border: '1px solid var(--border-subtle)' }}><GoogleMark size={size * 0.55} /></span>;
  if (id === 'microsoft') return <span style={{ ...box, background: '#fff', border: '1px solid var(--border-subtle)' }}><MicrosoftMark size={size * 0.5} /></span>;
  if (id === 'yahoo') {
    return <span style={{ ...box, background: '#6001d2', color: '#fff', fontWeight: 800, fontSize: size * 0.38, letterSpacing: '-0.02em' }}>Y!</span>;
  }
  if (id === 'icloud') {
    return (
      <span style={{ ...box, background: 'linear-gradient(180deg, #3d9bff, #1a6fe8)' }}>
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#fff" d="M7 18.5h10.5a4 4 0 0 0 .55-7.96A5.75 5.75 0 0 0 7.1 9.1 4.75 4.75 0 0 0 7 18.5z" />
        </svg>
      </span>
    );
  }
  return (
    <span style={{ ...box, background: 'var(--bg-secondary, var(--bg-primary))', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
      <Icon name="mail" size={size * 0.5} />
    </span>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────
const input = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', boxSizing: 'border-box',
};

function Button({ primary = false, children, style, ...rest }) {
  return (
    <button type="button" {...rest} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
      border: primary ? 'none' : '1px solid var(--border)',
      background: primary ? 'var(--accent)' : 'var(--bg-tertiary)',
      color: primary ? 'var(--accent-text, #fff)' : 'var(--text-primary)',
      cursor: rest.disabled ? 'default' : 'pointer', opacity: rest.disabled ? 0.6 : 1,
      ...style,
    }}>{children}</button>
  );
}

function TextLink({ children, style, ...rest }) {
  return (
    <button type="button" {...rest} style={{
      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
      color: 'var(--accent)', fontSize: 13, ...style,
    }}>{children}</button>
  );
}

function ExternalLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {children}<Icon name="external" size={12} />
    </a>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}

function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div role="alert" style={{
      padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
      border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
      color: 'var(--red)', fontSize: 13, lineHeight: 1.5, marginBottom: 14,
    }}>{children}</div>
  );
}

function StepHead({ id, title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <ProviderMark id={id} size={40} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

const muted = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 14px' };

function subtitleFor(id) {
  if (id === 'google') return tv('hedwig.accounts.googleSub', 'Gmail and Google Workspace');
  if (id === 'microsoft') return tv('hedwig.accounts.microsoftSub', 'Outlook.com, Hotmail and Microsoft 365');
  if (id === 'yahoo') return tv('hedwig.accounts.yahooSub', 'Yahoo Mail, with an app password');
  if (id === 'icloud') return tv('hedwig.accounts.icloudSub', 'iCloud Mail, with an app password');
  return tv('hedwig.accounts.otherSub', 'Any IMAP server, found from your address');
}

const labelFor = (id) => providerById(id)?.label || tv('hedwig.accounts.otherTitle', 'Other mail account');

// ─── Provider list ────────────────────────────────────────────────────────────
function ProviderList({ flows, onPick }) {
  return (
    <div>
      <p style={muted}>{tv('hedwig.accounts.intro', 'Choose your mail provider. Google and Microsoft accounts connect when you sign in, with nothing to copy.')}</p>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
        {PROVIDERS.map((p, i) => {
          const flow = flows[p.id];
          const hint = flow === 'signin' ? tv('hedwig.accounts.hintSignIn', 'Sign in')
            : flow === 'setup' ? tv('hedwig.accounts.hintSetup', 'Set up') : null;
          return (
            <button key={p.id} type="button" data-provider={p.id} onClick={() => onPick(p.id)} style={{
              display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
              padding: '11px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
              borderTop: i ? '1px solid var(--border-subtle)' : 'none', color: 'var(--text-primary)',
            }}>
              <ProviderMark id={p.id} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{labelFor(p.id)}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>{subtitleFor(p.id)}</span>
              </span>
              {hint && <span style={{ fontSize: 12, color: flow === 'signin' ? 'var(--accent)' : 'var(--text-tertiary)' }}>{hint}</span>}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sign in (Google, Microsoft) ──────────────────────────────────────────────
function SignInStep({ id, loginHint, state, error, onStart, onCancel }) {
  const p = providerById(id);
  const provider = p.label;
  if (state === 'waiting') {
    return (
      <div>
        <StepHead id={id} title={tv('hedwig.accounts.waitingTitle', 'Signing in with {{provider}}', { provider })} sub={loginHint || subtitleFor(id)} />
        <p style={muted}>{tv('hedwig.accounts.waitingBody', 'Finish in the window that opened. The account appears in your list as soon as you are done.')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={onStart}>{tv('hedwig.accounts.openAgain', 'Open the window again')}</Button>
          <Button onClick={onCancel}>{tv('hedwig.accounts.cancel', 'Cancel')}</Button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <StepHead id={id} title={labelFor(id)} sub={loginHint || subtitleFor(id)} />
      {state === 'error' ? (
        <ErrorNote>
          <div style={{ fontWeight: 600 }}>{tv('hedwig.accounts.signInFailed', 'Sign-in did not finish')}</div>
          <div>{error}</div>
        </ErrorNote>
      ) : (
        <p style={muted}>{tv('hedwig.accounts.signInBody', 'Sign in with {{provider}} in a new window. Hedwig never sees your password.', { provider })}</p>
      )}
      <Button primary onClick={onStart}>
        {id === 'google' ? <GoogleMark size={14} /> : <MicrosoftMark size={13} />}
        {state === 'error' ? tv('hedwig.accounts.tryAgain', 'Try again') : tv('hedwig.accounts.continueWith', 'Continue with {{provider}}', { provider })}
      </Button>
    </div>
  );
}

// ─── One-time setup (admin, provider not configured) ──────────────────────────
function SetupStep({ id, onSaved }) {
  const p = providerById(id);
  const provider = p.label;
  const redirectUri = redirectUriFor(p.signIn, window.location.origin);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the field is selectable */ }
  };

  const save = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(tv('hedwig.accounts.setupRequired', 'Paste both the client ID and the client secret.'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const config = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
      // 'common' takes work, school and personal Microsoft accounts; a single tenant can be set
      // later in Settings → Integrations.
      if (id === 'microsoft') config.tenantId = 'common';
      await api.saveIntegration(p.signIn, config);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div>
      <StepHead id={id} title={tv('hedwig.accounts.setupTitle', 'Turn on {{provider}} sign-in', { provider })} sub={tv('hedwig.accounts.setupSub', 'Once for everyone on this Hedwig')} />
      <p style={muted}>
        {id === 'google'
          ? tv('hedwig.accounts.setupGoogle', 'In Google Cloud, create an OAuth client of type Web application. Its consent screen needs the Gmail scope https://mail.google.com/.')
          : tv('hedwig.accounts.setupMicrosoft', 'In Microsoft Entra, register an app for accounts in any organisation and personal Microsoft accounts, with the delegated permissions IMAP.AccessAsUser.All and SMTP.Send.')}
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <ExternalLink href={p.consoleUrl}>{id === 'google' ? tv('hedwig.accounts.openGoogleCloud', 'Open Google Cloud') : tv('hedwig.accounts.openEntra', 'Open Microsoft Entra')}</ExternalLink>
        <ExternalLink href={p.setupDoc}>{tv('hedwig.accounts.setupGuide', 'Step-by-step guide')}</ExternalLink>
      </div>
      <Field label={tv('hedwig.accounts.redirectLabel', 'Redirect URI to register')}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input readOnly value={redirectUri} onFocus={(e) => e.target.select()} style={{ ...input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }} />
          <Button onClick={copy} title={tv('hedwig.accounts.copy', 'Copy')} aria-label={tv('hedwig.accounts.copy', 'Copy')} style={{ padding: '8px 10px' }}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </Button>
        </div>
      </Field>
      <Field label={tv('hedwig.accounts.clientId', 'Client ID')}>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} style={input} />
      </Field>
      <Field label={tv('hedwig.accounts.clientSecret', 'Client secret')}>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" style={input} />
      </Field>
      <ErrorNote>{error}</ErrorNote>
      <Button primary onClick={save} disabled={saving}>
        {saving ? tv('hedwig.accounts.saving', 'Saving…') : tv('hedwig.accounts.saveSetup', 'Save')}
      </Button>
    </div>
  );
}

// ─── Not configured, not an admin ─────────────────────────────────────────────
function UnavailableStep({ id, onAppPassword }) {
  const provider = providerById(id).label;
  return (
    <div>
      <StepHead id={id} title={labelFor(id)} sub={subtitleFor(id)} />
      <p style={muted}>{tv('hedwig.accounts.unavailable', '{{provider}} sign-in is not turned on for this Hedwig yet. Ask your Hedwig admin to turn it on; it takes them a few minutes.', { provider })}</p>
      {id === 'google' && (
        <TextLink onClick={onAppPassword}>{tv('hedwig.accounts.useAppPassword', 'Use a Gmail app password instead')}</TextLink>
      )}
    </div>
  );
}

// ─── Address + app password (Yahoo, iCloud, Gmail fallback) ───────────────────
function AppPasswordStep({ id, initialEmail = '', onAdded, onServerSettings }) {
  const { accounts, setAccounts } = useStore();
  const p = providerById(id);
  const provider = p.label;
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const add = async (e) => {
    e?.preventDefault?.();
    if (!looksLikeAddress(email)) {
      setError(tv('hedwig.accounts.badAddress', 'Enter a full email address, like name@example.com.'));
      return;
    }
    if (!password.trim()) {
      setError(tv('hedwig.accounts.needAppPassword', 'Paste the app password.'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      // App passwords are shown with spaces for reading; the servers want them without.
      const account = await api.addAccount(appPasswordAccount(id, { email, password: password.replace(/\s+/g, ''), accounts }));
      setAccounts([...(accounts || []), account]);
      onAdded(account);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={add}>
      <StepHead id={id} title={tv('hedwig.accounts.appPasswordTitle', 'Add your {{provider}} account', { provider })} sub={subtitleFor(id)} />
      <p style={muted}>{tv('hedwig.accounts.appPasswordBody', '{{provider}} asks other mail apps for an app password; your normal password will not work. Create one, then paste it here.', { provider })}</p>
      <div style={{ marginBottom: 16 }}>
        <ExternalLink href={p.appPasswordUrl}>{tv('hedwig.accounts.createAppPassword', 'Create an app password at {{provider}}', { provider })}</ExternalLink>
      </div>
      <Field label={tv('hedwig.accounts.emailLabel', 'Email address')}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="name@example.com" style={input} />
      </Field>
      <Field label={tv('hedwig.accounts.appPasswordLabel', 'App password')}>
        <div style={{ position: 'relative' }}>
          <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" spellCheck={false} style={{ ...input, paddingRight: 36 }} />
          <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={tv('hedwig.accounts.showPassword', 'Show password')} title={tv('hedwig.accounts.showPassword', 'Show password')} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex', padding: 2,
          }}><Icon name="eye" size={14} /></button>
        </div>
      </Field>
      <ErrorNote>{error}</ErrorNote>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button primary type="submit" disabled={saving}>
          {saving ? tv('hedwig.accounts.adding', 'Adding…') : tv('hedwig.accounts.addAccount', 'Add account')}
        </Button>
        <TextLink onClick={() => onServerSettings(email)}>{tv('hedwig.accounts.serverSettings', 'Server settings')}</TextLink>
      </div>
    </form>
  );
}

// ─── Other: the address first ─────────────────────────────────────────────────
function AddressStep({ onFound, onManual }) {
  const [email, setEmail] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const go = async (e) => {
    e?.preventDefault?.();
    if (!looksLikeAddress(email)) {
      setError(tv('hedwig.accounts.badAddress', 'Enter a full email address, like name@example.com.'));
      return;
    }
    setChecking(true);
    setError('');
    // Without an answer the IMAP form still works, so a failed lookup is just "not found".
    const found = await hedwigApi.get(`/accounts/discover?email=${encodeURIComponent(email.trim())}`).catch(() => null);
    setChecking(false);
    onFound(email.trim(), found);
  };

  return (
    <form onSubmit={go}>
      <StepHead id="other" title={labelFor('other')} sub={subtitleFor('other')} />
      <p style={muted}>{tv('hedwig.accounts.addressBody', 'Enter your address. Hedwig works out who hosts it and how to connect.')}</p>
      <Field label={tv('hedwig.accounts.emailLabel', 'Email address')}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="name@example.com" autoFocus style={input} />
      </Field>
      <ErrorNote>{error}</ErrorNote>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button primary type="submit" disabled={checking}>
          {checking ? tv('hedwig.accounts.checking', 'Checking…') : tv('hedwig.accounts.continue', 'Continue')}
        </Button>
        <TextLink onClick={() => onManual(email)}>{tv('hedwig.accounts.manual', 'Set up manually')}</TextLink>
      </div>
    </form>
  );
}

// ─── The screen ───────────────────────────────────────────────────────────────
export default function AddAccount({ ManualForm, onSaveManual, onAdded, onClose }) {
  const { t } = useTranslation();
  const { user, accounts, setAccounts } = useStore();
  const isAdmin = !!user?.isAdmin;
  const [integrations, setIntegrations] = useState(null);
  // { kind: 'list' } | { kind: 'provider', id, flow, loginHint, email } | { kind: 'manual', initial }
  const [step, setStep] = useState({ kind: 'list' });
  const [signIn, setSignIn] = useState({ state: 'ready', error: '' }); // ready | waiting | error
  const stepRef = useRef(step);
  stepRef.current = step;
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  const loadStatus = () => api.getIntegrationsStatus().then((s) => { setIntegrations(s); return s; }).catch(() => null);
  useEffect(() => { loadStatus(); }, []);

  // The sign-in window reports back (signIn.js). On success the server has already added (or
  // re-pointed) the account: refresh the list and leave.
  useEffect(() => listenForSignIn((result) => {
    if (stepRef.current.kind !== 'provider') return;
    if (result.ok) {
      api.getAccounts().then(setAccounts).catch(() => {});
      onAddedRef.current(null);
    } else {
      setSignIn({ state: 'error', error: result.error || tv('hedwig.accounts.signInFailed', 'Sign-in did not finish') });
    }
  }), [setAccounts]);

  const ctx = { integrations, isAdmin };
  const flows = Object.fromEntries(PROVIDERS.map((p) => [p.id, providerFlow(p.id, ctx)]));

  const startSignIn = (id, loginHint) => {
    openSignIn(providerById(id).signIn, { loginHint });
    setSignIn({ state: 'waiting', error: '' });
  };

  // A click on a tile is the user gesture the sign-in window needs, so a configured provider
  // opens it right here rather than one screen later.
  const pick = (id, { email = '', autoStart = true } = {}) => {
    const flow = providerFlow(id, ctx);
    setStep({ kind: 'provider', id, flow, loginHint: email, email });
    setSignIn({ state: 'ready', error: '' });
    if (flow === 'signin' && autoStart) startSignIn(id, email);
  };

  const manual = (id, email) => setStep({ kind: 'manual', initial: manualFormStart(id, { email, accounts }) });

  const back = () => {
    if (step.kind === 'list') onClose();
    else setStep({ kind: 'list' });
  };

  let body;
  if (step.kind === 'list') {
    body = <ProviderList flows={flows} onPick={(id) => pick(id)} />;
  } else if (step.kind === 'manual') {
    body = <ManualForm initial={step.initial} onSave={onSaveManual} onCancel={() => setStep({ kind: 'list' })} />;
  } else if (step.flow === 'signin') {
    body = (
      <SignInStep id={step.id} loginHint={step.loginHint} state={signIn.state} error={signIn.error}
        onStart={() => startSignIn(step.id, step.loginHint)}
        onCancel={() => setSignIn({ state: 'ready', error: '' })} />
    );
  } else if (step.flow === 'setup') {
    body = (
      <SetupStep id={step.id} onSaved={async () => {
        const s = await loadStatus();
        // Configured now: show the sign-in button (a window opened after the save would be blocked).
        setStep((cur) => ({ ...cur, flow: providerFlow(cur.id, { integrations: s, isAdmin }) }));
      }} />
    );
  } else if (step.flow === 'unavailable') {
    body = <UnavailableStep id={step.id} onAppPassword={() => setStep({ ...step, flow: 'appPassword' })} />;
  } else if (step.flow === 'appPassword') {
    body = <AppPasswordStep id={step.id} initialEmail={step.email} onAdded={onAdded} onServerSettings={(email) => manual(step.id, email)} />;
  } else {
    body = (
      <AddressStep
        onManual={(email) => manual('other', email)}
        onFound={(email, found) => {
          const id = providerForDiscovery(found);
          if (id === 'other') manual('other', email);
          // A fetch has run since the click, so the sign-in waits for its own button.
          else pick(id, { email, autoStart: false });
        }} />
    );
  }

  return (
    <div>
      <button type="button" onClick={back} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'none', border: 'none', color: 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        {step.kind === 'list' ? t('sidebar.backToAccounts') : tv('hedwig.accounts.allProviders', 'All providers')}
      </button>
      {step.kind === 'list' && (
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>{t('admin.accounts.addTitle')}</div>
      )}
      {body}
    </div>
  );
}
