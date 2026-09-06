import Papa from 'papaparse';
import { analysePhone, type PhoneAnalysis } from './phone';
import {
  isValidEmail,
  normalizeEmail,
  normalizeMultiline,
  normalizeName,
  normalizeStateCode,
  normalizeText,
  organizationCandidateKey,
  organizationIdentityKey,
} from './normalize';
import { analyseUrl } from './url';

/**
 * CSV lead import: parsing, column mapping, per-row normalisation, and
 * duplicate/uncertain-match classification.
 *
 * Everything in this module is pure. It never touches the database, so the
 * preview an admin approves is computed by exactly the same code that the
 * confirmation step re-runs.
 */

export const CANONICAL_FIELDS = [
  'clubName',
  'role',
  'contactName',
  'phone',
  'email',
  'city',
  'state',
  'sourceUrl',
  'notes',
  'sport',
  'source',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export const REQUIRED_FIELDS: readonly CanonicalField[] = ['clubName'];

/** Header aliases recognised by the auto-mapper, lowest-friction first. */
const HEADER_ALIASES: Record<CanonicalField, readonly string[]> = {
  clubName: [
    'club_name',
    'club',
    'organization',
    'organisation',
    'organization_name',
    'organisation_name',
    'org',
    'org_name',
    'name',
    'company',
    'company_name',
    'account_name',
    'team_name',
  ],
  role: ['role', 'title', 'position', 'job_title'],
  contactName: ['contact_name', 'contact', 'full_name', 'person', 'director', 'contact_person'],
  phone: ['phone', 'phone_number', 'telephone', 'tel', 'mobile', 'contact_phone'],
  email: ['email', 'email_address', 'e_mail', 'contact_email'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'state_code', 'province', 'region'],
  sourceUrl: ['source_url', 'url', 'website', 'link', 'source_link'],
  notes: ['notes', 'note', 'comments', 'description', 'details'],
  sport: ['sport', 'sports', 'sport_type'],
  source: ['source', 'lead_source', 'origin'],
};

export const FIELD_LABELS: Record<CanonicalField, string> = {
  clubName: 'Club / organization name',
  role: 'Contact role',
  contactName: 'Contact name',
  phone: 'Phone',
  email: 'Email',
  city: 'City',
  state: 'State',
  sourceUrl: 'Source URL',
  notes: 'Notes',
  sport: 'Sport',
  source: 'Source tag',
};

export type ColumnMapping = Partial<Record<CanonicalField, string>>;

function headerKey(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Map the file's headers onto canonical fields. Column *order* is irrelevant;
 * only the header text matters, so future files with a different layout work
 * without code changes.
 */
export function autoMapColumns(headers: readonly string[]): {
  mapping: ColumnMapping;
  unmappedHeaders: string[];
  missingRequired: CanonicalField[];
} {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();

  for (const field of CANONICAL_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const match = headers.find((h) => !used.has(h) && aliases.includes(headerKey(h)));
    if (match !== undefined) {
      mapping[field] = match;
      used.add(match);
    }
  }

  return {
    mapping,
    unmappedHeaders: headers.filter((h) => !used.has(h) && h.trim() !== ''),
    missingRequired: REQUIRED_FIELDS.filter((f) => mapping[f] === undefined),
  };
}

export type ParsedCsv = {
  headers: string[];
  /** Data rows in file order, excluding the header and blank lines. */
  rows: ParsedRow[];
  blankLinesSkipped: number;
  /** Rows whose field count differed from the header's. */
  parseWarnings: { fileLineNumber: number; message: string }[];
  delimiter: string;
  hadBom: boolean;
};

export type ParsedRow = {
  /** 1-based index among data rows. This is what reports and exports cite. */
  sourceRowNumber: number;
  /** 1-based physical line in the original file, header included. */
  fileLineNumber: number;
  values: Record<string, string>;
};

export class CsvParseError extends Error {}

/**
 * Robust parse using PapaParse. Handles UTF-8 BOM, CRLF, quoted commas,
 * multiline quoted fields, ragged rows and blank lines.
 */
export function parseCsv(input: string): ParsedCsv {
  const hadBom = input.charCodeAt(0) === 0xfeff;
  // A single trailing newline is how every well-formed file ends; it is not a
  // blank data line and must not be reported as one.
  const text = (hadBom ? input.slice(1) : input).replace(/\r?\n$/, '');

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
  });

  const rawRows = result.data;
  if (rawRows.length === 0) throw new CsvParseError('The file is empty.');

  const isBlank = (row: readonly string[] | undefined) =>
    !row || row.every((cell) => (cell ?? '').trim() === '');

  // The header is the first non-blank physical line.
  let headerIndex = 0;
  while (headerIndex < rawRows.length && isBlank(rawRows[headerIndex])) headerIndex += 1;
  if (headerIndex >= rawRows.length) throw new CsvParseError('The file contains no header row.');

  const headers = (rawRows[headerIndex] ?? []).map((h) => (h ?? '').replace(/^﻿/, '').trim());
  if (headers.every((h) => h === '')) throw new CsvParseError('The header row is empty.');

  const duplicateHeaders = headers.filter((h, i) => h !== '' && headers.indexOf(h) !== i);
  if (duplicateHeaders.length > 0) {
    throw new CsvParseError(
      `Duplicate column headers: ${[...new Set(duplicateHeaders)].join(', ')}. Rename them and re-upload.`,
    );
  }

  const rows: ParsedRow[] = [];
  const parseWarnings: ParsedCsv['parseWarnings'] = [];
  let blankLinesSkipped = 0;

  for (let i = headerIndex + 1; i < rawRows.length; i += 1) {
    const row = rawRows[i];
    if (isBlank(row)) {
      blankLinesSkipped += 1;
      continue;
    }
    const cells = row ?? [];
    if (cells.length !== headers.length) {
      parseWarnings.push({
        fileLineNumber: i + 1,
        message: `Row has ${cells.length} field(s) but the header has ${headers.length}.`,
      });
    }
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h !== '') values[h] = cells[idx] ?? '';
    });
    rows.push({ sourceRowNumber: rows.length + 1, fileLineNumber: i + 1, values });
  }

  return {
    headers,
    rows,
    blankLinesSkipped,
    parseWarnings,
    delimiter: result.meta.delimiter,
    hadBom,
  };
}

