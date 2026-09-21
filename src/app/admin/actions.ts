'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertAdmin, assertOwner } from '@/lib/auth/session';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { createUserAccount } from '@/lib/auth/service';
import {
  assignCohortMembership,
  createCohort,
  listPeople,
  setMetricPolicy,
  setOutreachEmail,
  setTerritoryStates,
  setUserActive,
  setUserRole,
  setWeeklyTarget,
  updateCohort,
} from '@/lib/services/admin';
import { bulkAssign, planEvenDistribution, unassignOrganization } from '@/lib/services/assignment';
import {
  countUnallocatedLeads,
  listUnallocatedLeadIds,
  type LeadFilters,
} from '@/lib/queries/leads';
import {
  changeAttribution,
  recordPayout,
  rejectHeld,
  revertVerification,
  setMeetingOutcome,
  approveBooking,
  declineBooking,
  verifyHeld,
  voidPayout,
} from '@/lib/services/meetings';
import { liftSuppression } from '@/lib/services/outreach';
import { getCohort } from '@/lib/queries/program';
import { cohortRange } from '@/lib/domain/program';
import { isValidTimeZone } from '@/lib/domain/time';
import { normalizeStateCode } from '@/lib/domain/normalize';

/**
 * Administrative server actions.
 *
 * Every one starts with `assertAdmin()` or `assertOwner()`. That check is the
 * application-level gate; the database's RLS policies and triggers reject the
 * same operations independently, so a missing guard here would still not open
 * a hole — see tests/integration/authorization.test.ts, which calls each of
 * these paths as an intern and expects a denial.
 */

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const addPersonSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  fullName: z.string().trim().max(120).optional(),
  role: z.enum(['intern', 'admin']),
  password: z.string().max(200).optional(),
  cohortId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  territoryId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/**
 * Create a profile.
 *
 * There is no invitation and no email: the account exists as soon as this
 * returns, and the person signs in by picking their name on /sign-in. Only the
 * owner can mint another admin.
 */
export async function addPersonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(addPersonSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (input.role === 'admin' && actor.role !== 'owner') {
    return fail('Only the owner can add an admin.');
  }
  // An admin account is useless without one: it cannot sign in at all.
  if (input.role === 'admin' && !input.password?.trim()) {
    return fail('An admin account needs a password.', {
      password: 'Set a password for this admin.',
    });
  }

  try {
    await createUserAccount({
      email: input.email,
      fullName: input.fullName ?? null,
      role: input.role,
      password: input.password?.trim() || null,
      cohortId: input.cohortId ?? null,
      territoryId: input.territoryId ?? null,
      actorUserId: actor.id,
      actorRole: actor.role,
    });
  } catch (error) {
    return toFormState(error, 'Could not create that profile.');
  }

  revalidatePath('/admin/interns');
  revalidatePath('/sign-in');
  return ok(
    input.role === 'admin'
      ? `${input.email} can now sign in with that password.`
      : `${input.email} can now sign in by picking their name.`,
  );
}

const activeSchema = z.object({
  userId: z.string().uuid(),
  active: z.enum(['true', 'false']),
  reason: z.string().trim().max(300).optional(),
});

export async function setActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(activeSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(actor.id, (tx) =>
      setUserActive(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        userId: parsed.data.userId,
        active: parsed.data.active === 'true',
        reason: parsed.data.reason ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not change that account.');
  }

  revalidatePath('/admin/interns');
  return ok(
    parsed.data.active === 'true'
      ? 'Account activated.'
      : 'Account deactivated. Their existing sessions were revoked immediately; historical work stays attributed to them.',
  );
}

const roleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'intern']),
  reason: z.string().trim().min(3, 'Give a reason for the role change.').max(300),
});

