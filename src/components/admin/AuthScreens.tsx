'use client';

import { useState } from 'react';
import Turnstile from '@/components/ui/Turnstile';
import {
  adminChangePassword,
  adminEnrollTotp,
  adminSignIn,
  adminVerifyTotp,
  toDataError,
  userMessage,
} from '@/lib/data';

const errText = (e: unknown) => userMessage(toDataError(e));

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="login-card">
        <h2 className="disp">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function LoginScreen({ onDone, notice }: { onDone(): void; notice?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await adminSignIn(email.trim(), password, token);
      onDone();
    } catch (e) {
      const d = toDataError(e);
      setErr(d.code === 'auth_failed' ? 'That email and password did not work.' : userMessage(d));
      setToken('');
      setReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Back office">
      {notice && <p className="ok" role="status">{notice}</p>}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="lbl">
          Email
          <input className="field" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="lbl">
          Password
          <input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <Turnstile onToken={setToken} onExpire={() => setToken('')} resetKey={reset} />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn primary" type="submit" disabled={busy || !token || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="fine">There&apos;s no public sign-up.</p>
      </form>
    </Card>
  );
}

function TotpInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <input
      className="field"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      aria-label="6-digit code"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

export function MfaScreen({ factorId, onDone, onSignOut }: { factorId: string; onDone(): void; onSignOut(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setErr('');
    try {
      await adminVerifyTotp(factorId, code);
      onDone();
    } catch (e) {
      setErr(toDataError(e).code === 'auth_failed' ? 'That code did not work. Try the next one.' : errText(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Enter your code">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="fine">Open your authenticator app and enter the 6-digit code.</p>
        <TotpInput value={code} onChange={setCode} />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>Verify</button>
        <button className="btn ghost" type="button" onClick={onSignOut}>Sign out</button>
      </form>
    </Card>
  );
}

export function PasswordForm({ onChanged, title = 'Change password' }: { onChanged?(): void; title?: string } = {}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (pw.length < 12) return setMsg({ ok: false, text: 'Use at least 12 characters.' });
    if (pw !== pw2) return setMsg({ ok: false, text: 'The two passwords do not match.' });
    setBusy(true);
    setMsg(null);
    try {
      await adminChangePassword(pw);
      setPw('');
      setPw2('');
      setMsg({ ok: true, text: 'Password changed.' });
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <strong>{title}</strong>
      <label className="lbl">
        New password (12+ characters)
        <input className="field" type="password" autoComplete="new-password" minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label className="lbl">
        Repeat it
        <input className="field" type="password" autoComplete="new-password" minLength={12} value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {msg && <p className={msg.ok ? 'ok' : 'err'} role="status">{msg.text}</p>}
      <button className="btn ghost" type="submit" disabled={busy || !pw}>Change password</button>
    </form>
  );
}

export function SetupScreen({ onDone, onSignOut }: { onDone(): void; onSignOut(): void }) {
  const [name, setName] = useState('Authenticator');
  const [enrolled, setEnrolled] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function enroll(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setErr('');
    try {
      setEnrolled(await adminEnrollTotp(name.trim()));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy || !enrolled || code.length !== 6) return;
    setBusy(true);
    setErr('');
    try {
      await adminVerifyTotp(enrolled.factorId, code);
      onDone();
    } catch (e) {
      setErr(toDataError(e).code === 'auth_failed' ? 'That code did not work. Try the next one.' : errText(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  // Only render an enroll QR if it is an inline image data URL.
  const qrOk = enrolled && /^data:image\/(svg\+xml|png)/.test(enrolled.qrCode);

  return (
    <Card title="Set up sign-in">
      <p className="fine">The back office needs an authenticator app (a second step) before it shows anything.</p>
      <PasswordForm />
      <hr />
      {!enrolled ? (
        <form onSubmit={enroll} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong>Set up authenticator</strong>
          <label className="lbl">
            Name for this authenticator
            <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn primary" type="submit" disabled={busy || !name.trim()}>Show QR code</button>
        </form>
      ) : (
        <form onSubmit={verify} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong>Scan, then enter the code</strong>
          {qrOk && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="qr" src={enrolled.qrCode} alt="Authenticator QR code" />
          )}
          <p className="fine">Or type this key into your app: <code>{enrolled.secret}</code></p>
          <TotpInput value={code} onChange={setCode} />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>Verify and continue</button>
        </form>
      )}
      <button className="btn ghost" type="button" onClick={onSignOut}>Sign out</button>
    </Card>
  );
}

/** After a password-reset email: set the new password, then sign in normally (password + authenticator). */
export function RecoveryScreen({ onDone, onSignOut }: { onDone(): void; onSignOut(): void }) {
  return (
    <Card title="Reset your password">
      <p className="fine">
        Choose a new password. Then sign in with it and your authenticator code to open the back office.
      </p>
      <PasswordForm title="New password" onChanged={onDone} />
      <button className="btn ghost" type="button" onClick={onSignOut}>Cancel and sign out</button>
    </Card>
  );
}

export function NotAdminScreen({ onSignOut }: { onSignOut(): void }) {
  return (
    <Card title="Back office">
      <p>Your account isn&apos;t an admin yet.</p>
      <PasswordForm />
      <button className="btn ghost" type="button" onClick={onSignOut}>Sign out</button>
    </Card>
  );
}
