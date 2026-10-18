// A12: TTUSD school calendars. The grammar here is the single source of truth for what may be published from a school or
// district calendar: a title passes only when it matches one of a few anchored whole-title templates, decided on the full
// decoded title before anything is shaped, truncated or submitted. Anything else is dropped. Pure: no network, no clock.
import { makeEvent } from '../adapters/common';
import type { SourceEvent } from '../types';
import { capReasons } from './reasonCodes';

export type SchoolKey = 'district' | 'ths' | 'nths' | 'acms' | 'nts' | 'te' | 'tle' | 'kbe' | 'dte' | 'ges' | 'shs';
export interface School {
  key: SchoolKey; name: string; address: string; town: string; level: 'district' | 'high' | 'middle' | 'elementary';
  refs: string[]; homeConvention?: 'vs' | 'marker';
}

export const SCHOOLS: Record<SchoolKey, School> = {
  district: { key: 'district', name: 'Tahoe Truckee Unified School District', address: '11603 Donner Pass Rd, Truckee, CA 96161', town: 'Truckee', level: 'district',
    refs: ['ttusd', 'tahoe truckee unified school district'] },
  ths: { key: 'ths', name: 'Truckee High School', address: '11725 Donner Pass Rd, Truckee, CA 96161', town: 'Truckee', level: 'high',
    refs: ['ths', 'truckee high school', 'truckee high'], homeConvention: 'vs' },
  nths: { key: 'nths', name: 'North Tahoe High School', address: '2945 Polaris Rd, Tahoe City, CA 96145', town: 'Tahoe City', level: 'high',
    refs: ['nths', 'north tahoe high school', 'north tahoe high'], homeConvention: 'marker' },
  acms: { key: 'acms', name: 'Alder Creek Middle School', address: '10931 Alder Dr, Truckee, CA 96161', town: 'Truckee', level: 'middle',
    refs: ['acms', 'alder creek middle school', 'alder creek'], homeConvention: 'marker' },
  nts: { key: 'nts', name: 'North Tahoe School', address: '2945 Polaris Rd, Tahoe City, CA 96145', town: 'Tahoe City', level: 'middle',
    refs: ['nts', 'north tahoe school'], homeConvention: 'marker' },
  te: { key: 'te', name: 'Truckee Elementary School', address: '11911 Donner Pass Rd, Truckee, CA 96161', town: 'Truckee', level: 'elementary',
    refs: ['te', 'tes', 'truckee elementary school', 'truckee elementary'] },
  tle: { key: 'tle', name: 'Tahoe Lake Elementary School', address: '375 Grove St, Tahoe City, CA 96145', town: 'Tahoe City', level: 'elementary',
    refs: ['tle', 'tahoe lake elementary school', 'tahoe lake'] },
  kbe: { key: 'kbe', name: 'Kings Beach Elementary School', address: '8125 Steelhead Ave, Kings Beach, CA 96143', town: 'Kings Beach', level: 'elementary',
    refs: ['kbe', 'kings beach elementary school', 'kings beach elementary'] },
  dte: { key: 'dte', name: 'Donner Trail Elementary School', address: '52755 Donner Pass Rd, Kingvale, CA 95728', town: 'Kingvale', level: 'elementary',
    refs: ['dte', 'donner trail elementary school', 'donner trail'] },
  ges: { key: 'ges', name: 'Glenshire Elementary School', address: '10990 Dorchester Dr, Truckee, CA 96161', town: 'Truckee', level: 'elementary',
    refs: ['ge', 'ges', 'glenshire elementary school', 'glenshire'] },
  shs: { key: 'shs', name: 'Sierra High School', address: '11661 Donner Pass Rd, Truckee, CA 96161', town: 'Truckee', level: 'high',
    refs: ['shs', 'sierra high school', 'sierra high'] },
};

export type DropReason = 'oversize' | 'restricted' | 'internal' | 'notice_dup' | 'notice_timed' | 'no_match' | 'dup';
export type Rule = 'ceremony' | 'open_house' | 'performance' | 'festival' | 'home_game';
export type Decision = { kind: 'notice' } | { kind: 'event'; rule: Rule; school: SchoolKey } | { kind: 'drop'; reason: DropReason };

/** Opponents of the sample feeds (closed list, lowercase). Widening it is a code edit plus a cases row. */
export const OPPONENTS = [
  'south tahoe hs', 'south tahoe', 'debbie smith', 'sparks', 'incline middle school', 'incline', 'wooster', 'pau wa lu', 'pa wa lu',
  'carson valley', 'carson middle school', 'carson ms', 'whittell middle', 'whittell', 'north tahoe', 'eagle valley', 'tea',
  'lake tahoe school', 'lts', 'kbe', 'fernley', 'fallon', 'elko', 'douglas', 'lowry', 'reed', 'lovelock', 'encina', 'spanish springs',
  'truckee', 'ths', 'nths', 'acms',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).map(esc).join('|');

