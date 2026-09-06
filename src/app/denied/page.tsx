import { Alert, buttonClass, LinkButton } from '@/components/ui';
import { SignOutButton } from '@/components/client/sign-out-button';
import { currentUser } from '@/lib/auth/session';

export const metadata = { title: 'Permission denied' };

export default async function DeniedPage() {
  const user = await currentUser();
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-4">
      <Alert tone="danger" title="You do not have permission to view that page">
        <p>
          Your account is signed in as <strong>{user?.email ?? 'an unknown user'}</strong> with the{' '}
          <strong>{user?.role ?? 'unknown'}</strong> role. If you believe this is wrong, ask an
          admin to check your access.
        </p>
      </Alert>
      <div className="flex gap-2">
        <LinkButton href="/" variant="primary">
          Back to your workspace
        </LinkButton>
        <SignOutButton className={buttonClass('secondary')} />
      </div>
    </main>
  );
}
