import { assert, assertEquals } from '@std/assert';
import { json, timingSafeEqual } from './http.ts';

Deno.test('timingSafeEqual compares fixed-format secrets', () => {
  assert(timingSafeEqual('abc', 'abc'));
  assert(!timingSafeEqual('abc', 'abd'));
  assert(!timingSafeEqual('abc', 'abcd'));
});

Deno.test('json sets status, content type and no-store', async () => {
  const r = json(201, { ok: true });
  assertEquals(r.status, 201);
  assertEquals(r.headers.get('Content-Type'), 'application/json');
  assertEquals(r.headers.get('Cache-Control'), 'no-store');
  assertEquals(await r.json(), { ok: true });
});
