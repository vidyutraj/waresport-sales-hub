import { describe, expect, it } from 'vitest';
import {
  autoMapColumns,
  classifyRows,
  CsvParseError,
  parseCsv,
  prepareRow,
  rowSourceKey,
  summariseClassification,
  type ClassifyContext,
  type ColumnMapping,
  type ExistingContact,
  type ExistingOrganization,
} from '@/lib/domain/csv-import';

const HEADERS = 'club_name,role,contact_name,phone,email,city,state,source_url,notes';

const MAPPING: ColumnMapping = {
  clubName: 'club_name',
  role: 'role',
  contactName: 'contact_name',
  phone: 'phone',
  email: 'email',
  city: 'city',
  state: 'state',
  sourceUrl: 'source_url',
  notes: 'notes',
};

function prepareAll(csv: string, mapping: ColumnMapping = MAPPING) {
  const parsed = parseCsv(csv);
  return { parsed, rows: parsed.rows.map((r) => prepareRow(r, mapping)) };
}

describe('column mapping', () => {
  it('auto-maps the exact headers of the supplied file', () => {
    const { mapping, missingRequired, unmappedHeaders } = autoMapColumns(HEADERS.split(','));
    expect(missingRequired).toEqual([]);
    expect(unmappedHeaders).toEqual([]);
    expect(mapping).toMatchObject(MAPPING);
  });

  it('is insensitive to column order', () => {
    const shuffled = ['notes', 'email', 'state', 'club_name', 'city', 'phone'];
    const { mapping, missingRequired } = autoMapColumns(shuffled);
    expect(missingRequired).toEqual([]);
    expect(mapping.clubName).toBe('club_name');
    expect(mapping.email).toBe('email');
  });

  it('recognises common aliases for future files', () => {
    const { mapping } = autoMapColumns(['Organization Name', 'E-Mail', 'Telephone', 'Job Title']);
    expect(mapping.clubName).toBe('Organization Name');
    expect(mapping.email).toBe('E-Mail');
    expect(mapping.phone).toBe('Telephone');
    expect(mapping.role).toBe('Job Title');
  });

  it('reports a missing required column instead of guessing', () => {
    const { missingRequired } = autoMapColumns(['email', 'phone']);
    expect(missingRequired).toEqual(['clubName']);
  });
});

describe('robust parsing', () => {
  it('handles a UTF-8 BOM, CRLF and trailing newline', () => {
    const csv = `﻿${HEADERS}\r\nAlpha Club,President,Ann,919-732-4454,a@alpha.org,Durham,NC,https://x.test,Note\r\n`;
    const parsed = parseCsv(csv);
    expect(parsed.hadBom).toBe(true);
    expect(parsed.headers[0]).toBe('club_name');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.values.club_name).toBe('Alpha Club');
  });

  it('handles quoted commas and embedded quotes', () => {
    const csv = `${HEADERS}\n"Smith, Jones & Co Baseball",President,"O\"\"Brien, Pat",919-732-4454,a@b.org,Cary,NC,https://x.test,"Notes, with a comma"\n`;
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]!.values.club_name).toBe('Smith, Jones & Co Baseball');
    expect(parsed.rows[0]!.values.contact_name).toBe('O"Brien, Pat');
    expect(parsed.rows[0]!.values.notes).toBe('Notes, with a comma');
  });

  it('handles multiline quoted notes', () => {
    const csv = `${HEADERS}\nAlpha,President,Ann,919-732-4454,a@b.org,Cary,NC,https://x.test,"line one\nline two"\n`;
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.values.notes).toBe('line one\nline two');
  });

  it('skips blank lines without shifting row numbers', () => {
    const csv = `${HEADERS}\nA,,,,,,,,\n\n\nB,,,,,,,,\n`;
    const parsed = parseCsv(csv);
    expect(parsed.blankLinesSkipped).toBe(2);
    expect(parsed.rows.map((r) => r.sourceRowNumber)).toEqual([1, 2]);
    expect(parsed.rows.map((r) => r.fileLineNumber)).toEqual([2, 5]);
  });

  it('warns about ragged rows but still imports them', () => {
    const csv = `${HEADERS}\nAlpha,President\n`;
    const parsed = parseCsv(csv);
    expect(parsed.parseWarnings).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.values.club_name).toBe('Alpha');
  });

  it('rejects an empty file, a headerless file and duplicate headers', () => {
    expect(() => parseCsv('')).toThrow(CsvParseError);
    expect(() => parseCsv('\n\n')).toThrow(/no header row/);
    expect(() => parseCsv('a,a\n1,2')).toThrow(/Duplicate column headers/);
  });
});

