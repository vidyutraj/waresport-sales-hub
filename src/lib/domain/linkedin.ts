/**
 * LinkedIn profile URL canonicalisation.
 *
 * Requirements handled here:
 *  - accept http or https input, canonicalise to https
 *  - accept only genuine LinkedIn hostnames (including country subdomains),
 *    rejecting look-alikes such as `linkedin.com.evil.example`
 *  - accept only *profile* paths (/in/<id>), not feeds, companies or posts
 *  - strip tracking query parameters, fragments and trailing slashes
 *  - preserve the public identifier's original casing while de-duplicating
 *    case-insensitively
 *  - never fetch or scrape the URL
 */

export type LinkedInAnalysis =
  | {
      ok: true;
      /** Canonical https URL with the original public-id casing preserved. */
      url: string;
      /** Lowercased canonical URL; the workspace-wide de-duplication key. */
      key: string;
      publicId: string;
      raw: string;
    }
  | { ok: false; reason: string; raw: string };

/** `linkedin.com` itself, or any of its country/locale subdomains. */
function isLinkedInHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

// LinkedIn public ids are alphanumerics, hyphens and (for localised ids)
// percent-encoded or unicode letters. Keep this strict but not ASCII-only.
const PUBLIC_ID_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\-_%]{1,98}[\p{L}\p{N}%])?$/u;

export function analyseLinkedInProfileUrl(input: string | null | undefined): LinkedInAnalysis {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: false, reason: 'A LinkedIn profile URL is required.', raw };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.', raw };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported link protocol "${parsed.protocol}".`, raw };
  }
  if (!isLinkedInHost(parsed.hostname)) {
    return { ok: false, reason: `"${parsed.hostname}" is not a LinkedIn domain.`, raw };
  }

  // Only /in/<publicId> profile paths. /company, /feed, /posts, /pub etc. are
  // rejected so the tracker cannot fill up with non-people links.
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  // A locale prefix is only a locale when the segment after it is "in";
  // otherwise "in" itself (two letters) would be mistaken for one.
  const hasLocalePrefix =
    segments.length > 2 &&
    /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[0]!) &&
    segments[1]!.toLowerCase() === 'in';
  const localeStripped = hasLocalePrefix ? segments.slice(1) : segments;

  if (localeStripped.length < 2 || localeStripped[0]!.toLowerCase() !== 'in') {
    return {
      ok: false,
      reason: 'Enter a personal profile link (linkedin.com/in/…), not a company or post URL.',
      raw,
    };
  }
  if (localeStripped.length > 2) {
    return {
      ok: false,
      reason: 'That looks like a profile sub-page, not the profile itself.',
      raw,
    };
  }

  const publicId = localeStripped[1]!;
  if (!PUBLIC_ID_RE.test(publicId)) {
    return { ok: false, reason: 'That profile identifier is not valid.', raw };
  }

  // Canonical form: https, www host, no query string, no fragment, no trailing
  // slash. Casing of the public id is preserved in `url` and folded in `key`.
  const url = `https://www.linkedin.com/in/${publicId}`;
  return { ok: true, url, key: url.toLowerCase(), publicId, raw };
}

export function isLinkedInProfileUrl(input: string | null | undefined): boolean {
  return analyseLinkedInProfileUrl(input).ok;
}
