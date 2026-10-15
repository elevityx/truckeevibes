'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminAal,
  adminHasUserSession,
  adminSignOut,
  adminVerifiedTotp,
  adminWhoami,
  toDataError,
  userMessage,
} from '@/lib/data';
import { supabaseConfigured } from '@/config/public-env';
import { decideScreen, type AdminScreen } from './gate';
import { LoginScreen, MfaScreen, NotAdminScreen, RecoveryScreen, SetupScreen } from './AuthScreens';
import Console from './Console';
import './admin.css';

/** The screen is decided on mount and after every auth action. UI convenience only: the database enforces access. */
export default function AdminApp() {
  const [screen, setScreen] = useState<AdminScreen | 'loading' | 'error'>('loading');
  const [factorId, setFactorId] = useState('');
  const [error, setError] = useState('');
  /** Notice on the login screen (after a password reset). */
  const [notice, setNotice] = useState('');

  const decide = useCallback(async () => {
    if (!supabaseConfigured()) {
      setError('This site is not connected to a database.');
      return setScreen('error');
    }
    try {
      const hasUser = await adminHasUserSession();
      if (!hasUser) return setScreen('login');
      const recovery = new URLSearchParams(window.location.search).get('recovery') === '1';
      const { current, next } = await adminAal();
      let isAdmin: boolean | null = null;
      if (current === 'aal2') {
        isAdmin = await adminWhoami().catch(() => false);
      } else if (current === 'aal1') {
        const f = await adminVerifiedTotp();
        setFactorId(f?.id ?? '');
        // A verified factor means a challenge is needed even if `next` was not reported.
        if (f) return setScreen('mfa');
      }
      setScreen(decideScreen({ hasUser, current, next, isAdmin, recovery }));
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
      return <div className="adm"><LoginScreen onDone={decide} notice={notice} /></div>;
    case 'mfa':
      return <div className="adm"><MfaScreen factorId={factorId} onDone={decide} onSignOut={signOut} /></div>;
    case 'setup':
      return <div className="adm"><SetupScreen onDone={decide} onSignOut={signOut} /></div>;
    case 'recovery':
      return <div className="adm"><RecoveryScreen onDone={() => void recovered()} onSignOut={signOut} /></div>;
    case 'not_admin':
      return <div className="adm"><NotAdminScreen onSignOut={signOut} /></div>;
    case 'console':
      return <Console onForbidden={decide} onSignOut={signOut} />;
  }
}