describe('row preparation', () => {
  it('requires a club name', () => {
    const { rows } = prepareAll(`${HEADERS}\n   ,President,Ann,919-732-4454,a@b.org,Cary,NC,,x\n`);
    expect(rows[0]!.errors).toEqual(['Club name is required.']);
    expect(rows[0]!.organization).toBeNull();
  });

  it('keeps a record with no email and no phone, with a warning', () => {
    const { rows } = prepareAll(`${HEADERS}\nAlpha Club,,,,,Cary,NC,https://x.test,Some note\n`);
    const row = rows[0]!;
    expect(row.errors).toEqual([]);
    expect(row.organization?.name).toBe('Alpha Club');
    expect(row.contact).toBeNull();
    expect(row.warnings.join(' ')).toMatch(/still available for research/);
  });

  it('lower-cases email but preserves the phone exactly', () => {
    const { rows } = prepareAll(
      `${HEADERS}\nAlpha,President,Ann,"0919-732-4454 ext 12",PRESIDENT@Alpha.ORG,Cary,NC,,n\n`,
    );
    expect(rows[0]!.contact?.email).toBe('president@alpha.org');
    expect(rows[0]!.contact?.phone.raw).toBe('0919-732-4454 ext 12');
    expect(rows[0]!.contact?.phone.extension).toBe('12');
  });

  it('keeps a row whose email is malformed but whose phone works', () => {
    const { rows } = prepareAll(
      `${HEADERS}\nAlpha,President,Ann,919-732-4454,not-an-email,Cary,NC,,n\n`,
    );
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.contact?.email).toBeNull();
    expect(rows[0]!.contact?.phone.valid).toBe(true);
    expect(rows[0]!.warnings.join(' ')).toMatch(/not a valid address/);
  });

  it('flags an unsafe source URL without discarding the row', () => {
    const { rows } = prepareAll(
      `${HEADERS}\nAlpha,President,Ann,919-732-4454,a@b.org,Cary,NC,javascript:alert(1),n\n`,
    );
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.organization?.sourceUrlSafe).toBe(false);
    expect(rows[0]!.organization?.sourceUrl).toBe('javascript:alert(1)');
    expect(rows[0]!.warnings.join(' ')).toMatch(/not a usable http/);
  });

  it('flags an unrecognised state', () => {
    const { rows } = prepareAll(`${HEADERS}\nAlpha,,,919-732-4454,a@b.org,Cary,ZZ,,n\n`);
    expect(rows[0]!.organization?.state).toBeNull();
    expect(rows[0]!.warnings.join(' ')).toMatch(/not a recognised US state/);
  });

  it('normalises whitespace in text fields', () => {
    const { rows } = prepareAll(`${HEADERS}\n"  Alpha   Club  ",,,,,"  Cary ",nc,,\n`);
    expect(rows[0]!.organization?.name).toBe('Alpha Club');
    expect(rows[0]!.organization?.city).toBe('Cary');
    expect(rows[0]!.organization?.state).toBe('NC');
  });
});

