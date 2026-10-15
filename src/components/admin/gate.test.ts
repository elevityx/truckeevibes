import { describe, expect, it, vi } from 'vitest';
import * as gate from './gate';
import { decideScreen } from './gate';

const base = { hasUser: true, current: 'aal1', next: 'aal1', isAdmin: null } as const;

describe('decideScreen', () => {
  it('no session -> login', () => {
    expect(decideScreen({ hasUser: false, current: null, next: null, isAdmin: null })).toBe('login');
  });
  it('anonymous session counts as no session, even at aal2 with isAdmin true', () => {
    expect(decideScreen({ hasUser: false, current: 'aal1', next: 'aal1', isAdmin: null })).toBe('login');
    expect(decideScreen({ hasUser: false, current: 'aal2', next: 'aal2', isAdmin: true })).toBe('login');
  });
  it('aal1 with an enrolled factor -> mfa challenge', () => {
    expect(decideScreen({ ...base, next: 'aal2' })).toBe('mfa');
  });
  it('aal1 without a factor -> setup', () => {
    expect(decideScreen(base)).toBe('setup');
    expect(decideScreen({ ...base, next: null })).toBe('setup');
  });
  it('aal1 never reaches the console, even if isAdmin were true', () => {
    expect(decideScreen({ ...base, next: 'aal2', isAdmin: true })).toBe('mfa');
    expect(decideScreen({ ...base, isAdmin: true })).toBe('setup');
  });
  it('aal2 without an admin row -> not_admin', () => {
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: false })).toBe('not_admin');
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: null })).toBe('not_admin');
  });
  it('recovery link: aal2 without admin rights (email-code amr) -> recovery screen, never the console', () => {
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: false, recovery: true })).toBe('recovery');
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: null, recovery: true })).toBe('recovery');
    // the authenticator challenge still comes first, and no session still means login
    expect(decideScreen({ ...base, next: 'aal2', recovery: true })).toBe('mfa');
    expect(decideScreen({ hasUser: false, current: null, next: null, isAdmin: null, recovery: true })).toBe('login');
    // a real admin session (password + totp) still opens the console
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: true, recovery: true })).toBe('console');
  });
  it('aal2 admin -> console', () => {
    expect(decideScreen({ hasUser: true, current: 'aal2', next: 'aal2', isAdmin: true })).toBe('console');
  });
});

// ---- AC-M0-17 (A4-3): resolveScreen over a fake auth backend ----
type Level = 'aal1' | 'aal2' | null;
function fakeBackend() {
  const st = {
    session: null as null | { userId: string; amr: string[] },
    factor: false,
    aal2: false,
    admin: false,
    userId: 'user-1234',
  };
  const calls: string[] = [];
  const deps = {
    hasUserSession: vi.fn(async () => (calls.push('hasUserSession'), st.session !== null)),
    aal: vi.fn(async () => {
      calls.push('aal');
      if (!st.session) return { current: null as Level, next: null as Level };
      return { current: (st.aal2 ? 'aal2' : 'aal1') as Level, next: (st.factor ? 'aal2' : 'aal1') as Level };
    }),
    verifiedTotp: vi.fn(async () => (calls.push('verifiedTotp'), st.factor ? { id: 'factor-1', friendlyName: 'x' } : null)),
    whoami: vi.fn(async () => (calls.push('whoami'), st.admin && st.aal2)),
    userId: vi.fn(async () => (calls.push('userId'), st.session ? st.userId : null)),
    signOut: vi.fn(async () => {
      calls.push('signOut');
      st.session = null;
      st.aal2 = false;
    }),
  };
  return { st, deps, calls };
}
const resolve = (deps: unknown, search: string) =>
  (gate as unknown as { resolveScreen: (d: unknown, s: string) => Promise<{ screen: string; factorId: string; userId: string | null; notice?: string }> })
    .resolveScreen(deps, search);

describe('AdminScreen type and resolveScreen (AC-M0-17)', () => {
  it('exports resolveScreen', () => expect(typeof (gate as Record<string, unknown>).resolveScreen).toBe('function'));

  it('fresh account: ?confirmed=1 signs out and shows login with the confirmed notice, never touching whoami', async () => {
    const { st, deps, calls } = fakeBackend();
    st.session = { userId: st.userId, amr: ['otp'] }; // the email-link session
    const r = await resolve(deps, '?confirmed=1');
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect(r.screen).toBe('login');
    expect(r.notice).toMatch(/Email confirmed\. Sign in with your password and set up your authenticator\./);
    expect(deps.whoami).not.toHaveBeenCalled();
    expect(calls[0]).toBe('signOut');
  });

  it('?confirmed=1 signs out even an aal2 admin session (email-link session must never reach whoami)', async () => {
    const { st, deps } = fakeBackend();
    Object.assign(st, { session: { userId: st.userId, amr: ['otp'] }, factor: true, aal2: true, admin: true });
    const r = await resolve(deps, '?confirmed=1');
    expect(r.screen).toBe('login');
    expect(deps.whoami).not.toHaveBeenCalled();
  });

  it('full sign-up path: login -> setup -> not_admin with the user id -> console', async () => {
    const { st, deps } = fakeBackend();
    st.session = { userId: st.userId, amr: ['otp'] };
    expect((await resolve(deps, '?confirmed=1')).screen).toBe('login');
    expect((await resolve(deps, '')).screen).toBe('login'); // signed out

    st.session = { userId: st.userId, amr: ['password'] }; // password sign-in: aal1, no factor
    expect((await resolve(deps, '')).screen).toBe('setup');

    Object.assign(st, { factor: true, aal2: true }); // TOTP enrolled and verified
    const na = await resolve(deps, '');
    expect(na.screen).toBe('not_admin');
    expect(na.userId).toBe('user-1234');

    st.admin = true; // conductor inserts the admins row
    const c = await resolve(deps, '');
    expect(c.screen).toBe('console');
  });

  it('aal1 with an enrolled factor -> mfa with the factor id', async () => {
    const { st, deps } = fakeBackend();
    Object.assign(st, { session: { userId: st.userId, amr: ['password'] }, factor: true });
    const r = await resolve(deps, '');
    expect(r.screen).toBe('mfa');
    expect(r.factorId).toBe('factor-1');
  });

  it('?confirmed=0 or an unrelated query does not sign out', async () => {
    const { st, deps } = fakeBackend();
    st.session = { userId: st.userId, amr: ['password'] };
    await resolve(deps, '?confirmed=0');
    await resolve(deps, '?foo=1');
    expect(deps.signOut).not.toHaveBeenCalled();
  });

  it('the pure decideScreen is unchanged (signup is a local UI state, never decided)', () => {
    expect(decideScreen({ hasUser: false, current: null, next: null, isAdmin: null })).toBe('login');
  });
});