const REF_TO_SCHOOL = new Map<string, SchoolKey>();
for (const s of Object.values(SCHOOLS)) for (const r of s.refs) REF_TO_SCHOOL.set(r, s.key);
/** A whole leading school reference (longest first), then an optional colon. */
const PREFIX = new RegExp(`^(${alt([...REF_TO_SCHOOL.keys()])})(?![a-z0-9])\\s*:?\\s*`);

const SEP = '\\s*-{1,2}\\s*';
const HOL = "(?:veteran'?s'? day|thanksgiving|christmas|new year'?s(?: day)?|martin luther king(?:,? jr\\.?)? day|mlk day|president'?s'? day|lincoln'?s birthday|memorial day|labor day|cesar chavez day|juneteenth|independence day|good friday)";

const RESTRICTED = /\b(?:students? only|staff only|members?|invitation|invite only|private|closed to the public|parents? only|families only|seniors only|by ticket only)\b/;
// Conference week keeps its minimum-day notice (the one exception to INTERNAL). "all week" is the feed's own wording.
const CONFERENCE_MIN = new RegExp(`^conference week${SEP}(?:tk-8 |tk-5 )?minimum days?(?: all week)?$`);
const INTERNAL = /\b(?:board|meetings?|mtg|committee|council|elac|delac|pto|pta|booster|trainings?|screeners?|screening|assessments?|field trips?|picture day|conferences?|tutoring|drills?|collaborat\w*|leadership|ilt|staff|teachers?|parents?|workshops?|orientation|registration|deadline|exams?|finals|progress|reports?|reporting|trimester|banquets?|rally|assembly|spirit (?:day|week)|appreciation|celebrations?|rehearsals?|practice|tryouts?|iep|sarb|ia|counsel\w*|dismiss\w*|dance)\b/;

const NOTICES = [
  new RegExp(`^(?:no school|school closed)(?:${SEP}${HOL})?$`),
  new RegExp(`^${HOL}${SEP}no school$`),
  new RegExp(`^holiday${SEP}${HOL}$`),
  new RegExp(`^(?:thanksgiving|winter|holiday|spring|december|february|ski) break(?:${SEP}no school)?$`),
  /^(?:all schools |middle\/high schools |elementary schools? |middle schools? |high schools? )?minimum days?$/,
  /^(?:first|last) day of school$/,
];

const T = {
  ceremony: /^(?:(?:class of \d{4}|8th grade|5th grade|senior|kindergarten|tk)\s+)?(?:graduation|commencement|promotion)(?: ceremony)?$/,
  open_house: /^open house(?: and (?:spring|fall|winter) musical)?$/,
  performance: /^(?:(?:fall|winter|spring|holiday|all-school|band|choir|jazz|orchestra|music)\s+)*(?:concert|musical|play|showcase|recital)(?:, (?:cafetorium|gym|theater|theatre|auditorium))?$/,
  festival: /^(?:(?:fall|spring|winter|annual|halloween|harvest|family|community|school)\s+)*(?:pumpkin patch(?: (?:&|and) kermes)?|kermes|festival|carnival|fair|book fair|parade|walk-? ?a-? ?thon|fun run|family night|science night|math night|literacy night|stem night|movie night|trunk or treat)!?$/,
};

const LVL = '(?:(?:boys|girls|jv|varsity|frosh|freshman|middle school)\\s+)*';
const SPORT = '(?:basketball|soccer|football|volleyball|baseball|softball|wrestling|tennis|lacrosse|hockey|track|cross country|golf|water polo)';
const OPP = `(?:${alt(OPPONENTS)})`;
const TIMES_BODY = '\\s*\\((?:(?:jv|v|fr|frosh|varsity)\\s*@\\s*\\d{1,2}(?::\\d{2})?(?:,\\s*)?)+\\)';
const TIMES_SRC = `(?:${TIMES_BODY})?`;
const TIMES_ONCE = new RegExp(TIMES_BODY);
const OFFSITE = /\b(?:offsite|off-site|neutral|site|away|at)\b|@(?!\s*\d)/;
const GAME_MARKER = new RegExp(`^${LVL}${SPORT} (?:home vs\\.?\\s+${OPP}|vs\\.?\\s+${OPP}\\s+\\(home\\))${TIMES_SRC}$`);
const GAME_VS = new RegExp(`^${LVL}${SPORT} vs\\.?\\s+${OPP}${TIMES_SRC}$`);

/** Decoded text -> single-spaced, straight quotes and hyphens (case kept). */
const tidy = (s: string) => s.replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const norm = (s: string) => tidy(s).toLowerCase();

interface Analysis { decision: Decision; /** characters of the tidy title taken by a leading school reference (district titles only) */ prefixLen: number }