// ---------------------------------------------------------------------------
// Per-row normalisation
// ---------------------------------------------------------------------------

export type PreparedOrganization = {
  name: string;
  city: string | null;
  state: string | null;
  sourceUrl: string | null;
  sourceUrlSafe: boolean;
  notes: string | null;
  sport: string | null;
  source: string | null;
  identityKey: string;
  candidateKey: string;
};

export type PreparedContact = {
  fullName: string | null;
  roleTitle: string | null;
  email: string | null;
  emailValid: boolean;
  phone: PhoneAnalysis;
  sourceUrl: string | null;
} | null;

export type PreparedRow = {
  sourceRowNumber: number;
  fileLineNumber: number;
  raw: Record<string, string>;
  organization: PreparedOrganization | null;
  contact: PreparedContact;
  errors: string[];
  warnings: string[];
};

export type PrepareOptions = {
  /** Applied to every row that has no sport of its own. */
  defaultSport?: string | null;
  /** Applied to every row that has no source tag of its own. */
  defaultSource?: string | null;
};

export function prepareRow(
  row: ParsedRow,
  mapping: ColumnMapping,
  options: PrepareOptions = {},
): PreparedRow {
  const get = (field: CanonicalField): string => {
    const header = mapping[field];
    return header === undefined ? '' : (row.values[header] ?? '');
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  const name = normalizeText(get('clubName'));
  if (name === null) {
    return {
      sourceRowNumber: row.sourceRowNumber,
      fileLineNumber: row.fileLineNumber,
      raw: row.values,
      organization: null,
      contact: null,
      errors: ['Club name is required.'],
      warnings,
    };
  }
  if (name.length > 300) errors.push('Club name is longer than 300 characters.');

  const rawState = normalizeText(get('state'));
  const state = normalizeStateCode(rawState);
  if (rawState !== null && state === null) {
    warnings.push(`State "${rawState}" is not a recognised US state; stored as unassigned.`);
  }
  if (rawState === null) warnings.push('No state supplied; territory cannot be derived.');

  const city = normalizeText(get('city'));
  // Notes keep their line breaks; only stray horizontal whitespace is folded.
  const notes = normalizeMultiline(get('notes'));

  const rawSourceUrl = normalizeText(get('sourceUrl'));
  const url = analyseUrl(rawSourceUrl);
  if (rawSourceUrl !== null && !url.safe) {
    warnings.push(
      `Source URL is not a usable http(s) link${url.reason ? ` (${url.reason})` : ''}; kept as text.`,
    );
  }

  const organization: PreparedOrganization = {
    name,
    city,
    state,
    sourceUrl: rawSourceUrl,
    sourceUrlSafe: url.safe,
    notes,
    sport: normalizeText(get('sport')) ?? normalizeText(options.defaultSport ?? null),
    source: normalizeText(get('source')) ?? normalizeText(options.defaultSource ?? null),
    identityKey: organizationIdentityKey({ name, state, city }),
    candidateKey: organizationCandidateKey({ name, state }),
  };

  // ---- contact ------------------------------------------------------------
  const rawEmail = normalizeText(get('email'));
  const email = normalizeEmail(rawEmail);
  const emailValid = email !== null && isValidEmail(email);
  if (rawEmail !== null && !emailValid) {
    warnings.push(
      `Email "${rawEmail}" is not a valid address; kept for research but not contactable.`,
    );
  }

  const phone = analysePhone(get('phone'));
  if (phone.raw !== null && phone.warning !== null) warnings.push(phone.warning);

  const contactName = normalizeText(get('contactName'));
  const roleTitle = normalizeText(get('role'));

  const hasContactSubstance =
    contactName !== null || roleTitle !== null || email !== null || phone.raw !== null;

  const contact: PreparedContact = hasContactSubstance
    ? {
        fullName: contactName,
        roleTitle,
        email: emailValid ? email : null,
        emailValid,
        phone,
        sourceUrl: url.safe ? url.href : null,
      }
    : null;

  if (!emailValid && !phone.valid) {
    warnings.push('No contactable email or phone; the club is still available for research.');
  }

  return {
    sourceRowNumber: row.sourceRowNumber,
    fileLineNumber: row.fileLineNumber,
    raw: row.values,
    organization,
    contact,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Duplicate / uncertain-match classification
// ---------------------------------------------------------------------------

export type RowOutcome =
  | 'organization_created'
  | 'contact_added'
  | 'updated'
  | 'skipped_duplicate'
  | 'needs_review'
  | 'invalid';

export type ExistingOrganization = {
  id: string;
  name: string;
  identityKey: string;
  candidateKey: string;
  city: string | null;
  state: string | null;
  hasAssignment: boolean;
};

export type ExistingContact = {
  id: string;
  organizationId: string;
  email: string | null;
  phoneDigits: string | null;
};

export type ClassifyContext = {
  /** Existing DB organizations keyed by identity, plus a candidate index. */
  organizationsByIdentity: ReadonlyMap<string, ExistingOrganization>;
  organizationsByCandidate: ReadonlyMap<string, readonly ExistingOrganization[]>;
  /** Existing DB contacts keyed by normalised email. */
  contactsByEmail: ReadonlyMap<string, readonly ExistingContact[]>;
  /** Source keys already recorded by a previous import, for idempotency. */
  knownSourceKeys: ReadonlySet<string>;
};

export type ClassifiedRow = PreparedRow & {
  outcome: RowOutcome;
  reasons: string[];
  /** Set when the row resolves to an existing or earlier-in-file organization. */
  matchedOrganizationId: string | null;
  /** Uncertain candidates presented to the admin for review. */
  reviewCandidates: { id: string | null; label: string; why: string }[];
  /** Stable key that makes re-importing the same file idempotent. */
  sourceKey: string;
};

export function rowSourceKey(row: PreparedRow): string {
  const org = row.organization;
  if (!org) return `invalid:${row.sourceRowNumber}`;
  const contactPart = row.contact
    ? [
        row.contact.email ?? '',
        row.contact.phone.digits ?? '',
        normalizeName(row.contact.fullName) ?? '',
        normalizeName(row.contact.roleTitle) ?? '',
      ].join('~')
    : '';
  return `${org.identityKey}#${contactPart}`;
}

const EMPTY_CONTEXT: ClassifyContext = {
  organizationsByIdentity: new Map(),
  organizationsByCandidate: new Map(),
  contactsByEmail: new Map(),
  knownSourceKeys: new Set(),
};

/**
 * Classify every prepared row against the rest of the file and against what is
 * already in the database.
 *
 * Rules, in order:
 *  1. A row without a club name is `invalid`.
 *  2. A row whose full source key was already imported is `skipped_duplicate`
 *     (this is what makes re-importing the same file a no-op).
 *  3. An identical (organization + contact) pair seen earlier in this same file
 *     is `skipped_duplicate`.
 *  4. An email that already belongs to a *different* organization is
 *     `needs_review` — never an automatic merge.
 *  5. A row with no city whose name+state matches something that does have a
 *     city is `needs_review`; the admin decides whether it is the same club.
 *  6. An exact identity match adds a contact (`contact_added`), or is skipped
 *     when the contact is already present.
 *  7. Otherwise the organization is created.
 */
export function classifyRows(
  rows: readonly PreparedRow[],
  context: ClassifyContext = EMPTY_CONTEXT,
): ClassifiedRow[] {
  // Pre-pass: which name+state groups in this file mix blank and known cities.
  const cityStatesByCandidate = new Map<string, { blank: number; named: Set<string> }>();
  for (const row of rows) {
    const org = row.organization;
    if (!org) continue;
    const entry = cityStatesByCandidate.get(org.candidateKey) ?? { blank: 0, named: new Set() };
    if (org.city === null) entry.blank += 1;
    else entry.named.add(normalizeName(org.city) ?? '');
    cityStatesByCandidate.set(org.candidateKey, entry);
  }

  const seenSourceKeys = new Set<string>();
  const identityToLocalId = new Map<string, string>();
  const emailToIdentity = new Map<string, string>();
  // Contacts already attached to each organization earlier in this same file,
  // so the same person listed twice at one club is a duplicate, not a second
  // contact record.
  const localContactsByIdentity = new Map<string, Set<string>>();
  const out: ClassifiedRow[] = [];

  for (const row of rows) {
    const reasons: string[] = [];
    const reviewCandidates: ClassifiedRow['reviewCandidates'] = [];
    const sourceKey = rowSourceKey(row);
    const org = row.organization;

    if (!org || row.errors.length > 0) {
      out.push({
        ...row,
        outcome: 'invalid',
        reasons: row.errors.length > 0 ? row.errors : ['Row could not be interpreted.'],
        matchedOrganizationId: null,
        reviewCandidates,
        sourceKey,
      });
      continue;
    }

    // (2) already imported by an earlier confirmed batch
    if (context.knownSourceKeys.has(sourceKey)) {
      out.push({
        ...row,
        outcome: 'skipped_duplicate',
        reasons: ['This exact club/contact was already imported by a previous batch.'],
        matchedOrganizationId: context.organizationsByIdentity.get(org.identityKey)?.id ?? null,
        reviewCandidates,
        sourceKey,
      });
      continue;
    }

    // (3) duplicate within this same file
    if (seenSourceKeys.has(sourceKey)) {
      out.push({
        ...row,
        outcome: 'skipped_duplicate',
        reasons: ['Identical club and contact already appears earlier in this file.'],
        matchedOrganizationId: identityToLocalId.get(org.identityKey) ?? null,
        reviewCandidates,
        sourceKey,
      });
      continue;
    }
    seenSourceKeys.add(sourceKey);

    const existing = context.organizationsByIdentity.get(org.identityKey) ?? null;
    const localId = identityToLocalId.get(org.identityKey) ?? null;

    // (4) contact email already known at a different organization
    const email = row.contact?.email ?? null;
    if (email) {
      const dbMatches = context.contactsByEmail.get(email) ?? [];
      const conflicting = dbMatches.filter((c) => c.organizationId !== existing?.id);
      const localOwner = emailToIdentity.get(email);
      const localConflict = localOwner !== undefined && localOwner !== org.identityKey;

      if (conflicting.length > 0 || localConflict) {
        for (const c of conflicting) {
          reviewCandidates.push({
            id: c.organizationId,
            label: 'Existing contact with the same email',
            why: `${email} is already recorded at a different organization.`,
          });
        }
        if (localConflict) {
          reviewCandidates.push({
            id: null,
            label: 'Earlier row in this file',
            why: `${email} also appears under "${localOwner}" in this file.`,
          });
        }
        out.push({
          ...row,
          outcome: 'needs_review',
          reasons: [
            `Email ${email} is associated with a different organization. Confirm whether these are the same club before importing.`,
          ],
          matchedOrganizationId: existing?.id ?? localId,
          reviewCandidates,
          sourceKey,
        });
        continue;
      }
      emailToIdentity.set(email, org.identityKey);
    }

    // (5) uncertain: blank city where a same-name/state club has a real city
    if (org.city === null) {
      const fileGroup = cityStatesByCandidate.get(org.candidateKey);
      const dbGroup = (context.organizationsByCandidate.get(org.candidateKey) ?? []).filter(
        (o) => o.city !== null && o.city.trim() !== '',
      );
      const namedInFile = fileGroup ? [...fileGroup.named].filter((c) => c !== '') : [];

      if (existing === null && (namedInFile.length > 0 || dbGroup.length > 0)) {
        for (const o of dbGroup) {
          reviewCandidates.push({
            id: o.id,
            label: `${o.name} — ${o.city ?? ''}, ${o.state ?? ''}`,
            why: 'Same club name and state, but this row has no city to confirm the location.',
          });
        }
        for (const c of namedInFile) {
          reviewCandidates.push({
            id: null,
            label: `${org.name} — ${c}, ${org.state ?? ''} (elsewhere in this file)`,
            why: 'Same club name and state with a city given on another row.',
          });
        }
        out.push({
          ...row,
          outcome: 'needs_review',
          reasons: [
            'This row has no city, and a club with the same name exists in the same state with a city. Confirm whether they are the same organization.',
          ],
          matchedOrganizationId: null,
          reviewCandidates,
          sourceKey,
        });
        continue;
      }
    }

    // (6) exact identity match -> add a contact to the existing club
    if (existing !== null || localId !== null) {
      const orgId = existing?.id ?? localId;
      if (row.contact === null) {
        out.push({
          ...row,
          outcome: 'skipped_duplicate',
          reasons: ['Club already exists and this row adds no new contact details.'],
          matchedOrganizationId: orgId,
          reviewCandidates,
          sourceKey,
        });
        continue;
      }
      if (email) {
        const sameOrgMatch = (context.contactsByEmail.get(email) ?? []).some(
          (c) => c.organizationId === existing?.id,
        );
        const sameFileMatch = localContactsByIdentity.get(org.identityKey)?.has(email) ?? false;
        if (sameOrgMatch || sameFileMatch) {
          out.push({
            ...row,
            outcome: 'skipped_duplicate',
            reasons: [
              sameOrgMatch
                ? 'This contact is already recorded at this club.'
                : 'This contact already appears at this club earlier in the file.',
            ],
            matchedOrganizationId: orgId,
            reviewCandidates,
            sourceKey,
          });
          continue;
        }
      }
      if (email) {
        const set = localContactsByIdentity.get(org.identityKey) ?? new Set<string>();
        set.add(email);
        localContactsByIdentity.set(org.identityKey, set);
      }
      reasons.push('Club already exists; adding this person as an additional contact.');
      out.push({
        ...row,
        outcome: 'contact_added',
        reasons,
        matchedOrganizationId: orgId,
        reviewCandidates,
        sourceKey,
      });
      continue;
    }

    // (7) new organization
    identityToLocalId.set(org.identityKey, `new:${row.sourceRowNumber}`);
    if (email) localContactsByIdentity.set(org.identityKey, new Set([email]));
    out.push({
      ...row,
      outcome: 'organization_created',
      reasons: reasons.length > 0 ? reasons : ['New organization.'],
      matchedOrganizationId: null,
      reviewCandidates,
      sourceKey,
    });
  }

  return out;
}

export type ImportSummary = {
  totalDataRows: number;
  byOutcome: Record<RowOutcome, number>;
  withWarnings: number;
  blankLinesSkipped: number;
  parseWarnings: number;
  /** True when every parsed data row landed in exactly one outcome bucket. */
  reconciled: boolean;
};

export function summariseClassification(
  rows: readonly ClassifiedRow[],
  parsed: Pick<ParsedCsv, 'blankLinesSkipped' | 'parseWarnings'>,
): ImportSummary {
  const byOutcome: Record<RowOutcome, number> = {
    organization_created: 0,
    contact_added: 0,
    updated: 0,
    skipped_duplicate: 0,
    needs_review: 0,
    invalid: 0,
  };
  let withWarnings = 0;
  for (const r of rows) {
    byOutcome[r.outcome] += 1;
    if (r.warnings.length > 0) withWarnings += 1;
  }
  const counted = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  return {
    totalDataRows: rows.length,
    byOutcome,
    withWarnings,
    blankLinesSkipped: parsed.blankLinesSkipped,
    parseWarnings: parsed.parseWarnings.length,
    reconciled: counted === rows.length,
  };
}

export const OUTCOME_LABELS: Record<RowOutcome, string> = {
  organization_created: 'New club created',
  contact_added: 'Contact added to existing club',
  updated: 'Existing record updated',
  skipped_duplicate: 'Skipped — duplicate',
  needs_review: 'Needs review',
  invalid: 'Invalid — not imported',
};
