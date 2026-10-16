// AC-R1b-01, 02: the lists config (W6 SSOT) and its counts on the visual fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { LISTS, countLists, listBySlug } from './lists';

const ev = (o: Partial<VibeEvent>): VibeEvent => ({ id: 'x', slug: 'x', title: 't', categories: [], age: 'unknown', ...o }) as VibeEvent;
const inList = (slug: string, o: Partial<VibeEvent>) => listBySlug(slug)!.match(ev(o));

describe('AC-R1b-01 LISTS', () => {
  it('has the 8 slugs, paths, labels and titles in order', () => {
    expect(LISTS.map((l) => [l.slug, l.path, l.label, l.title])).toEqual([
      ['all', '/', 'All', ''],
      ['art', '/art/', 'Art', 'Art around Truckee'],
      ['music', '/music/', 'Music', 'Music around Truckee'],
      ['21-plus', '/21-plus/', '21+', '21+ around Truckee'],
      ['kids', '/kids/', 'Kids', "Kids' events around Truckee"],
      ['family', '/family/', 'Family friendly', 'Family friendly around Truckee'],
      ['outdoors', '/outdoors/', 'Outdoors', 'Outdoors around Truckee'],
      ['food-drink', '/food-drink/', 'Food & drink', 'Food & drink around Truckee'],
    ]);
  });
  it('every list has a lede; only Kids is not ready', () => {
    for (const l of LISTS.slice(1)) expect(l.lede.length, l.slug).toBeGreaterThan(20);
    expect(LISTS.filter((l) => !l.ready).map((l) => l.slug)).toEqual(['kids']);
    expect(listBySlug('kids')!.ready).toBe(false);
  });
  it('glyph keys follow the table', () => {
    expect(LISTS.map((l) => l.glyph)).toEqual([null, 'arts', 'music', 'twentyone', 'family', 'family', 'outdoors', 'food-drink']);
  });
  it('the rules', () => {
    expect(inList('kids', { categories: ['kids'], age: '21_plus' })).toBe(false);
    expect(inList('family', { categories: ['kids'], age: '21_plus' })).toBe(false);
    expect(inList('family', { categories: ['family'], age: '18_plus' })).toBe(false);
    expect(inList('family', { categories: [], age: 'all_ages' })).toBe(true);
    expect(inList('family', { categories: [], age: 'family' })).toBe(true);
    expect(inList('family', { categories: ['kids'], age: 'unknown' })).toBe(true);
    expect(inList('kids', { categories: ['kids'], age: 'unknown' })).toBe(true);
    expect(inList('21-plus', { age: '21_plus' })).toBe(true);
    expect(inList('21-plus', { age: '18_plus' })).toBe(false);
    expect(inList('art', { categories: ['arts', 'music'] })).toBe(true);
    expect(inList('music', { categories: ['arts'] })).toBe(false);
    expect(inList('all', { categories: [] })).toBe(true);
  });
  it('listBySlug returns null for an unknown slug', () => expect(listBySlug('nope')).toBeNull());
});

describe('AC-R1b-02 countLists(snapshot-visual)', () => {
  const snap = JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')) as { events: VibeEvent[] };
  it('counts', () => {
    expect(countLists(snap.events)).toEqual({ all: 35, art: 11, music: 10, '21-plus': 2, kids: 0, family: 1, outdoors: 6, 'food-drink': 23 });
  });
});
