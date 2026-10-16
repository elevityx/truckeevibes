'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminAal,
  adminHasUserSession,
  adminUserId,
  adminSignOut,
  adminVerifiedTotp,
  adminWhoami,
  toDataError,
  userMessage,
} from '@/lib/data';
import { supabaseConfigured } from '@/config/public-env';
import { resolveScreen, type AdminScreen } from './gate';
import { LoginScreen, MfaScreen, NotAdminScreen, RecoveryScreen, SetupScreen, SignUpScreen } from './AuthScreens';
import Console from './Console';
import './admin-legacy.css';
import './admin.css';

/** The screen is decided on mount and after every auth action. UI convenience only: the database enforces access. */
export default function AdminApp() {
  const [screen, setScreen] = useState<AdminScreen | 'loading' | 'error'>('loading');
  const [factorId, setFactorId] = useState('');
  const [error, setError] = useState('');
  /** Notice on the login screen (after a password reset). */
  const [notice, setNotice] = useState('');
  const [userId, setUserId] = useState<string | null>(null);

  const decide = useCallback(async () => {
    if (!supabaseConfigured()) {
      setError('This site is not connected to a database.');
      return setScreen('error');
    }
    try {
      const r = await resolveScreen(
        {
          hasUserSession: adminHasUserSession,
          aal: adminAal,
          verifiedTotp: adminVerifiedTotp,
          whoami: adminWhoami,
          userId: adminUserId,
          signOut: adminSignOut,
        },
        window.location.search,
      );
      setFactorId(r.factorId);
      setUserId(r.userId);
      if (r.notice) setNotice(r.notice);
      if (new URLSearchParams(window.location.search).get('confirmed') === '1') window.history.replaceState(null, '', '/admin/');
      setScreen(r.screen);
    } catch (e) {
      setError(userMessage(toDataError(e)));
      setScreen('error');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void decide(), 0);
    return () => clearTimeout(t);
  }, [decide]);

  // Recovery done: drop the email-code session and the ?recovery flag, then a normal password + authenticator sign-in.
  const recovered = useCallback(async () => {
    try {
      await adminSignOut();
    } catch {
      /* fall through */
    }
    window.history.replaceState(null, '', '/admin/');
    setNotice('Password changed. Sign in with your new password and your authenticator code.');
    await decide();
  }, [decide]);

  const signOut = useCallback(async () => {
    try {
      await adminSignOut();
    } catch {
      /* fall through to re-deciding */
    }
    await decide();
  }, [decide]);

  switch (screen) {
    case 'loading':
      return <div className="adm"><div className="login"><p className="fine">Loading…</p></div></div>;
    case 'error':
      return (
        <div className="adm">
          <div className="login">
            <div className="login-card">
              <p className="err" role="alert">{error}</p>
              <button className="btn ghost" type="button" onClick={() => { setScreen('loading'); void decide(); }}>Try again</button>
            </div>
          </div>
        </div>
      );
    case 'login':
      return <div className="adm"><LoginScreen onDone={decide} notice={notice} onSignUp={() => setScreen('signup')} /></div>;
    case 'signup':
      return <div className="adm"><SignUpScreen onBack={() => setScreen('login')} /></div>;
    case 'mfa':
      return <div className="adm"><MfaScreen factorId={factorId} onDone={decide} onSignOut={signOut} /></div>;
    case 'setup':
      return <div className="adm"><SetupScreen onDone={decide} onSignOut={signOut} /></div>;
    case 'recovery':
      return <div className="adm"><RecoveryScreen onDone={() => void recovered()} onSignOut={signOut} /></div>;
    case 'not_admin':
      return <div className="adm"><NotAdminScreen userId={userId} onSignOut={signOut} /></div>;
    case 'console':
      return <Console onForbidden={decide} onSignOut={signOut} />;
  }
}
