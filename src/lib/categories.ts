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

/**
 * Access labels (A13): categories that tag an event but are not a kind of event, so they stay out of `CATEGORY_LABELS`, the Rail and the
 * filter URL (`cat=members-only` is ignored). Today only Tahoe Donner's own "members only" wording sets one.
 */
export const ACCESS_TAG_LABELS: Readonly<Record<string, string>> = {
  'members-only': 'Members only',
};