/** Owner-only. An admin calling this is rejected here and again by the DB. */
export async function setRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await assertOwner();
  const parsed = parseForm(roleSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(owner.id, (tx) =>
      setUserRole(tx, {
        actorUserId: owner.id,
        userId: parsed.data.userId,
        role: parsed.data.role,
        reason: parsed.data.reason,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not change that role.');
  }

  revalidatePath('/admin/interns');
  revalidatePath('/admin/settings');
  return ok('Role updated.');
}

const membershipSchema = z.object({
  userId: z.string().uuid(),
  cohortId: z.string().uuid(),
  territoryId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  joinedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.'),
  outreachEmail: z.string().trim().optional(),
});

export async function setMembershipAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(membershipSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  try {
    await asUser(actor.id, async (tx) => {
      await assignCohortMembership(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        userId: input.userId,
        cohortId: input.cohortId,
        territoryId: input.territoryId ?? null,
        joinedOn: input.joinedOn,
      });
      if (input.outreachEmail !== undefined) {
        await setOutreachEmail(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          userId: input.userId,
          outreachEmail: input.outreachEmail === '' ? null : input.outreachEmail,
        });
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not update that assignment.');
  }

  revalidatePath('/admin/interns');
  return ok('Assignment updated.');
}

const provisioningSchema = z.object({
  userId: z.string().uuid(),
  outreachEmailProvisioned: z.string().optional(),
  linkedinPremiumStartedOn: z.string().trim().optional(),
  linkedinPremiumExpiresOn: z.string().trim().optional(),
  note: z.string().trim().max(300).optional(),
});

export async function setProvisioningAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(provisioningSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  try {
    await asUser(actor.id, async (tx) => {
      await tx`
        INSERT INTO intern_provisioning
          (user_id, outreach_email_provisioned_at, linkedin_premium_started_on,
           linkedin_premium_expires_on, linkedin_premium_note, updated_by)
        VALUES (${input.userId},
                ${input.outreachEmailProvisioned === 'on' ? new Date() : null},
                ${input.linkedinPremiumStartedOn || null}::date,
                ${input.linkedinPremiumExpiresOn || null}::date,
                ${input.note ?? null}, ${actor.id})
        ON CONFLICT (user_id) DO UPDATE
          SET outreach_email_provisioned_at = EXCLUDED.outreach_email_provisioned_at,
              linkedin_premium_started_on = EXCLUDED.linkedin_premium_started_on,
              linkedin_premium_expires_on = EXCLUDED.linkedin_premium_expires_on,
              linkedin_premium_note = EXCLUDED.linkedin_premium_note,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`;
    });
  } catch (error) {
    return toFormState(error, 'Could not save that checklist.');
  }

  revalidatePath('/admin/interns');
  return ok('Provisioning checklist saved. This records what you set up externally.');
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

const assignSchema = z.object({
  organizationIds: z.union([z.string(), z.array(z.string())]),
  internUserId: z.string().uuid('Choose an intern.'),
  reason: z.string().trim().max(300).optional(),
  territoryOverrideReason: z.string().trim().max(300).optional(),
});

const allocateSchema = z.object({
  internUserId: z.string().uuid('Pick an intern.'),
  count: z.coerce.number().int().min(1, 'Allocate at least one club.').max(500),
  reason: z.string().trim().max(300).optional(),
  territoryOverrideReason: z.string().trim().max(300).optional(),
  // The filters the admin was looking at, so "the next 20" means the next 20
  // of what is on screen.
  q: z.string().trim().max(200).optional(),
  state: z.string().trim().max(2).optional(),
  city: z.string().trim().max(120).optional(),
  sport: z.string().trim().max(60).optional(),
  source: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  territoryId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  contactability: z.enum(['email', 'phone', 'either', 'none']).optional(),
});

/**
 * Allocate the next N unallocated clubs to one intern.
 *
 * This is the "give Carly 20 of these for now" path: the admin says how many
 * and to whom, the server takes that many from the top of the *unallocated*
 * queue for the current filters, and everything else stays unallocated for the
 * next round. Clubs already owned by someone are never touched, so running it
 * twice allocates the next batch rather than reshuffling the first.
 */
export async function allocateBatchAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(allocateSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  const filters: LeadFilters = {
    search: input.q ?? null,
    state: input.state ?? null,
    city: input.city ?? null,
    sport: input.sport ?? null,
    source: input.source ?? null,
    status: input.status ?? null,
    territoryId: input.territoryId ?? null,
    contactability: input.contactability ?? null,
    assignment: 'unassigned',
  };

  try {
    const outcome = await asUser(actor.id, async (tx) => {
      const candidates = await listUnallocatedLeadIds(tx, filters, input.count);
      if (candidates.length === 0) return { empty: true as const };

      const result = await bulkAssign(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        organizationIds: candidates.map((c) => c.id),
        internUserId: input.internUserId,
        reason: input.reason ?? 'Batch allocation',
        territoryOverrideReason: input.territoryOverrideReason ?? null,
      });
      const remaining = await countUnallocatedLeads(tx, filters);
      return { empty: false as const, asked: candidates.length, result, remaining };
    });

    if (outcome.empty) {
      return fail('There are no unallocated clubs matching those filters.');
    }

    revalidatePath('/admin/leads');
    revalidatePath('/leads');

    const { result, remaining, asked } = outcome;
    const left = `${remaining.toLocaleString()} still unallocated${
      remaining > 0 ? ' — allocate them whenever you are ready' : ''
    }.`;

    if (result.failures.length > 0) {
      return {
        status: 'error',
        message:
          `${result.assigned} of ${asked} allocated. ${result.failures.length} could not be: ` +
          `${result.failures[0]?.reason ?? ''} ${left}`,
        fieldErrors: {},
      };
    }
    return ok(`Allocated ${result.assigned} club(s). ${left}`);
  } catch (error) {
    return toFormState(error, 'Could not allocate those clubs.');
  }
}

export async function assignLeadsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(assignSchema, formData);
  if (!parsed.ok) return parsed.state;

  const ids = (
    Array.isArray(parsed.data.organizationIds)
      ? parsed.data.organizationIds
      : [parsed.data.organizationIds]
  ).filter((v) => v !== '');
  if (ids.length === 0) return fail('Select at least one club.');

  try {
    const result = await asUser(actor.id, (tx) =>
      bulkAssign(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        organizationIds: ids,
        internUserId: parsed.data.internUserId,
        reason: parsed.data.reason ?? null,
        territoryOverrideReason: parsed.data.territoryOverrideReason ?? null,
      }),
    );

    revalidatePath('/admin/leads');
    revalidatePath('/leads');

    const parts = [
      `${result.assigned} assigned`,
      `${result.reassigned} reassigned`,
      `${result.unchanged} unchanged`,
    ];
    if (result.failures.length > 0) {
      return {
        status: 'error',
        message: `${parts.join(', ')}. ${result.failures.length} could not be assigned: ${result.failures
          .slice(0, 3)
          .map((f) => f.reason)
          .join(' ')}`,
        fieldErrors: {},
      };
    }
    return ok(`${parts.join(', ')}. Historical contributions are unchanged.`);
  } catch (error) {
    return toFormState(error, 'Could not assign those clubs.');
  }
}

const distributeSchema = z.object({
  organizationIds: z.union([z.string(), z.array(z.string())]),
  internUserIds: z.union([z.string(), z.array(z.string())]),
  reason: z.string().trim().max(300).optional(),
  territoryOverrideReason: z.string().trim().max(300).optional(),
});

/**
 * Even distribution across selected interns.
 *
 * Deterministic: clubs are dealt round-robin in the order given, so the same
 * selection always produces the same allocation and the remainder always falls
 * to the earliest interns in the list.
 */
export async function distributeLeadsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(distributeSchema, formData);
  if (!parsed.ok) return parsed.state;

  const orgIds = (
    Array.isArray(parsed.data.organizationIds)
      ? parsed.data.organizationIds
      : [parsed.data.organizationIds]
  ).filter((v) => v !== '');
  const internIds = (
    Array.isArray(parsed.data.internUserIds)
      ? parsed.data.internUserIds
      : [parsed.data.internUserIds]
  ).filter((v) => v !== '');

  if (orgIds.length === 0) return fail('Select at least one club.');
  if (internIds.length === 0) return fail('Select at least one active intern.');

  const plan = planEvenDistribution(orgIds, internIds);

  try {
    let assigned = 0;
    let reassigned = 0;
    const failures: string[] = [];

    await asUser(actor.id, async (tx) => {
      for (const [internUserId, ids] of plan) {
        const result = await bulkAssign(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          organizationIds: ids,
          internUserId,
          reason: parsed.data.reason ?? 'Even distribution',
          territoryOverrideReason: parsed.data.territoryOverrideReason ?? null,
        });
        assigned += result.assigned;
        reassigned += result.reassigned;
        failures.push(...result.failures.map((f) => f.reason));
      }
    });

    revalidatePath('/admin/leads');
    revalidatePath('/leads');

    const summary = [...plan.entries()].map(([, ids]) => ids.length).join(' / ');
    if (failures.length > 0) {
      return {
        status: 'error',
        message: `${assigned} assigned, ${reassigned} reassigned (split ${summary}). ${failures.length} could not be assigned: ${failures[0]}`,
        fieldErrors: {},
      };
    }
    return ok(`${assigned} assigned, ${reassigned} reassigned. Split across interns: ${summary}.`);
  } catch (error) {
    return toFormState(error, 'Could not distribute those clubs.');
  }
}

