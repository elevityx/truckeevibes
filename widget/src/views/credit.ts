// "Powered by TruckeeVibes" (A7): the muted footnote style, one per list, upcoming section and sheet.
import { el } from '../dom';

export const CREDIT_URL = 'https://truckeevibes.com/';
export const credit = () =>
  el('p', { class: 'fine tv-credit' }, 'Powered by ', el('a', { href: CREDIT_URL, target: '_blank', rel: 'noopener' }, 'TruckeeVibes'));
