// Build/server only (like snapshotFile.ts): reads the picks file and throws on a schema or lint failure, so a bad pick fails the build.
// Never import this from a client component.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePicksFile, type PicksFile } from './picks';

export const PICKS_DEFAULT = 'src/content/picks.json';

/** The picks file (PICKS_PATH, else src/content/picks.json), validated. Throws `picks: <code>`. */
export function readPicks(path: string = process.env.PICKS_PATH || join(process.cwd(), PICKS_DEFAULT)): PicksFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('picks: unreadable');
  }
  return parsePicksFile(raw);
}
