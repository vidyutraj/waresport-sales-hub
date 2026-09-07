import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { listSignInChoices } from '@/lib/auth/service';
import { signInAsAction } from './actions';
import { Alert, Badge, WaresportMark } from '@/components/ui';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;
  const choices = await listSignInChoices();

  return (
    <main id="main" className="flex min-h-dvh flex-col bg-ink-900">
      <div className="px-5 py-4">
        <WaresportMark />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        <div className="w-full max-w-md rounded-[--radius-card] bg-white p-6 shadow-lg">
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
              An admin creates profiles from the server with{' '}
              <code className="font-mono text-[12px]">npm run user:create</code>.
            </Alert>
          ) : (
            <ul className="flex flex-col gap-2">
              {choices.map((choice) => (
                <li key={choice.id}>
                  <form action={signInAsAction}>
                    <input type="hidden" name="userId" value={choice.id} />
                    <button
                      type="submit"
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2.5 text-left hover:border-brand-500 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium text-ink-900">
                          {choice.name}
                        </span>
                        <span className="block truncate text-[12px] text-ink-500">
                          {choice.email}
                        </span>
                      </span>
                      <Badge tone={choice.role === 'intern' ? 'neutral' : 'brand'}>
                        {choice.role}
                      </Badge>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-5 border-t border-ink-100 pt-4 text-[12px] leading-relaxed text-ink-500">
            This is an internal workspace on a trusted network, so there is no password. Profiles
            are created from the server; if yours is missing, ask an admin to add it.
          </p>
        </div>
      </div>
    </main>
  );
}