describe('duplicate and uncertain-match classification', () => {
  const emptyContext: ClassifyContext = {
    organizationsByIdentity: new Map(),
    organizationsByCandidate: new Map(),
    contactsByEmail: new Map(),
    knownSourceKeys: new Set(),
  };

  it('creates one organization and adds further contacts to it', () => {
    const { rows } = prepareAll(
      `${HEADERS}\n` +
        `Cordova Little League,President,Ann,907-424-0001,ann@c.org,Cordova,AK,,n\n` +
        `Cordova Little League,Treasurer,Bob,907-424-0002,bob@c.org,Cordova,AK,,n\n`,
    );
    const classified = classifyRows(rows, emptyContext);
    expect(classified.map((r) => r.outcome)).toEqual(['organization_created', 'contact_added']);
  });

  it('keeps same-named clubs in different states apart', () => {
    const { rows } = prepareAll(
      `${HEADERS}\n` +
        `Diamond Youth Softball,State Director,Ann,803-000-0001,a@d.org,Sumter,SC,,n\n` +
        `Diamond Youth Softball,State Director,Bob,214-000-0002,b@d.org,Dallas,TX,,n\n`,
    );
    const classified = classifyRows(rows, emptyContext);
    expect(classified.map((r) => r.outcome)).toEqual([
      'organization_created',
      'organization_created',
    ]);
  });

  it('skips an exact duplicate row within the file', () => {
    const line = 'Alpha,President,Ann,919-732-4454,ann@alpha.org,Cary,NC,,n';
    const { rows } = prepareAll(`${HEADERS}\n${line}\n${line}\n`);
    const classified = classifyRows(rows, emptyContext);
    expect(classified.map((r) => r.outcome)).toEqual(['organization_created', 'skipped_duplicate']);
    expect(classified[1]!.reasons[0]).toMatch(/already appears earlier in this file/);
  });

  it('holds an email that belongs to a different club for review', () => {
    const { rows } = prepareAll(
      `${HEADERS}\n` +
        `Alpha Club,President,Ann,919-000-0001,shared@gmail.com,Cary,NC,,n\n` +
        `Beta Club,President,Bob,919-000-0002,shared@gmail.com,Apex,NC,,n\n`,
    );
    const classified = classifyRows(rows, emptyContext);
    expect(classified[0]!.outcome).toBe('organization_created');
    expect(classified[1]!.outcome).toBe('needs_review');
    expect(classified[1]!.reasons[0]).toMatch(/associated with a different organization/);
  });

  it('never merges two clubs merely because they share a consumer mail domain', () => {
    const { rows } = prepareAll(
      `${HEADERS}\n` +
        `Alpha Club,President,Ann,919-000-0001,alpha@gmail.com,Cary,NC,,n\n` +
        `Beta Club,President,Bob,919-000-0002,beta@gmail.com,Apex,NC,,n\n`,
    );
    const classified = classifyRows(rows, emptyContext);
    expect(classified.map((r) => r.outcome)).toEqual([
      'organization_created',
      'organization_created',
    ]);
  });

  it('holds a city-less row for review when a same-name club has a city', () => {
    const { rows } = prepareAll(
      `${HEADERS}\n` +
        `Flood City Elite,President,Ann,814-000-0001,a@f.org,Windber,PA,,n\n` +
        `Flood City Elite,Director,Bob,814-000-0002,b@f.org,,PA,,n\n`,
    );
    const classified = classifyRows(rows, emptyContext);
    expect(classified[0]!.outcome).toBe('organization_created');
    expect(classified[1]!.outcome).toBe('needs_review');
    expect(classified[1]!.reviewCandidates.length).toBeGreaterThan(0);
  });

  it('creates a city-less club when nothing else shares its name and state', () => {
    const { rows } = prepareAll(
      `${HEADERS}\nWashington Babe Ruth,Commissioner,Ann,206-000-0001,a@w.org,,WA,,n\n`,
    );
    expect(classifyRows(rows, emptyContext)[0]!.outcome).toBe('organization_created');
  });

  it('matches an existing database organization and adds the contact', () => {
    const existing: ExistingOrganization = {
      id: 'org-1',
      name: 'Alpha Club',
      identityKey: 'alpha club|NC|cary',
      candidateKey: 'alpha club|NC',
      city: 'Cary',
      state: 'NC',
      hasAssignment: true,
    };
    const context: ClassifyContext = {
      organizationsByIdentity: new Map([[existing.identityKey, existing]]),
      organizationsByCandidate: new Map([[existing.candidateKey, [existing]]]),
      contactsByEmail: new Map(),
      knownSourceKeys: new Set(),
    };
    const { rows } = prepareAll(
      `${HEADERS}\nAlpha Club,Treasurer,Bob,919-000-0002,bob@alpha.org,Cary,NC,,n\n`,
    );
    const classified = classifyRows(rows, context);
    expect(classified[0]!.outcome).toBe('contact_added');
    expect(classified[0]!.matchedOrganizationId).toBe('org-1');
  });

  it('skips a contact that already exists at the same club', () => {
    const existing: ExistingOrganization = {
      id: 'org-1',
      name: 'Alpha Club',
      identityKey: 'alpha club|NC|cary',
      candidateKey: 'alpha club|NC',
      city: 'Cary',
      state: 'NC',
      hasAssignment: false,
    };
    const contact: ExistingContact = {
      id: 'c-1',
      organizationId: 'org-1',
      email: 'bob@alpha.org',
      phoneDigits: '9190000002',
    };
    const context: ClassifyContext = {
      organizationsByIdentity: new Map([[existing.identityKey, existing]]),
      organizationsByCandidate: new Map([[existing.candidateKey, [existing]]]),
      contactsByEmail: new Map([['bob@alpha.org', [contact]]]),
      knownSourceKeys: new Set(),
    };
    const { rows } = prepareAll(
      `${HEADERS}\nAlpha Club,Treasurer,Bob,919-000-0002,bob@alpha.org,Cary,NC,,n\n`,
    );
    expect(classifyRows(rows, context)[0]!.outcome).toBe('skipped_duplicate');
  });

  it('is idempotent when the same file is re-imported', () => {
    const csv =
      `${HEADERS}\n` +
      `Alpha,President,Ann,919-000-0001,ann@alpha.org,Cary,NC,,n\n` +
      `Beta,President,Bob,919-000-0002,bob@beta.org,Apex,NC,,n\n`;
    const first = classifyRows(prepareAll(csv).rows, emptyContext);
    expect(first.every((r) => r.outcome === 'organization_created')).toBe(true);

    // Second pass, with the source keys the first import recorded.
    const second = classifyRows(prepareAll(csv).rows, {
      ...emptyContext,
      knownSourceKeys: new Set(first.map((r) => r.sourceKey)),
    });
    expect(second.every((r) => r.outcome === 'skipped_duplicate')).toBe(true);
  });

  it('produces a stable source key for the same row content', () => {
    const csv = `${HEADERS}\nAlpha,President,Ann,919-000-0001,ann@alpha.org,Cary,NC,,n\n`;
    const a = prepareAll(csv).rows[0]!;
    const b = prepareAll(csv).rows[0]!;
    expect(rowSourceKey(a)).toBe(rowSourceKey(b));
  });

  it('accounts for every data row in mutually exclusive buckets', () => {
    const csv =
      `${HEADERS}\n` +
      `Alpha,President,Ann,919-000-0001,ann@alpha.org,Cary,NC,,n\n` +
      `Alpha,President,Ann,919-000-0001,ann@alpha.org,Cary,NC,,n\n` +
      `,President,Bad,919-000-0003,bad@x.org,Cary,NC,,n\n` +
      `Beta,President,Bob,919-000-0002,ann@alpha.org,Apex,NC,,n\n`;
    const { parsed, rows } = prepareAll(csv);
    const classified = classifyRows(rows, emptyContext);
    const summary = summariseClassification(classified, parsed);
    expect(summary.totalDataRows).toBe(4);
    expect(summary.reconciled).toBe(true);
    expect(summary.byOutcome).toEqual({
      organization_created: 1,
      contact_added: 0,
      updated: 0,
      skipped_duplicate: 1,
      needs_review: 1,
      invalid: 1,
    });
  });
});
