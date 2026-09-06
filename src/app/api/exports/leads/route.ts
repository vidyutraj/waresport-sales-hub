import { NextResponse } from 'next/server';
import { asUser } from '@/lib/db';
import { currentUser, isAdminRole } from '@/lib/auth/session';
import { listLeads, type LeadFilters } from '@/lib/queries/leads';
import { csvFilename, toCsv } from '@/lib/domain/csv-export';
import { analysePhone, formatPhone } from '@/lib/domain/phone';

export const dynamic = 'force-dynamic';

/**
 * Filtered lead export.
 *
 * Uses the same `listLeads` query as the screen, so the file always matches
 * what the admin was looking at. Every cell goes through the formula-injection
 * escaper, and unsafe source URLs are exported as inert text.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });
  if (!isAdminRole(user.role)) return new NextResponse('Forbidden', { status: 403 });

  const params = new URL(request.url).searchParams;
  const value = (key: string) => params.get(key) || null;

  const filters: LeadFilters = {
    search: value('q'),
    state: value('state'),
    city: value('city'),
    sport: value('sport'),
    source: value('source'),
    status: value('status'),
    territoryId: value('territoryId'),
    assigneeId: value('assigneeId'),
    assignment: value('assignment') as LeadFilters['assignment'],
    contactability: value('contactability') as LeadFilters['contactability'],
    page: 1,
    // A hard ceiling keeps one click from streaming the entire database.
    pageSize: 5000,
  };

  const leads = await asUser(user.id, (tx) => listLeads(tx, filters));

  const csv = toCsv(
    [
      'club_name',
      'city',
      'state',
      'territory',
      'sport',
      'source',
      'status',
      'primary_email',
      'primary_phone',
      'phone_verified',
      'contacts',
      'assigned_to',
      'next_follow_up',
      'last_activity',
      'suppressed',
    ],
    leads.rows.map((l) => {
      const phone = analysePhone(l.primaryPhoneRaw);
      return [
        l.name,
        l.city ?? '',
        l.state ?? '',
        l.territoryCode ?? '',
        l.sport ?? '',
        l.source ?? '',
        l.status,
        l.primaryEmail ?? '',
        phone.raw ? formatPhone(phone) : '',
        phone.valid ? 'yes' : 'no',
        l.contactCount,
        l.assigneeName ?? '',
        l.nextFollowUpOn ?? '',
        l.lastActivityAt?.toISOString() ?? '',
        l.isSuppressed ? 'yes' : 'no',
      ];
    }),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('waresport-leads')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
