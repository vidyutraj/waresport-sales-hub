'use client';

import { resendInviteAction, revokeInviteAction } from '@/app/admin/actions';
import { ActionButton } from '@/components/client/form';

export function InvitationActions({ invitationId }: { invitationId: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <ActionButton action={resendInviteAction} fields={{ invitationId }} pendingLabel="Sending…">
        Resend
      </ActionButton>
      <ActionButton
        action={revokeInviteAction}
        fields={{ invitationId }}
        variant="danger"
        confirm="Revoke this invitation?"
        pendingLabel="Revoking…"
      >
        Revoke
      </ActionButton>
    </div>
  );
}
