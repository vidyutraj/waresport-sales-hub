import { redirect } from 'next/navigation';

/**
 * Invitation emails link here. There is no separate verification screen: the
 * sign-in page already handles "request a code, then enter it", and pre-filling
 * the address keeps the invited user on a single, familiar flow.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  redirect(email ? `/sign-in?email=${encodeURIComponent(email)}` : '/sign-in');
}
