import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { env } from '@/lib/env';
import { listTerritories } from '@/lib/queries/program';
import { Alert, Card, CardBody, CardHeader, LinkButton, PageHeader } from '@/components/ui';
import { ImportWizard } from '@/components/client/import-wizard';

export const metadata = { title: 'Import leads' };
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const user = await requireAdmin();
  const e = env();

  const { territories, mappedStates } = await asUser(user.id, async (tx) => ({
    territories: await listTerritories(tx),
    mappedStates: Number(
      (await tx<{ c: string }[]>`SELECT count(*)::text AS c FROM territory_states`)[0]?.c ?? 0,
    ),
  }));

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/admin/leads" className="hover:text-brand-600">
            ← Leads &amp; imports
          </Link>
        }
        title="Import leads"
        description="Upload a CSV, review exactly what will happen, then confirm. Nothing is written until you confirm."
        actions={<LinkButton href="/admin/settings">Territory settings</LinkButton>}
      />

      {mappedStates === 0 ? (
        <Alert tone="caution" className="mb-5" title="No state-to-territory mapping configured">
          Clubs will import without a territory and will be flagged as unassigned. Set the mapping
          in Settings first if you want territories derived automatically.
        </Alert>
      ) : null}

      <Card className="mb-5">
        <CardHeader
          title="File requirements"
          description="Column order does not matter; headers are matched by name."
        />
        <CardBody>
          <ul className="grid gap-1.5 text-[13px] text-ink-700">
            <li>
              <strong>Club name is required.</strong> Email and phone are optional — a club with no
              contact details is still imported and flagged for research.
            </li>
            <li>
              Handles UTF-8 with or without a BOM, CRLF or LF line endings, quoted commas, quotes
              inside quotes, multiline notes, and blank lines.
            </li>
            <li>
              Recognised headers include <code className="font-mono">club_name</code>,{' '}
              <code className="font-mono">role</code>,{' '}
              <code className="font-mono">contact_name</code>,{' '}
              <code className="font-mono">phone</code>, <code className="font-mono">email</code>,{' '}
              <code className="font-mono">city</code>, <code className="font-mono">state</code>,{' '}
              <code className="font-mono">source_url</code>,{' '}
              <code className="font-mono">notes</code>.
            </li>
            <li>
              Limits: {(e.IMPORT_MAX_FILE_BYTES / 1_000_000).toFixed(0)} MB and{' '}
              {e.IMPORT_MAX_ROWS.toLocaleString()} rows.
            </li>
            <li>
              Duplicates default to <strong>skip</strong>. Uncertain matches are held for your
              review rather than merged.
            </li>
          </ul>
        </CardBody>
      </Card>

      <ImportWizard territoryCount={territories.length} />
    </>
  );
}
