// AC-M0-17 (Amendment 4, A4-3): admin sign-up helpers against a mocked Supabase client.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = {
  signUp: vi.fn(),
  getUser: vi.fn(),
};
vi.mock('@/lib/supabase/client', () => ({ getSupabase: () => ({ auth }) }));

import * as admin from './admin';
import { DataError } from './types';

beforeEach(() => {
  auth.signUp.mockReset();
  auth.getUser.mockReset();
});

describe('adminSignUp', () => {
  it('calls auth.signUp with the captcha token and an /admin/?confirmed=1 redirect', async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: 'u1' }, session: null }, error: null });
    await admin.adminSignUp('a@b.test', 'correct horse battery', 'tok');
    expect(auth.signUp).toHaveBeenCalledTimes(1);
    const arg = auth.signUp.mock.calls[0][0];
    expect(arg.email).toBe('a@b.test');
    expect(arg.password).toBe('correct horse battery');
    expect(arg.options.captchaToken).toBe('tok');
    expect(arg.options.emailRedirectTo).toMatch(/\/admin\/\?confirmed=1$/);
  });

  it('needsConfirmation is true when there is no session', async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: 'u1' }, session: null }, error: null });
    await expect(admin.adminSignUp('a@b.test', 'pw', 't')).resolves.toEqual({ needsConfirmation: true });
  });

  it('an already-registered email (obfuscated user, no session) gets the same result', async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: 'u2', identities: [] }, session: null }, error: null });
    await expect(admin.adminSignUp('a@b.test', 'pw', 't')).resolves.toEqual({ needsConfirmation: true });
  });

  it('needsConfirmation is false when a session is returned', async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: 'u3' }, session: { access_token: 'x' } }, error: null });
    await expect(admin.adminSignUp('a@b.test', 'pw', 't')).resolves.toEqual({ needsConfirmation: false });
  });

  it('throws a DataError on an auth error', async () => {
    auth.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { name: 'AuthApiError', message: 'boom' } });
    const err = await admin.adminSignUp('a@b.test', 'pw', 't').catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.code).toBe('auth_failed');
  });

  it('maps a captcha error to captcha_failed', async () => {
    auth.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { name: 'AuthApiError', message: 'captcha verification process failed' } });
    const err = await admin.adminSignUp('a@b.test', 'pw', 't').catch((e) => e);
    expect(err.code).toBe('captcha_failed');
  });
});

describe('adminUserId', () => {
  it('returns the id of a non-anonymous user', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: false } }, error: null });
    await expect(admin.adminUserId()).resolves.toBe('u1');
  });
  it('returns null for an anonymous user or no user', async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: 'anon', is_anonymous: true } }, error: null });
    await expect(admin.adminUserId()).resolves.toBeNull();
    auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(admin.adminUserId()).resolves.toBeNull();
  });
  it('wraps errors as DataError', async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', message: 'x' } });
    await expect(admin.adminUserId()).rejects.toBeInstanceOf(DataError);
  });
});

describe('data barrel', () => {
  it('exports adminSignUp and adminUserId from index', async () => {
    const idx = await import('./index');
    expect(typeof idx.adminSignUp).toBe('function');
    expect(typeof idx.adminUserId).toBe('function');
  });
});