function analyze(rawTitle: string, allDay: boolean, source: SchoolKey): Analysis {
  const drop = (reason: DropReason): Analysis => ({ decision: { kind: 'drop', reason }, prefixLen: 0 });
  const t = norm(rawTitle);
  if (t.length > 80) return drop('oversize');
  if (RESTRICTED.test(t)) return drop('restricted');
  const notice = (): Analysis => {
    if (source !== 'district') return drop('notice_dup');
    return allDay ? { decision: { kind: 'notice' }, prefixLen: 0 } : drop('notice_timed');
  };
  if (CONFERENCE_MIN.test(t)) return notice();
  if (INTERNAL.test(t)) return drop('internal');
  if (NOTICES.some((re) => re.test(t))) return notice();

  const pm = PREFIX.exec(t);
  const forms: { rest: string; ref?: string; len: number }[] = [];
  if (pm) forms.push({ rest: t.slice(pm[0].length), ref: pm[1], len: pm[0].length });
  forms.push({ rest: t, len: 0 });
  const ev = (rule: Rule, f: { ref?: string; len: number }): Analysis => ({
    decision: { kind: 'event', rule, school: source === 'district' ? (f.ref ? REF_TO_SCHOOL.get(f.ref)! : 'district') : source },
    prefixLen: source === 'district' && tidy(rawTitle).length === t.length ? f.len : 0,
  });
  for (const f of forms) {
    for (const rule of ['ceremony', 'open_house', 'performance', 'festival'] as const) if (T[rule].test(f.rest)) return ev(rule, f);
  }
  // Games: only the home forms, a listed opponent, no off-site word, and only for a school with a reviewed home convention.
  const conv = SCHOOLS[source].homeConvention;
  if (conv && !OFFSITE.test(t.replace(TIMES_ONCE, ''))) {
    if (GAME_MARKER.test(t) || (conv === 'vs' && GAME_VS.test(t))) return ev('home_game', { len: 0 });
  }
  return drop('no_match');
}

/** Pure decision on the full decoded title. */
export function decideSchoolTitle(rawTitle: string, allDay: boolean, source: SchoolKey): Decision {
  return analyze(rawTitle, allDay, source).decision;
}

export interface RawOccurrence {
  externalKey: string; title: string; allDay: boolean; startsAt: string; endsAt?: string; startDate?: string; endDate?: string; url?: string;
}
export interface Filtered { items: SourceEvent[]; filtered: number; reasons: Partial<Record<DropReason, number>> }

const KEEP_CLASSIFIER = new Set(['halloween-fall', 'holiday']);
const MUSIC = /\b(?:concert|musical|band|choir|jazz|orchestra)\b/;

function categoriesFor(rule: Rule, title: string, school: School): string[] {
  const cats = new Set<string>(['schools']);
  if (rule === 'ceremony' || rule === 'open_house') cats.add('community');
  if (rule === 'performance') { cats.add('arts'); if (MUSIC.test(title.toLowerCase())) cats.add('music'); }
  if (rule === 'home_game') cats.add('sports');
  if (rule === 'festival') { cats.add('community'); cats.add('family'); if (school.level === 'elementary') cats.add('kids'); }
  return [...cats];
}

const idOf = (k: string) => { const n = Number.parseInt(k, 10); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };

/**
 * Decides every occurrence on its full title, then shapes the survivors. Venue and categories come from the school directory and
 * the matched template only; page location text is never read. Output is ordered by occurrence id.
 */
export function filterSchoolItems(raw: RawOccurrence[], source: SchoolKey, tz: string, _now: Date): Filtered {
  void _now;
  const reasons: Partial<Record<DropReason, number>> = {};
  const count = (r: DropReason) => { reasons[r] = (reasons[r] ?? 0) + 1; };
  const items: SourceEvent[] = [];
  const seen = new Set<string>();
  const ordered = [...raw].sort((a, b) => idOf(a.externalKey) - idOf(b.externalKey) || (a.externalKey < b.externalKey ? -1 : a.externalKey > b.externalKey ? 1 : 0));
  for (const o of ordered) {
    const a = analyze(o.title, o.allDay, source);
    if (a.decision.kind === 'drop') { count(a.decision.reason); continue; }
    const full = tidy(o.title);
    const title = a.prefixLen > 0 ? full.slice(a.prefixLen).trim() : full;
    const school = SCHOOLS[a.decision.kind === 'event' ? a.decision.school : source];
    const key = [school.key, norm(title), o.allDay ? `d${o.startDate ?? ''}` : `t${o.startsAt}`].join('|');
    if (seen.has(key)) { count('dup'); continue; }
    seen.add(key);

    const cats = a.decision.kind === 'event' ? categoriesFor(a.decision.rule, title, school) : ['schools'];
    const e = makeEvent({
      externalKey: o.externalKey, title, startsAt: o.startsAt, endsAt: o.endsAt, allDay: o.allDay, startDate: o.startDate, endDate: o.endDate,
      tz, venueName: school.name, address: school.address, town: school.town, url: o.url, hints: cats, family: 'html_finalsite',
    });
    const own = a.decision.kind === 'event' ? e.categoriesHint.filter((c) => KEEP_CLASSIFIER.has(c)) : [];
    const final = [...new Set([...cats, ...own])].sort();
    let tagReasons = (e.tagReasons ?? []).filter((c) => c !== 'cat:title_kw' || own.length > 0);
    if (!tagReasons.includes('cat:source_map')) tagReasons = ['cat:source_map', ...tagReasons];
    items.push({ ...e, categoriesHint: final, tagReasons: capReasons(tagReasons) });
  }
  return { items, filtered: Object.values(reasons).reduce((n, x) => n + (x ?? 0), 0), reasons };
}
