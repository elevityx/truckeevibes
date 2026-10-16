// Build-time switches for the redesign. Plain constants so a flag-off branch is dropped from the bundle.

/** DR3: false until the list routes exist (R2a). While false, the Lists menu is not rendered. */
export const LIST_ROUTES_LIVE = false;

/** DR4: the header "Thursday email" button stays hidden until the newsletter exists (M5). */
export const SHOW_THURSDAY_EMAIL = false;

/** Sister-site links for the footer; `null` renders the name as plain text. */
export const SISTER_SITES: { lights: string | null; frights: string | null } = {
  lights: 'https://truckeelights.com/',
  frights: null,
};
