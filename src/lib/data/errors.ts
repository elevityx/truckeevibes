import { DataError, type DataErrorCode } from './types';

// `grant_*` codes never reach the client (they belong to the ingest path).
const CODES: readonly string[] = [
  'not_signed_in', 'forbidden', 'not_found', 'invalid_input', 'exists', 'rate_limited',
  'source_not_permitted', 'captcha_failed', 'auth_failed', 'network', 'unknown',
] satisfies DataErrorCode[];

function isAuthError(e: object): boolean {
  const name = (e as { name?: unknown }).name;
  return typeof name === 'string' && name.startsWith('Auth');
}

/** Map PostgREST / Auth / fetch errors to a DataError. */
export function toDataError(e: unknown): DataError {
  if (e instanceof DataError) return e;
  if (e instanceof TypeError) return new DataError('network');
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; details?: unknown };
    const message = typeof o.message === 'string' ? o.message : '';
    const detail = typeof o.details === 'string' && o.details !== '' ? o.details : undefined;
    if (CODES.includes(message)) return new DataError(message as DataErrorCode, detail);
    if (message.toLowerCase().includes('captcha')) return new DataError('captcha_failed');
    if (isAuthError(e)) return new DataError('auth_failed');
  }
  return new DataError('unknown');
}

export function userMessage(e: DataError): string {
  switch (e.code) {
    case 'rate_limited':
      return 'Slow down a little and try again later.';
    case 'captcha_failed':
      return "The bot check didn't go through. Try it again.";
    case 'network':
      return "Can't reach the server. Check your connection.";
    case 'not_signed_in':
      return 'Sign in to continue.';
    case 'forbidden':
      return 'That needs a fresh sign-in with your authenticator code.';
    case 'source_not_permitted':
      return 'That source has no current permission record, so it cannot be turned on.';
    case 'auth_failed':
      return "Those details didn't work. Check them and try again.";
    default:
      return 'Something went wrong. Try again.';
  }
}
