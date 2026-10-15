import { getSupabase } from '@/lib/supabase/client';
import { publicEnv } from '@/config/public-env';
import { toDataError } from './errors';

// Every function wraps its errors with toDataError. The database enforces non-anonymous + aal2 +
// password and totp amr + an admins row on every admin RPC; nothing here is a security boundary.

export async function adminSignIn(email: string, password: string, captchaToken: string): Promise<void> {
  try {
    const { error } = await getSupabase().auth.signInWithPassword({
      email,
      password,
      options: { captchaToken },
    });
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminAal(): Promise<{ current: 'aal1' | 'aal2' | null; next: 'aal1' | 'aal2' | null }> {
  try {
    const { data, error } = await getSupabase().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    const lvl = (v: string | null | undefined): 'aal1' | 'aal2' | null => (v === 'aal1' || v === 'aal2' ? v : null);
    return { current: lvl(data?.currentLevel), next: lvl(data?.nextLevel) };
  } catch (e) {
    throw toDataError(e);
  }
}

/**
 * Addition to the frozen contract (UI convenience only): true when a non-anonymous session exists.
 * A visitor's anonymous session counts as "no session" for the back office.
 */
export async function adminHasUserSession(): Promise<boolean> {
  try {
    const { data, error } = await getSupabase().auth.getSession();
    if (error) throw error;
    const user = data.session?.user;
    return !!user && !user.is_anonymous;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminVerifiedTotp(): Promise<{ id: string; friendlyName: string } | null> {
  try {
    const { data, error } = await getSupabase().auth.mfa.listFactors();
    if (error) throw error;
    const f = (data?.totp ?? []).find((x) => x.factor_type === 'totp' && x.status === 'verified');
    return f ? { id: f.id, friendlyName: f.friendly_name ?? '' } : null;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminEnrollTotp(friendlyName: string): Promise<{ factorId: string; qrCode: string; secret: string }> {
  try {
    const { data, error } = await getSupabase().auth.mfa.enroll({ factorType: 'totp', friendlyName });
    if (error) throw error;
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminVerifyTotp(factorId: string, code: string): Promise<void> {
  try {
    const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminChangePassword(pw: string): Promise<void> {
  try {
    const { error } = await getSupabase().auth.updateUser({ password: pw });
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminSignOut(): Promise<void> {
  try {
    const { error } = await getSupabase().auth.signOut();
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminWhoami(): Promise<boolean> {
  try {
    const { data, error } = await getSupabase().rpc('admin_whoami');
    if (error) throw error;
    return data === true;
  } catch (e) {
    throw toDataError(e);
  }
}

/**
 * Create a powerless auth user (Turnstile + Supabase rate limits). Authorization stays in the database:
 * the account does nothing until public.admins has its row. An already-registered email returns the same
 * result (obfuscated user, no session), so the UI never reveals whether an address exists.
 */
export async function adminSignUp(email: string, password: string, captchaToken: string): Promise<{ needsConfirmation: boolean }> {
  try {
    const { data, error } = await getSupabase().auth.signUp({
      email,
      password,
      options: { captchaToken, emailRedirectTo: `${publicEnv.siteUrl}/admin/?confirmed=1` },
    });
    if (error) throw error;
    return { needsConfirmation: data.session === null };
  } catch (e) {
    throw toDataError(e);
  }
}

/** The id of the signed-in non-anonymous user, else null. Shown so the operator can add the admins row. */
export async function adminUserId(): Promise<string | null> {
  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error) throw error;
    const u = data.user;
    return u && !u.is_anonymous ? u.id : null;
  } catch (e) {
    throw toDataError(e);
  }
}
