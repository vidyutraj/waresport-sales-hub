'use client';

import { useActionState, useState } from 'react';
import { setActiveAction, setRoleAction } from '@/app/admin/actions';
import { ActionButton, SubmitButton } from '@/components/client/form';
import { Input, Select, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

/**
 * Per-person controls. Role changes are owner-only and always require a reason,
 * which is recorded in the audit trail.
 */
export function PersonActions({
  userId,
  active,
  role,
  canChangeRole,
}: {
  userId: string;
  active: boolean;
  role: 'intern' | 'admin';
  canChangeRole: boolean;
}) {
  const [roleState, roleDispatch] = useActionState(setRoleAction, IDLE);
  const [editingRole, setEditingRole] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <ActionButton
          action={setActiveAction}
          fields={{ userId, active: active ? 'false' : 'true' }}
          variant={active ? 'danger' : 'secondary'}
          confirm={
            active
              ? 'Deactivate this account? Their sessions end immediately; past work stays attributed to them.'
              : undefined
          }
          pendingLabel="Saving…"
        >
          {active ? 'Deactivate' : 'Reactivate'}
        </ActionButton>

        {canChangeRole ? (
          <button
            type="button"
            onClick={() => setEditingRole((v) => !v)}
            className={buttonClass('ghost', 'sm')}
            aria-expanded={editingRole}
          >
            Change role
          </button>
        ) : null}
      </div>

      {editingRole ? (
        <form action={roleDispatch} className="flex flex-col gap-1.5">
          <input type="hidden" name="userId" value={userId} />
          <label htmlFor={`role-${userId}`} className="sr-only">
            New role
          </label>
          <Select
            id={`role-${userId}`}
            name="role"
            defaultValue={role === 'admin' ? 'intern' : 'admin'}
            className="h-8 w-auto text-[13px]"
          >
            <option value="intern">Intern</option>
            <option value="admin">Admin</option>
          </Select>
          <Input
            name="reason"
            required
            minLength={3}
            maxLength={300}
            placeholder="Reason (recorded in the audit log)"
            className="h-8 text-[13px]"
            aria-label="Reason for the role change"
          />
          {roleState.status === 'error' && roleState.message ? (
            <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
              {roleState.message}
            </p>
          ) : null}
          <div className="flex gap-1.5">
            <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
              Apply
            </SubmitButton>
            <button
              type="button"
              onClick={() => setEditingRole(false)}
              className={buttonClass('ghost', 'sm')}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
