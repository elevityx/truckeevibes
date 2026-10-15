// Build-time snapshot. M0: writes an empty snapshot so `next build` works with no env.
// M1 fills it from the public RPCs when NEXT_PUBLIC_SUPABASE_URL is set.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'src/data/snapshot.json';
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: null, events: [] }) + '\n');
console.log(`snapshot: wrote empty snapshot to ${OUT}`);
