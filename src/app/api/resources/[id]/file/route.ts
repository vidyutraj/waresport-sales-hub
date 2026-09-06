import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { asUser } from '@/lib/db';
import { currentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Serve a private resource attachment.
 *
 * Files live outside the web root and are never statically addressable. Access
 * requires a session, and the SELECT below runs through the RLS-enforced
 * connection, so the resource's audience policy decides what the caller may
 * fetch. The stored path is additionally re-checked to be inside the storage
 * directory before anything is read from disk.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });

  const { id } = await params;
  const resource = await asUser(user.id, async (tx) => {
    const [row] = await tx<
      { file_path: string | null; file_name: string | null; file_mime: string | null }[]
    >`SELECT file_path, file_name, file_mime FROM resources WHERE id = ${id}`;
    return row ?? null;
  });

  // RLS returns nothing for a resource this user may not see, so an
  // unauthorised id is indistinguishable from a missing one.
  if (resource === null || resource.file_path === null) {
    return new NextResponse('Not found', { status: 404 });
  }

  // The storage root is deployment-configured, so the bundler cannot trace it
  // statically; the containment check below is what actually keeps this safe.
  const storageRoot = resolve(/* turbopackIgnore: true */ process.cwd(), env().STORAGE_DIR);
  const absolute = resolve(/* turbopackIgnore: true */ storageRoot, resource.file_path);
  // Defence in depth against a path that escapes the storage directory.
  if (!absolute.startsWith(storageRoot + sep)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const body = await readFile(absolute);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': resource.file_mime ?? 'application/octet-stream',
        // `attachment` so a stored HTML/SVG can never execute in our origin.
        'Content-Disposition': `attachment; filename="${(resource.file_name ?? 'resource').replace(/["\\]/g, '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
