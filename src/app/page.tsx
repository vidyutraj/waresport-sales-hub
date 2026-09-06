import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';

/** The root sends everyone to the right place for their role and state. */
export default async function Home() {
  const user = await currentUser();
  if (!user) redirect('/sign-in');
  if (user.onboardingCompletedAt === null) redirect('/onboarding');
  redirect(user.role === 'intern' ? '/overview' : '/admin');
}