export async function unassignAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const organizationId = String(formData.get('organizationId') ?? '');
  const reason = String(formData.get('reason') ?? '') || null;

  try {
    await asUser(actor.id, (tx) =>
      unassignOrganization(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        organizationId,
        reason,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not unassign that club.');
  }

  revalidatePath('/admin/leads');
  revalidatePath('/leads');
  return ok('Club unassigned. Past activity and meeting credit are unchanged.');
}

// ---------------------------------------------------------------------------
// Meetings and payouts
// ---------------------------------------------------------------------------

const meetingActionSchema = z.object({
  meetingId: z.string().uuid(),
  operation: z.enum(['approve', 'decline', 'verify', 'reject', 'revert', 'cancel', 'no_show']),
  reason: z.string().trim().max(300).optional(),
  eligibilityOverrideReason: z.string().trim().max(300).optional(),
});

export async function meetingReviewAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(meetingActionSchema, formData);
  if (!parsed.ok) return parsed.state;
  const { meetingId, operation, reason, eligibilityOverrideReason } = parsed.data;

  if ((operation === 'reject' || operation === 'revert' || operation === 'decline') && !reason) {
    return fail('Give a reason.', { reason: 'A reason is required for this action.' });
  }

  try {
    const outcome = await asUser(actor.id, async (tx) => {
      if (operation === 'approve') {
        await approveBooking(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          meetingId,
        });
        return { overpaymentCents: 0 };
      }
      if (operation === 'decline') {
        await declineBooking(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          meetingId,
          reason: reason!,
        });
        return { overpaymentCents: 0 };
      }
      if (operation === 'verify') {
        await verifyHeld(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          meetingId,
          eligibilityOverrideReason: eligibilityOverrideReason || null,
        });
        return { overpaymentCents: 0 };
      }
      if (operation === 'reject') {
        await rejectHeld(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          meetingId,
          reason: reason!,
        });
        return { overpaymentCents: 0 };
      }
      if (operation === 'revert') {
        const [meeting] = await tx<{ cohort_id: string | null }[]>`
          SELECT cohort_id FROM meetings WHERE id = ${meetingId}`;
        const cohort = meeting?.cohort_id ? await getCohort(tx, meeting.cohort_id) : null;
        const range = cohort ? cohortRange(cohort) : { start: new Date(0), end: new Date(8.64e15) };
        return revertVerification(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          meetingId,
          reason: reason!,
          cohortRange: range,
        });
      }
      await setMeetingOutcome(tx, {
        actorUserId: actor.id,
        meetingId,
        status: operation === 'cancel' ? 'cancelled' : 'no_show',
        reason: reason ?? null,
      });
      return { overpaymentCents: 0 };
    });

    revalidatePath('/admin/meetings');
    revalidatePath('/meetings');
    revalidatePath('/admin');

    if (operation === 'approve') {
      return ok('Approved. It is now scheduled; it counts once it is held and verified.');
    }
    if (operation === 'decline') return ok('Declined. The intern can see your reason.');
    if (operation === 'verify')
      return ok('Verified. The intern’s earned total has been recalculated.');
    if (operation === 'reject') return ok('Returned to the intern with your reason.');
    if (operation === 'revert') {
      return ok(
        outcome.overpaymentCents > 0
          ? `Verification reversed. A payout of $${(outcome.overpaymentCents / 100).toFixed(0)} was already recorded, so a reconciliation entry has been created. The payout record itself is kept.`
          : 'Verification reversed. Earnings recalculated.',
      );
    }
    return ok(operation === 'cancel' ? 'Meeting cancelled.' : 'Meeting marked as a no-show.');
  } catch (error) {
    return toFormState(error, 'Could not update that meeting.');
  }
}

