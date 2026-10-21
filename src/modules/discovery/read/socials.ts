import { canonicalSocial, type SocialNetwork } from '../../../spine/registry/socials.js';
import type { Link } from './text.js';

/**
 * A company's social profiles, found by pattern among its pages' links,
 * without Claude: each is a verbatim link, so it needs no quote check.
 */

/** A page may link a brand's or a branch's profile beside its own; the first few are kept. */
const PER_NETWORK = 3;

/**
 * Distinct canonical profiles in the order the links give them, so the first
 * of a network is the one the home page linked. Share buttons, people and
 * posts are not profiles, and fall out in canonicalSocial.
 */
export function socialsIn(links: readonly Link[]): string[] {
  const found: string[] = [];
  const counts = new Map<SocialNetwork, number>();
  for (const link of links) {
    const profile = canonicalSocial(link.url);
    if (!profile || found.includes(profile.value)) continue;
    const n = counts.get(profile.network) ?? 0;
    if (n >= PER_NETWORK) continue;
    counts.set(profile.network, n + 1);
    found.push(profile.value);
  }
  return found;
}
