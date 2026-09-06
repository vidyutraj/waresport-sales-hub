/**
 * Link safety.
 *
 * Imported notes and source URLs are attacker-influenced data. Only http(s)
 * links are ever rendered as clickable; everything else is displayed as inert
 * text so a `javascript:` or `data:` payload can never become a live link.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

export type UrlAnalysis = {
  raw: string | null;
  href: string | null;
  hostname: string | null;
  safe: boolean;
  reason: string | null;
};

export function analyseUrl(input: string | null | undefined): UrlAnalysis {
  const raw = (input ?? '').trim();
  if (raw === '') return { raw: null, href: null, hostname: null, safe: false, reason: null };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Bare hosts like "example.org/path" are a common spreadsheet shape.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(raw)) {
      try {
        parsed = new URL(`https://${raw}`);
      } catch {
        return { raw, href: null, hostname: null, safe: false, reason: 'Not a valid URL.' };
      }
    } else {
      return { raw, href: null, hostname: null, safe: false, reason: 'Not a valid URL.' };
    }
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    return {
      raw,
      href: null,
      hostname: parsed.hostname || null,
      safe: false,
      reason: `Unsupported link protocol "${parsed.protocol}".`,
    };
  }
  if (!parsed.hostname) {
    return { raw, href: null, hostname: null, safe: false, reason: 'URL has no host.' };
  }

  return {
    raw,
    href: parsed.toString(),
    hostname: parsed.hostname.toLowerCase(),
    safe: true,
    reason: null,
  };
}

export function isSafeHref(input: string | null | undefined): boolean {
  return analyseUrl(input).safe;
}

/** Registrable-ish domain used as weak corroborating evidence when matching. */
export function domainFromUrl(input: string | null | undefined): string | null {
  const a = analyseUrl(input);
  if (!a.hostname) return null;
  return a.hostname.replace(/^www\./, '');
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'live.com',
  'msn.com',
  'comcast.net',
  'verizon.net',
  'sbcglobal.net',
  'att.net',
  'bellsouth.net',
  'cox.net',
  'protonmail.com',
  'proton.me',
  'mac.com',
  'ymail.com',
  'charter.net',
  'earthlink.net',
  'roadrunner.com',
  'rocketmail.com',
]);

/**
 * A shared consumer-mail domain says nothing about two clubs being the same
 * organization, so it must never contribute to a merge decision.
 */
export function isSharedEmailProvider(domain: string | null | undefined): boolean {
  return domain ? FREE_EMAIL_DOMAINS.has(domain.toLowerCase()) : false;
}

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? '').lastIndexOf('@');
  if (at < 0) return null;
  const d = email!
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return d === '' ? null : d;
}
