export type AdminScreen = 'login' | 'mfa' | 'setup' | 'not_admin' | 'recovery' | 'console' | 'signup';

export interface AuthState {
  /** A non-anonymous session exists. A visitor's anonymous session counts as false. */
  hasUser: boolean;
  current: 'aal1' | 'aal2' | null;
  next: 'aal1' | 'aal2' | null;
  /** adminWhoami result; only meaningful (and only asked) at aal2. */
  isAdmin: boolean | null;
  /**
   * Arrived from a password-reset email (/admin/?recovery=1). That session's amr is an email code, so is_admin is false
   * even for a real admin: show the set-a-new-password screen instead of "not an admin".
   */
  recovery?: boolean;
}

/**
 * Which back-office screen to show. UI convenience only: the database enforces
 * non-anonymous + aal2 + an admins row on every admin RPC.
 * Fail closed: anything unexpected lands on a screen that shows nothing privileged.
 */
export function decideScreen(s: AuthState): AdminScreen {
  if (!s.hasUser || s.current === null) return 'login';
  if (s.current === 'aal2') return s.isAdmin === true ? 'console' : s.recovery ? 'recovery' : 'not_admin';
  // aal1
  if (s.next === 'aal2') return 'mfa';
  return 'setup';
}

/** The `admin.ts` functions the gate needs, injectable for tests. */
export interface GateDeps {
  hasUserSession(): Promise<boolean>;
  aal(): Promise<{ current: 'aal1' | 'aal2' | null; next: 'aal1' | 'aal2' | null }>;
  verifiedTotp(): Promise<{ id: string; friendlyName: string } | null>;
  whoami(): Promise<boolean>;
  userId(): Promise<string | null>;
  signOut(): Promise<void>;
}

export interface Resolved {
  screen: AdminScreen;
  factorId: string;
  userId: string | null;
  notice?: string;
}

export const CONFIRMED_NOTICE = 'Email confirmed. Sign in with your password and set up your authenticator.';

/**
 * Decide the back-office screen. A `?confirmed=1` arrival (the email-confirmation link) signs out first: that
 * session's amr is not `password`, so it must never reach whoami, exactly like recovery.
 */
export async function resolveScreen(deps: GateDeps, search: string): Promise<Resolved> {
  const params = new URLSearchParams(search);
  if (params.get('confirmed') === '1') {
    await deps.signOut();
    return { screen: 'login', factorId: '', userId: null, notice: CONFIRMED_NOTICE };
  }
  const hasUser = await deps.hasUserSession();
  if (!hasUser) return { screen: 'login', factorId: '', userId: null };
  const recovery = params.get('recovery') === '1';
  const { current, next } = await deps.aal();
  let isAdmin: boolean | null = null;
  let factorId = '';
  if (current === 'aal2') {
    isAdmin = await deps.whoami().catch(() => false);
  } else if (current === 'aal1') {
    const f = await deps.verifiedTotp();
    factorId = f?.id ?? '';
    // A verified factor means a challenge is needed even if `next` was not reported.
    if (f) return { screen: 'mfa', factorId, userId: null };
  }
  const screen = decideScreen({ hasUser, current, next, isAdmin, recovery });
  const userId = screen === 'not_admin' ? await deps.userId().catch(() => null) : null;
  return { screen, factorId, userId };
}
