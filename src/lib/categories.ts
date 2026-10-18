/** The 14 category slugs (the 12 of the seed migration plus `kids` and `schools`) in display order, with the short labels the rail uses. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  music: 'Music',
  'food-drink': 'Food & drink',
  outdoors: 'Outdoors',
  family: 'Family',
  kids: 'Kids',
  arts: 'Arts',
  community: 'Community',
  markets: 'Markets',
  sports: 'Sports',
  nightlife: 'Nightlife',
  learning: 'Learning',
  holiday: 'Holiday',
  'halloween-fall': 'Halloween',
  schools: 'Schools',
};

export const CATEGORY_SLUGS: readonly string[] = Object.keys(CATEGORY_LABELS);
