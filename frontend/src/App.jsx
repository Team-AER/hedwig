import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/index.js';
import { api } from './utils/api.js';
import { applyTheme, getInitialTheme } from './themes.js';
import { applyFontSet, effectiveFontSet } from './fonts.js'; // still used for the instant localStorage apply on mount
import { applyLayout } from './layouts.js';
import LoginPage from './components/LoginPage.jsx';
import MailApp from './components/MailApp.jsx';
import LockScreen from './components/LockScreen.jsx';
import { signInResultFromUrl, reportSignInResult } from './hedwig/accounts/signIn.js';
import ConnectPage from './hedwig/connect/ConnectPage.jsx';
import { connectPath, pendingRequest, rememberRequest, requestFromUrl } from './hedwig/connect/pending.js';
import { tv } from './hedwig/v2/i18n.js';

export default function App() {
  const { user, setUser, loadPreferences, isLocked, setLocked } = useStore();
  const [checking, setChecking] = useState(true);
  // Set when this window is a mailbox sign-in window that could not close itself.
  const [signInWindow, setSignInWindow] = useState(null);

  // Register service worker on first mount — independent of auth state.
  // The SW itself does nothing until the user explicitly grants push permission.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) =>
        console.warn('Service worker registration failed:', err)
      );
    }
  }, []);

  useEffect(() => {
    const onExpired = () => { setUser(null); setLocked(false); };
    const onLocked = () => setLocked(true);
    window.addEventListener('mailflow:session_expired', onExpired);
    window.addEventListener('mailflow:locked', onLocked);
    return () => {
      window.removeEventListener('mailflow:session_expired', onExpired);
      window.removeEventListener('mailflow:locked', onLocked);
    };
  }, [setUser, setLocked]);

  useEffect(() => {
    // Apply localStorage immediately so there's no flash while we check auth
    const bootTheme = localStorage.getItem('mailflow_theme') || getInitialTheme();
    applyTheme(bootTheme);
    applyFontSet(effectiveFontSet(bootTheme, localStorage.getItem('mailflow_font') || 'default'));
    const savedListWidth = Number(localStorage.getItem('mailflow_list_width')) || undefined;
    applyLayout(localStorage.getItem('mailflow_layout') || 'comfortable', savedListWidth);

    // Handle OAuth popup callback: the last stop of a mailbox sign-in window (hedwig/accounts/
    // signIn.js). Report to the page that opened it, then close. Google's and Microsoft's pages
    // can cut window.opener, and with it the right to close this window, so say so if it stays.
    const signInResult = signInResultFromUrl(window.location.search, { hasOpener: !!window.opener });
    if (signInResult) {
      reportSignInResult(signInResult);
      window.close();
      setTimeout(() => setSignInWindow(signInResult), 300);
      return;
    }

    api.me()
      .then(async (data) => {
        setUser(data.user);
        // Server is authoritative for the screen lock (#235). Reconcile the overlay:
        // show it if the session is locked; clear a stale client lock otherwise. Skip
        // loading prefs while locked (the API is 423'd until unlock).
        if (data.user?.locked) {
          setLocked(true);
          return;
        }
        if (localStorage.getItem('mailflow_locked') === '1') setLocked(false);
        // Load server preferences after confirming auth — overwrites localStorage so
        // settings survive cache clears and stay consistent across devices.
        await loadPreferences();
      })
      .catch(() => {
        const params = new URLSearchParams(window.location.search);
        const m = params.get('m');
        if (m) sessionStorage.setItem('mailflow_deep_link_id', m);
        const resetToken = params.get('reset_token');
        if (resetToken) sessionStorage.setItem('mailflow_reset_token', resetToken);
        // A connector asking for access (/connect): back to it once signed in.
        rememberRequest(sessionStorage, requestFromUrl(window.location.pathname, window.location.search));
        setUser(null);
        // Clear any stale client lock so a locked session that has since expired
        // doesn't strand the user back on the lock screen after they re-login (#235).
        setLocked(false);
      })
      .finally(() => setChecking(false));
  }, [loadPreferences, setUser, setLocked]);

  if (signInWindow) {
    const ok = signInWindow.type === 'oauth_success';
    return (
      <div style={{
        height: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg-primary)', padding: 24, boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: 360, textAlign: 'center', fontSize: 14, lineHeight: 1.55, color: 'var(--text-primary)' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
            {ok ? tv('hedwig.accounts.windowDone', 'Signed in') : tv('hedwig.accounts.signInFailed', 'Sign-in did not finish')}
          </div>
          {!ok && signInWindow.error && <div style={{ color: 'var(--red)', marginBottom: 6 }}>{signInWindow.error}</div>}
          <div style={{ color: 'var(--text-secondary)' }}>{tv('hedwig.accounts.windowClose', 'You can close this window and go back to Hedwig.')}</div>
        </div>
      </div>
    );
  }

  if (checking) {
    return (
      <div style={{
        height: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg-primary)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            border: '2px solid var(--border)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 0.8s linear infinite'
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  const connecting = user ? pendingRequest(sessionStorage) : null;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/connect" element={user ? (isLocked ? <LockScreen /> : <ConnectPage />) : <Navigate to="/login" replace />} />
      <Route path="/*" element={user
        ? (isLocked ? <LockScreen /> : connecting ? <Navigate to={connectPath(connecting)} replace /> : <MailApp />)
        : <Navigate to="/login" replace />} />
    </Routes>
  );
}
