import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { findSignInChoice, listSignInChoices } from '@/lib/auth/service';
import { signInAsAction } from './actions';
import { PasswordGateForm } from '@/components/client/password-gate-form';
import { Alert, Badge, WaresportMark } from '@/components/ui';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col bg-ink-900">
      <div className="px-5 py-4">
        <WaresportMark />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        <div className="w-full max-w-md rounded-[--radius-card] bg-white p-6 shadow-lg">
          {children}
        </div>
      </div>
    </main>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; user?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const { error, user } = await searchParams;

  // ---- Password step, for an admin or owner ------------------------------
  if (user) {
    const choice = await findSignInChoice(user);
    if (choice === null || !choice.requiresPassword) redirect('/sign-in');

    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink-900">{choice.name}</h1>
        <p className="mt-1 mb-5 text-[13px] text-ink-600">
          {choice.role === 'intern'
            ? 'This profile is password-protected.'
            : 'Admin access needs a password.'}
        </p>
        <PasswordGateForm userId={choice.id} name={choice.name} />
        <p className="mt-5 border-t border-ink-100 pt-4 text-[12px] text-ink-500">
          <Link href="/sign-in" className="text-brand-600 underline">
            Back to profiles
          </Link>
        </p>
      </Shell>
    );
  }

  // ---- The picker --------------------------------------------------------
  const choices = await listSignInChoices();

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink-900">Who are you?</h1>
      <p className="mt-1 mb-5 text-[13px] text-ink-600">
        Pick your name to open the business development workspace.
      </p>

      {error ? (
        <Alert tone="caution" className="mb-4" title="Could not sign you in">
          {error}
        </Alert>
      ) : null}

      {choices.length === 0 ? (
        <Alert tone="info" title="No profiles yet">
          Nobody has been set up in this workspace yet. Whoever administers it creates the first
          profile on the server.
        </Alert>
      ) : (
        <ul className="flex flex-col gap-2">
          {choices.map((choice) => (
            <li key={choice.id}>
              <form action={signInAsAction}>
                <input type="hidden" name="userId" value={choice.id} />
                <button
                  type="submit"
                  disabled={choice.passwordMissing}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2.5 text-left hover:border-brand-500 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-ink-200 disabled:hover:bg-transparent"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium text-ink-900">
                      {choice.name}
                    </span>
                    <span className="block truncate text-[12px] text-ink-500">
                      {choice.passwordMissing
                        ? 'No password set yet — ask an administrator'
                        : choice.email}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {choice.requiresPassword ? <Badge tone="caution">password</Badge> : null}
                    <Badge tone={choice.role === 'intern' ? 'neutral' : 'brand'}>
                      {choice.role}
                    </Badge>
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 border-t border-ink-100 pt-4 text-[12px] leading-relaxed text-ink-500">
        Interns sign in by picking their name — this is an internal workspace on a trusted network,
        so there is no password for them. Admin and owner accounts always need one. Profiles are
        created from the server; if yours is missing, ask an admin to add it.
      </p>
    </Shell>
  );
}
