import type { Metadata } from 'next';
import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import schema from '../../../functions/_lib/events.v1.schema.json';

export const metadata: Metadata = {
  title: 'TruckeeVibes events API',
  description: 'A free, read-only JSON API for the TruckeeVibes event list: endpoint, parameters, response fields, errors and caching.',
  alternates: { canonical: '/developers/' },
};

type Prop = { type?: string | string[]; enum?: unknown[]; const?: unknown; description?: string; items?: Prop; $ref?: string; format?: string };
type Obj = { properties: Record<string, Prop>; required?: string[] };

const ENDPOINT = 'https://truckeevibes.com/api/v1/events';

const PARAMS: Array<[string, string, string]> = [
  ['scope', 'vibes (default) or lights', 'vibes = the TruckeeVibes list. lights = the events shown on Truckee Lights and Truckee Frights for one season.'],
  ['season', 'halloween or christmas', 'Required with scope=lights; not allowed otherwise.'],
  ['year', 'four digits, 2025 to 2100', 'The season’s December year. Required with scope=lights.'],
  ['from', 'YYYY-MM-DD', 'First local day (Pacific). Earlier than today means now: ended events never come back.'],
  ['to', 'YYYY-MM-DD', 'Last local day (Pacific), inclusive. The window is at most 120 days.'],
  ['area', 'comma list, up to 10', 'Area slugs, e.g. truckee,donner_lake. scope=vibes only.'],
  ['category', 'comma list, up to 10', 'Category slugs, e.g. music,outdoors. scope=vibes only.'],
  ['limit', '1 to 500', 'Events per page. Default 200 (vibes) or 500 (lights).'],
  ['cursor', 'opaque', 'The nextCursor of the previous page.'],
];

function typeLabel(p: Prop): string {
  if (p.$ref) return 'event';
  if (p.const !== undefined) return JSON.stringify(p.const);
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(p.type) ? p.type.join(' | ') : (p.type ?? '');
  if (t === 'array' && p.items) return `array of ${typeLabel(p.items)}`;
  return p.format ? `${t} (${p.format})` : t;
}

function Fields({ obj, label }: { obj: Obj; label: string }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table aria-label={label} style={{ borderCollapse: 'collapse', width: '100%', fontSize: 15, lineHeight: '22px' }}>
        <thead>
          <tr>
            <th style={cell}>Field</th>
            <th style={cell}>Type</th>
            <th style={cell}>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(obj.properties).map(([k, p]) => (
            <tr key={k}>
              <td style={cell}><code>{k}</code></td>
              <td style={cell}>{typeLabel(p)}</td>
              <td style={cell}>{p.description ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cell = { textAlign: 'left' as const, verticalAlign: 'top' as const, padding: '6px 10px 6px 0', borderBottom: '1px solid var(--line)' };
const pre = { overflowX: 'auto' as const, margin: '0 0 16px', fontSize: 14, lineHeight: '20px' };

// Static server component: no data, no client JS. The field tables come from functions/_lib/events.v1.schema.json at build.
export default function DevelopersPage() {
  const root = schema as unknown as Obj & { $defs: { event: Obj } };
  return (
    <>
      <Header />
      <main className="wrap">
        <div className="pg prose">
          <p className="eyebrow">Developers</p>
          <div className="rule" />
          <h1 className="hero">The TruckeeVibes events API</h1>
          <p style={{ marginTop: 16 }}>
            A free, read-only JSON list of events around Truckee and North Lake Tahoe. No key, no sign-up. Please show the credit line with the data.
          </p>

          <h2 className="h2">Endpoint</h2>
          <p className="card"><code>GET {ENDPOINT}</code></p>
          <pre style={pre}><code>{`curl '${ENDPOINT}?scope=vibes&area=truckee&limit=20'
curl '${ENDPOINT}?scope=lights&season=christmas&year=2026'`}</code></pre>

          <h2 className="h2">Parameters</h2>
          <div style={{ overflowX: 'auto' }}>
            <table aria-label="Parameters" style={{ borderCollapse: 'collapse', width: '100%', fontSize: 15, lineHeight: '22px' }}>
              <thead>
                <tr>
                  <th style={cell}>Name</th>
                  <th style={cell}>Values</th>
                  <th style={cell}>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {PARAMS.map(([n, v, d]) => (
                  <tr key={n}>
                    <td style={cell}><code>{n}</code></td>
                    <td style={cell}>{v}</td>
                    <td style={cell}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>Unknown or repeated parameters are refused. Events are ordered by start time, then id; follow <code>nextCursor</code> until it is null.</p>

          <h2 className="h2">Response</h2>
          <p>One JSON object. The JSON Schema is the contract; new fields may be added within v1, nothing is removed or renamed.</p>
          <Fields obj={root} label="Response fields" />
          <h2 className="h2">Event fields</h2>
          <Fields obj={root.$defs.event} label="Event fields" />

          <h2 className="h2">Errors</h2>
          <ul>
            <li><code>400</code> <code>{'{"error":"bad_param","param":"<name>"}'}</code>: a parameter is unknown, repeated or out of range.</li>
            <li><code>405</code>: only GET, HEAD and OPTIONS are allowed.</li>
            <li><code>503</code> <code>{'{"error":"unavailable"}'}</code> with <code>retry-after: 60</code>: the database is unreachable. There is no stale fallback; try again in a minute.</li>
          </ul>

          <h2 className="h2">Caching</h2>
          <ul>
            <li>Fresh responses: <code>cache-control: public, max-age=60, s-maxage=300</code>. A new or removed event can take up to 5 minutes to show.</li>
            <li>No stale fallback: if the database is down you get a <code>503</code>, never an older copy of the list, so a removed event never comes back. <code>stale</code> is always <code>false</code>.</li>
            <li>For <code>scope=lights</code>, <code>mirror.state</code> says whether the Truckee Lights list was last read cleanly (<code>confirmed</code>) or a large removal is waiting for review (<code>held</code>).</li>
          </ul>

          <h2 className="h2">CORS</h2>
          <p>
            Browsers on truckeelights.com, truckeefrights.com and truckeevibes.com get <code>access-control-allow-origin</code>. This is etiquette, not access control: the data is public, and server-side calls work from anywhere. Please cache responses and keep request rates modest.
          </p>

          <h2 className="h2">Versioning</h2>
          <p>Within <code>/api/v1</code> changes are additive only. A breaking change ships as <code>/api/v2</code>, and v1 keeps working.</p>

          <h2 className="h2">Embed</h2>
          <pre style={pre}><code>{`const res = await fetch('${ENDPOINT}?scope=vibes&limit=20');
const { events, attribution } = await res.json();
// show attribution.name linked to attribution.url with the list`}</code></pre>
        </div>
      </main>
      <Footer />
    </>
  );
}