const attributionSchema = z.object({
  meetingId: z.string().uuid(),
  newCreditedUserId: z.string().uuid(),
  reason: z.string().trim().min(3, 'A reason is required.').max(300),
});

export async function changeAttributionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(attributionSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(actor.id, (tx) =>
      changeAttribution(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        meetingId: parsed.data.meetingId,
        newCreditedUserId: parsed.data.newCreditedUserId,
        reason: parsed.data.reason,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not change attribution.');
  }

  revalidatePath('/admin/meetings');
  return ok(
    'Attribution changed. Both interns’ totals have been recalculated and the change is audited.',
  );
}

const payoutSchema = z.object({
  userId: z.string().uuid(),
  cohortId: z.string().uuid(),
  milestoneIndex: z.coerce.number().int().positive(),
  paidOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.'),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(300).optional(),
});

export async function recordPayoutAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(payoutSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  try {
    await asUser(actor.id, async (tx) => {
      const cohort = await getCohort(tx, input.cohortId);
      if (cohort === null) throw new Error('cohort missing');
      await recordPayout(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        userId: input.userId,
        cohortId: input.cohortId,
        cohortRange: cohortRange(cohort),
        milestoneIndex: input.milestoneIndex,
        paidOn: input.paidOn,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not record that payout.');
  }

  revalidatePath('/admin/meetings');
  revalidatePath('/meetings');
  return ok(
    `Milestone ${input.milestoneIndex} recorded as paid. This is a record of a manual payment — no money moved.`,
  );
}

export async function voidPayoutAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const payoutId = String(formData.get('payoutId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  if (reason.trim().length < 3) return fail('Give a reason for voiding this payout.');

  try {
    await asUser(actor.id, (tx) =>
      voidPayout(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        payoutId,
        reason,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not void that payout.');
  }

  revalidatePath('/admin/meetings');
  return ok('Payout voided. The original entry stays in the audit trail.');
}

// ---------------------------------------------------------------------------
// Program configuration
// ---------------------------------------------------------------------------

const cohortSchema = z.object({
  cohortId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  name: z.string().trim().min(2, 'Name the cohort.').max(120),
  startDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.'),
  weeksCount: z.coerce.number().int().min(1).max(52),
  reportingTimezone: z.string().trim().min(1),
  expectedRowVersion: z.coerce.number().int().nonnegative().optional(),
});

export async function saveCohortAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(cohortSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (!isValidTimeZone(input.reportingTimezone)) {
    return fail('Choose a valid IANA timezone.', {
      reportingTimezone: 'Unrecognised timezone.',
    });
  }

  try {
    await asUser(actor.id, async (tx) => {
      if (input.cohortId) {
        await updateCohort(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          cohortId: input.cohortId,
          name: input.name,
          startDate: input.startDate,
          weeksCount: input.weeksCount,
          reportingTimezone: input.reportingTimezone,
          expectedRowVersion: input.expectedRowVersion ?? 0,
        });
      } else {
        await createCohort(tx, {
          actorUserId: actor.id,
          actorRole: actor.role as 'owner' | 'admin',
          name: input.name,
          startDate: input.startDate,
          weeksCount: input.weeksCount,
          reportingTimezone: input.reportingTimezone,
        });
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not save that cohort.');
  }

  revalidatePath('/admin/targets');
  revalidatePath('/admin/settings');
  return ok(input.cohortId ? 'Cohort updated.' : 'Cohort created with the program guide defaults.');
}

const targetSchema = z.object({
  cohortId: z.string().uuid(),
  userId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  weekNumber: z.coerce.number().int().min(1).max(52),
  emailTarget: z.coerce.number().int().min(0).max(100000),
  // LinkedIn has no target. The columns remain, so they are stored as zero.
  linkedinTarget: z.coerce.number().int().min(0).max(100000).default(0),
  emailDailyPace: z.coerce.number().int().min(0).max(100000),
  linkedinDailyPace: z.coerce.number().int().min(0).max(100000).default(0),
  reason: z.string().trim().max(300).optional(),
});

export async function setTargetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(targetSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(actor.id, (tx) =>
      setWeeklyTarget(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        cohortId: parsed.data.cohortId,
        userId: parsed.data.userId ?? null,
        weekNumber: parsed.data.weekNumber,
        emailTarget: parsed.data.emailTarget,
        linkedinTarget: parsed.data.linkedinTarget,
        emailDailyPace: parsed.data.emailDailyPace,
        linkedinDailyPace: parsed.data.linkedinDailyPace,
        reason: parsed.data.reason ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not save that target.');
  }

  revalidatePath('/admin/targets');
  revalidatePath('/overview');
  return ok('Target saved. Weeks that have already ended keep the target they were worked under.');
}

const policySchema = z.object({
  cohortId: z.string().uuid(),
  emailCountsFollowups: z.string().optional(),
  notes: z.string().trim().max(400).optional(),
});

export async function setMetricPolicyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(policySchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(actor.id, (tx) =>
      setMetricPolicy(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        cohortId: parsed.data.cohortId,
        emailCountsFollowups: parsed.data.emailCountsFollowups === 'on',
        // Only applied to the retired request-based LinkedIn count. Kept at its default.
        linkedinCountsFirstRequestOnly: true,
        notes: parsed.data.notes ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not save the metric policy.');
  }

  revalidatePath('/admin/targets');
  return ok(
    'A new policy version was created. It applies from now onward; past weeks keep the rules they were measured under.',
  );
}

const territorySchema = z.object({
  territoryId: z.string().uuid(),
  stateCodes: z.string().trim(),
});

export async function setTerritoryStatesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(territorySchema, formData);
  if (!parsed.ok) return parsed.state;

  const codes = parsed.data.stateCodes
    .split(/[\s,]+/)
    .map((s) => normalizeStateCode(s))
    .filter((s): s is string => s !== null);

  if (codes.length === 0) {
    return fail('Enter at least one valid two-letter state code.', {
      stateCodes: 'No recognisable state codes found.',
    });
  }

  try {
    await asUser(actor.id, (tx) =>
      setTerritoryStates(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        territoryId: parsed.data.territoryId,
        stateCodes: codes,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not save that mapping.');
  }

  revalidatePath('/admin/settings');
  return ok(
    `${codes.length} state${codes.length === 1 ? '' : 's'} mapped. Existing clubs keep their current territory until re-imported or edited.`,
  );
}

export async function liftSuppressionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const suppressionId = String(formData.get('suppressionId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  if (reason.trim().length < 3) return fail('Give a reason for lifting this suppression.');

  try {
    await asUser(actor.id, (tx) =>
      liftSuppression(tx, { actorUserId: actor.id, suppressionId, reason }),
    );
  } catch (error) {
    return toFormState(error, 'Could not lift that suppression.');
  }

  revalidatePath('/admin/leads');
  return ok('Suppression lifted. Outreach to that contact is possible again.');
}

/** Used by the assignment panel to list eligible interns. */
export async function listActiveInterns() {
  const actor = await assertAdmin();
  return asUser(actor.id, (tx) => listPeople(tx, { role: 'intern' }));
}
