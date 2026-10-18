// AC-W1-20 (CORS half): the allowlist and the per-request CORS headers.
import { describe, expect, it } from 'vitest';
import { ORIGINS, allowedOrigin } from './origins';
import { corsHeaders } from './cors';

describe('origins', () => {
  it('the five production origins (A5)', () => {
    expect([...ORIGINS]).toEqual(['https://truckeelights.com', 'https://www.truckeelights.com', 'https://truckeefrights.com',
      'https://www.truckeefrights.com', 'https://truckeevibes.com']);
    for (const o of ORIGINS) expect(allowedOrigin(o, 'main')).toBe(o);
  });
  it('anything else is refused', () => {
    for (const o of ['https://evil.example', 'http://truckeelights.com', 'https://truckeelights.com.evil.example', 'null', '']) {
      expect(allowedOrigin(o, 'main')).toBeNull();
    }
    expect(allowedOrigin(null, 'main')).toBeNull();
  });
  it('http://localhost:3000 only off main', () => {
    expect(allowedOrigin('http://localhost:3000', 'main')).toBeNull();
    expect(allowedOrigin('http://localhost:3000', 'w1-api')).toBe('http://localhost:3000');
    expect(allowedOrigin('http://localhost:3000', undefined)).toBe('http://localhost:3000');
    expect(allowedOrigin('http://localhost:3001', 'w1-api')).toBeNull();
  });
  it('corsHeaders echoes an allowed origin with vary: Origin; none for others', () => {
    const h = corsHeaders('https://truckeefrights.com', 'main');
    expect(h.get('access-control-allow-origin')).toBe('https://truckeefrights.com');
    expect(h.get('vary')).toBe('Origin');
    const x = corsHeaders('https://evil.example', 'main');
    expect(x.get('access-control-allow-origin')).toBeNull();
    expect(x.get('vary')).toBe('Origin');
  });
});
