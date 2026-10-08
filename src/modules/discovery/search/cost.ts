import { env } from '../../../env.js';

/**
 * Serper bills in credits and the operator thinks in money. A credit's price
 * depends on the pack bought, so it is configuration, and every money figure
 * is worked out when it is read: credits from the event log times the price
 * now. A corrected price corrects every figure at once, past and future.
 */

/** The event the search stage appends for every query, cached or not. */
export const QUERIED_EVENT = 'discovery.task.queried';

export function usdPerCredit(): number {
  return env().SERPER_USD_PER_CREDIT;
}

/** Rounded to a millionth of a dollar, so sums of float products stay clean. */
export function usdFor(credits: number): number {
  return Math.round(credits * usdPerCredit() * 1e6) / 1e6;
}
