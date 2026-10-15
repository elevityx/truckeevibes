import { describe, expect, it } from 'vitest';
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
