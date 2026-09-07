import { NextResponse } from 'next/server';
import { appSql } from '@/lib/db';

/**
 * Liveness and readiness probe.
 *
 * Deliberately says almost nothing: whether the process is up and whether it
 * can reach the database. No version, no build id, no configuration, no error
 * text — an unauthenticated endpoint is not the place to describe the
 * deployment to whoever is scanning it. The detail belongs in the logs.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await appSql()`SELECT 1`;
    return NextResponse.json(
      { status: 'ok' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[health] database unreachable', error);
    return NextResponse.json(
      { status: 'degraded' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
