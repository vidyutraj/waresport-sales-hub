'use client';

import { signOutAction } from '@/app/actions';
import { useFormStatus } from 'react-dom';

function Button({ className }: { className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/**
 * Sign-out is a form POST, never a link: a GET sign-out can be fired by link
 * prefetching or by a cross-site image tag.
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction} className="contents">
      <Button className={className} />
    </form>
  );
}
