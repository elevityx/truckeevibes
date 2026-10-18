// AC-W1-27 (repo half): /developers/ is built from the schema and listed in the sitemap; AGENTS.md carries V13.
// Reads the static export, so it is a BUILD-TIME check: run `npm run build` first (CI `web` job does).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const p = (...s) => join(REPO_ROOT, ...s);
const read = (...s) => readFileSync(p(...s), 'utf8');

describe('AC-W1-27 /developers/', () => {
  it('is in public/sitemap.xml (and /admin/ still is not)', () => {
    const sm = read('public', 'sitemap.xml');
    expect(sm).toContain('<url><loc>https://truckeevibes.com/developers/</loc></url>');
    expect(sm).not.toContain('/admin/');
  });
  it('builds, and its field tables list every schema key (envelope and event)', () => {
    const f = p('out', 'developers', 'index.html');
    expect(existsSync(f), 'out/developers/index.html (run npm run build first)').toBe(true);
    const html = read('out', 'developers', 'index.html');
    const schema = JSON.parse(read('functions', '_lib', 'events.v1.schema.json'));
    for (const k of [...Object.keys(schema.properties), ...Object.keys(schema.$defs.event.properties)]) expect(html).toContain(`<code>${k}</code>`);
    expect(html).toContain('https://truckeevibes.com/api/v1/events');
  });
});

describe('W1.4 AGENTS.md', () => {
  const agents = read('AGENTS.md');
  it('V1 names api_events_v1 among the public reads', () => {
    expect(agents.split('\n').find((l) => l.startsWith('- V1 '))).toContain('`api_events_v1`');
  });
  it('V13 states the Pages Function rules', () => {
    expect(agents).toMatch(/- V13 Pages Functions are GET\/HEAD\/OPTIONS only, hold no secret, call only anon-granted read RPCs with the publishable key, log counts only/);
  });
  it('V6 notes the lights_mirror description exception', () => {
    expect(agents.split('\n').find((l) => l.startsWith('- V6 '))).toContain('lights_mirror');
  });
  it('Layout lists functions/', () => {
    expect(agents).toContain('- `functions/` (Cloudflare Pages Functions');
  });
});
