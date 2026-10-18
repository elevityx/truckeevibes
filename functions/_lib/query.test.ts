// AC-W1-19: parseQuery, every rule with a passing and a failing case; canonical form.
import { describe, expect, it } from 'vitest';
import { parseQuery } from './query';

const p = (qs: string) => parseQuery(new URL(`https://truckeevibes.com/api/v1/events${qs ? `?${qs}` : ''}`));
const bad = (qs: string) => {
  const r = p(qs);
  return r.ok ? `accepted: ${r.canonical}` : r.param;
};
const ok = (qs: string) => {
  const r = p(qs);
  if (!r.ok) throw new Error(`refused ${qs}: ${r.param}`);
  return r;
};

describe('AC-W1-19 parseQuery', () => {
  it('no params -> scope vibes', () => {
    expect(ok('').q).toEqual({ scope: 'vibes' });
  });
  it('unknown keys -> that key', () => {
    expect(bad('nope=1')).toBe('nope');
    expect(bad('scope=vibes&Area=truckee')).toBe('Area');
  });
  it('duplicate keys -> that key', () => {
    expect(bad('area=truckee&area=donner_lake')).toBe('area');
    expect(bad('limit=5&limit=5')).toBe('limit');
  });
  it('scope enum', () => {
    expect(ok('scope=vibes').q.scope).toBe('vibes');
    expect(ok('scope=lights&season=halloween&year=2026').q.scope).toBe('lights');
    expect(bad('scope=all')).toBe('scope');
    expect(bad('scope=')).toBe('scope');
  });
  it('season enum', () => {
    expect(ok('scope=lights&season=christmas&year=2026').q.season).toBe('christmas');
    expect(bad('scope=lights&season=Halloween&year=2026')).toBe('season');
    expect(bad('scope=lights&season=easter&year=2026')).toBe('season');
  });
  it('year ^\\d{4}$', () => {
    expect(ok('scope=lights&season=halloween&year=2026').q.year).toBe(2026);
    expect(bad('scope=lights&season=halloween&year=26')).toBe('year');
    expect(bad('scope=lights&season=halloween&year=2026.0')).toBe('year');
    expect(bad('scope=lights&season=halloween&year=+2026')).toBe('year');
  });
  it('from/to: YYYY-MM-DD and a real date', () => {
    expect(ok('from=2026-10-17&to=2026-11-01').q).toMatchObject({ from: '2026-10-17', to: '2026-11-01' });
    expect(ok('from=2028-02-29').q.from).toBe('2028-02-29');
    expect(bad('from=2026-02-30')).toBe('from');
    expect(bad('from=2026-13-01')).toBe('from');
    expect(bad('from=20261017')).toBe('from');
    expect(bad('to=2026-1-7')).toBe('to');
    expect(bad('to=2027-02-29')).toBe('to');
  });
  it('area/category: comma lists of <= 10 items, each ^[a-z0-9_-]{1,40}$', () => {
    expect(ok('area=truckee,donner_lake').q.area).toEqual(['donner_lake', 'truckee']);
    expect(ok('category=halloween-fall').q.category).toEqual(['halloween-fall']);
    expect(ok(`area=${Array.from({ length: 10 }, (_, i) => `a${i}`).join(',')}`).q.area).toHaveLength(10);
    expect(bad(`area=${Array.from({ length: 11 }, (_, i) => `a${i}`).join(',')}`)).toBe('area');
    expect(bad('area=Truckee')).toBe('area');
    expect(bad('area=truckee,,donner_lake')).toBe('area');
    expect(bad('area=')).toBe('area');
    expect(bad(`category=${'a'.repeat(41)}`)).toBe('category');
    expect(ok(`category=${'a'.repeat(40)}`).q.category).toEqual(['a'.repeat(40)]);
    expect(bad('category=music%20night')).toBe('category');
  });
  it('limit ^\\d{1,3}$ within 1..500', () => {
    expect(ok('limit=1').q.limit).toBe(1);
    expect(ok('limit=500').q.limit).toBe(500);
    expect(bad('limit=0')).toBe('limit');
    expect(bad('limit=501')).toBe('limit');
    expect(bad('limit=1000')).toBe('limit');
    expect(bad('limit=-1')).toBe('limit');
    expect(bad('limit=5x')).toBe('limit');
  });
  it('cursor ^[A-Za-z0-9_-]{1,200}$', () => {
    expect(ok('cursor=MjAyNi0xMC0xN1QyMDowMDowMC4wMDAwMDBafDAw').q.cursor).toBe('MjAyNi0xMC0xN1QyMDowMDowMC4wMDAwMDBafDAw');
    expect(ok(`cursor=${'A'.repeat(200)}`).q.cursor).toHaveLength(200);
    expect(bad(`cursor=${'A'.repeat(201)}`)).toBe('cursor');
    expect(bad('cursor=abc%3D')).toBe('cursor');
    expect(bad('cursor=')).toBe('cursor');
  });
  it('scope=lights requires season and year and rejects area/category', () => {
    expect(bad('scope=lights')).toBe('season');
    expect(bad('scope=lights&season=halloween')).toBe('year');
    expect(bad('scope=lights&year=2026')).toBe('season');
    expect(bad('scope=lights&season=halloween&year=2026&area=truckee')).toBe('area');
    expect(bad('scope=lights&season=halloween&year=2026&category=music')).toBe('category');
  });
  it('scope=vibes rejects season/year (the SQL rule, checked before the RPC)', () => {
    expect(bad('season=halloween')).toBe('season');
    expect(bad('scope=vibes&year=2026')).toBe('year');
  });
  it('canonical: keys sorted, lists sorted and de-duplicated', () => {
    expect(ok('area=b,a,a').canonical).toBe(ok('area=a,b').canonical);
    expect(ok('area=b,a,a').canonical).toBe('area=a,b&scope=vibes');
    expect(ok('limit=5&scope=vibes&from=2026-10-17').canonical).toBe(ok('from=2026-10-17&limit=5').canonical);
    expect(ok('year=2026&season=halloween&scope=lights').canonical).toBe('scope=lights&season=halloween&year=2026');
  });
});
