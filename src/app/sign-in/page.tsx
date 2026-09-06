import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { SignInForm } from '@/components/client/sign-in-form';
import { WaresportMark } from '@/components/ui';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const { email } = await searchParams;

  return (
    <main id="main" className="flex min-h-dvh flex-col bg-ink-900">
      <div className="px-5 py-4">
        <WaresportMark />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        <div className="w-full max-w-sm rounded-[--radius-card] bg-white p-6 shadow-lg">
          <h1 className="text-lg font-semibold text-ink-900">Sign in</h1>
          <p className="mt-1 mb-5 text-[13px] text-ink-600">
            Business development internship workspace. Access is invitation-only.
          </p>
          <SignInForm initialEmail={email} />
          <p className="mt-5 border-t border-ink-100 pt-4 text-[12px] leading-relaxed text-ink-500">
            There is no password. We email a one-time code to verify it is you. If you were not
            invited, an account cannot be created here.
          </p>
        </div>
      </div>
    </main>
  );
}
