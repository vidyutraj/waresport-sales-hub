/**
 * Normalisation helpers.
 *
 * These are the TypeScript twins of the IMMUTABLE SQL functions in
 * db/migrations/0001_core.sql (`app.normalize_name`, `app.normalize_email`,
 * `app.phone_digits`). They must stay behaviourally identical, because the
 * database's unique indexes are built on the SQL versions while the import
 * preview computes matches with these. tests/unit/normalize.test.ts and
 * tests/integration/parity.test.ts pin the two together.
 */

/** Collapse whitespace and trim. Returns null for an empty result. */
export function normalizeText(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().replace(/\s+/g, ' ');
  return v === '' ? null : v;
}

/**
 * Normalisation for long free text (imported notes).
 *
 * Unlike `normalizeText`, this preserves line breaks: a multiline note in the
 * source file is content, not stray whitespace, and flattening it loses
 * information the intern may need. Runs of spaces/tabs collapse to one space
 * and runs of blank lines collapse to one.
 */
export function normalizeMultiline(value: string | null | undefined): string | null {
  const v = (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return v === '' ? null : v;
}

/**
 * Fold case, replace every non-alphanumeric run with a single space, collapse
 * and trim. Deliberately conservative: no stop-word removal, no stemming, no
 * dropping of "Inc"/"Association" — two clubs must never merge on a fuzzy
 * name resemblance alone.
 */
export function normalizeName(value: string | null | undefined): string | null {
  const v = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v === '' ? null : v;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

export function phoneDigits(value: string | null | undefined): string | null {
  const v = (value ?? '').replace(/\D/g, '');
  return v === '' ? null : v;
}

/** Two-letter USPS state code, or null when the value is unusable. */
export function normalizeStateCode(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(v) && US_STATE_CODES.has(v)) return v;
  const byName = US_STATE_BY_NAME.get(v.toLowerCase());
  return byName ?? null;
}

// RFC-5322 in full is not worth the false negatives here; this is the same
// shape the database CHECK constraint enforces.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

export function isValidEmail(value: string | null | undefined): boolean {
  const v = normalizeEmail(value);
  return v !== null && v.length <= 254 && EMAIL_RE.test(v);
}

export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

export const US_STATE_CODES: ReadonlySet<string> = new Set(Object.keys(US_STATE_NAMES));

const US_STATE_BY_NAME = new Map(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * Organization identity key: normalised name + state + city.
 *
 * Same name in a different state is a different club (the supplied file has
 * "Diamond Youth Softball" in 44 states). Same name in a different city of the
 * same state is also treated as distinct — merging those would silently
 * combine two real organizations.
 */
export function organizationIdentityKey(input: {
  name: string;
  state?: string | null;
  city?: string | null;
}): string {
  return [
    normalizeName(input.name) ?? '',
    normalizeStateCode(input.state) ?? '',
    normalizeName(input.city) ?? '',
  ].join('|');
}

/** Weaker key used only to *surface* candidates for admin review. */
export function organizationCandidateKey(input: { name: string; state?: string | null }): string {
  return [normalizeName(input.name) ?? '', normalizeStateCode(input.state) ?? ''].join('|');
}
