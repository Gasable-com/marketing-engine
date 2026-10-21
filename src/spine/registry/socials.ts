/**
 * A company's social profiles, in one canonical form per profile so the same
 * page linked three ways is one identifier. Pure: no database, no network.
 */

/** In the order a screen lists them: LinkedIn first, the one that matters most. */
export const SOCIAL_NETWORKS = ['linkedin', 'instagram', 'x', 'facebook', 'tiktok', 'youtube', 'snapchat'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export type SocialProfile = { network: SocialNetwork; value: string };
export type Socials = Partial<Record<SocialNetwork, string[]>>;

/** First path segments that are a feature of the network, not somebody's handle. */
const INSTAGRAM_NOT = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'share', 'direct', 'tv']);
const X_NOT = new Set([
  'intent', 'share', 'home', 'i', 'hashtag', 'search', 'login', 'signup', 'explore', 'settings', 'messages',
  'privacy', 'tos',
]);
// The rest are not in the brief's table, but taking the first segment would
// store one value for every company that links them. `pages`, `pg`, `groups`
// and `people` have the name after them. `p` is how Facebook shows a page with
// no username (`/p/Acme-1000…/`), `share` is what its Share button copies, and
// the others are features; none can be a page's own name.
const FACEBOOK_NOT = new Set([
  'sharer', 'dialog', 'login', 'plugins', 'events', 'photo', 'photos', 'watch', 'hashtag', 'help', 'policies',
  'privacy', 'tr', 'pages', 'pg', 'groups', 'people',
  'p', 'share', 'reel', 'reels', 'videos', 'stories', 'media', 'business', 'marketplace', 'gaming', 'notes',
  'profile', 'messages', 'friends', 'settings', 'about', 'legal', 'docs', 'ads', 'l',
]);
/** Facebook's own sites, not a locale of the main one: docs, link redirects, its company pages. */
const FACEBOOK_SITES = /^(developers|l|lm|about|transparency|graph)\.facebook\.com$/;

/**
 * Second path segments that make a link one post, not the profile: an
 * embedded tweet or a linked post is often another account's, and reducing it
 * to its author would give the company that account.
 */
const POST = new Set([
  'status', 'statuses', 'p', 'reel', 'reels', 'tv', 'posts', 'photos', 'photo', 'videos', 'video', 'permalink.php',
  'story.php', 'activity',
]);

/** A page or company name as the networks allow it, in any script. */
const NAME = /^[\p{L}\p{M}\p{N}._-]+$/u;

/**
 * The canonical form of a link to a company's social profile, or null when
 * the link is not one: a person, a post, a share button, a network's own
 * page. Lower-cased, no scheme, no query, no trailing slash; the network is
 * the value's first host label.
 */
export function canonicalSocial(url: string): SocialProfile | null {
  const link = parse(url);
  if (!link) return null;
  const { host, segments, params } = link;
  const first = segments[0]?.toLowerCase() ?? '';
  const post = POST.has(segments[1]?.toLowerCase() ?? '');

  // Locale and country subdomains (`sa.`, `ar-ar.`, `web.`) are the same site.
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    // Only a company page: `/in/` is a person, and `/school/`, `/showcase/`,
    // `/jobs/`, `/posts/` and the share links are not the company. Anything
    // after the slug (`/about/`, an admin's `/mycompany/verification/`) is a
    // view of the same page.
    const slug = segments[1]?.toLowerCase();
    if (first !== 'company' || !slug || !NAME.test(slug)) return null;
    return { network: 'linkedin', value: `linkedin.com/company/${slug}` };
  }

  if (onSite(host, 'instagram.com')) {
    // `/_u/acme` is a link that opens the app on acme's profile.
    const handle = first === '_u' ? (segments[1]?.toLowerCase() ?? '') : first;
    if (post || INSTAGRAM_NOT.has(handle) || !/^[a-z0-9._]{1,30}$/.test(handle)) return null;
    return { network: 'instagram', value: `instagram.com/${handle}` };
  }

  if (onSite(host, 'x.com') || onSite(host, 'twitter.com')) {
    if (post || X_NOT.has(first) || !/^[a-z0-9_]{1,15}$/.test(first)) return null;
    return { network: 'x', value: `x.com/${first}` };
  }

  if (FACEBOOK_SITES.test(host)) return null;
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || onSite(host, 'fb.com')) {
    // A page with no name of its own is only reachable by its number.
    if (first === 'profile.php') {
      const id = params.get('id') ?? '';
      return /^\d+$/.test(id) ? { network: 'facebook', value: `facebook.com/profile.php?id=${id}` } : null;
    }
    // Any other script (`sharer.php`, `share.php`, `home.php`) is a feature.
    if (post || first.endsWith('.php') || FACEBOOK_NOT.has(first) || !NAME.test(first)) return null;
    return { network: 'facebook', value: `facebook.com/${first}` };
  }

  // Only the account itself: `/@acme/video/…` and `vm.tiktok.com` short links
  // name a video, which may be anybody's repost.
  if (onSite(host, 'tiktok.com')) {
    if (segments.length !== 1 || !/^@[a-z0-9._]{1,24}$/.test(first)) return null;
    return { network: 'tiktok', value: `tiktok.com/${first}` };
  }

  // `youtu.be` is a video, so it never gets here.
  if (onSite(host, 'youtube.com')) {
    if (/^@[\p{L}\p{M}\p{N}._-]{1,30}$/u.test(first)) return { network: 'youtube', value: `youtube.com/${first}` };
    const name = segments[1] ?? '';
    // A channel id is case-sensitive: lower-cased, its link goes nowhere.
    if (first === 'channel' && /^[A-Za-z0-9_-]+$/.test(name)) {
      return { network: 'youtube', value: `youtube.com/channel/${name}` };
    }
    if ((first === 'c' || first === 'user') && NAME.test(name)) {
      return { network: 'youtube', value: `youtube.com/${first}/${name.toLowerCase()}` };
    }
    return null;
  }

  if (onSite(host, 'snapchat.com')) {
    const handle = segments[1]?.toLowerCase() ?? '';
    if (first !== 'add' || !/^[a-z0-9._-]{1,15}$/.test(handle)) return null;
    return { network: 'snapchat', value: `snapchat.com/add/${handle}` };
  }

  return null;
}

/**
 * The social identifiers among these, as links a screen can open, grouped by
 * network: LinkedIn first, keys only for networks present, each network's
 * profiles in the order given.
 */
export function groupSocials(identifiers: readonly { type: string; value: string }[]): Socials {
  const socials = identifiers.filter((i) => i.type === 'social');
  const grouped: Socials = {};
  for (const network of SOCIAL_NETWORKS) {
    const urls = socials
      .filter((i) => i.value.slice(0, i.value.indexOf('.')) === network)
      .map((i) => `https://${i.value}`);
    if (urls.length) grouped[network] = urls;
  }
  return grouped;
}

/** The host itself, or the plain, `www.` and mobile forms of it. */
function onSite(host: string, site: string): boolean {
  return host === site || host === `www.${site}` || host === `m.${site}` || host === `mobile.${site}`;
}

/**
 * Host, decoded path segments and query of a link as a page or a caller
 * wrote it: with or without a scheme, protocol-relative, any case.
 */
function parse(url: string): { host: string; segments: string[]; params: URLSearchParams } | null {
  let text = url.trim();
  if (text.startsWith('//')) text = `https:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { host: parsed.hostname.replace(/\.$/, ''), segments, params: parsed.searchParams };
}
