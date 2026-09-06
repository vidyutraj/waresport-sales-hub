/**
 * Deterministic even distribution.
 *
 * Shared by the admin preview (client) and the server action that applies it,
 * so the split an admin approves is exactly the split that happens. Clubs are
 * dealt round-robin in the given order, which puts the remainder on the
 * earliest interns in the list, every time.
 *
 * The server-side copy in src/lib/services/assignment.ts delegates here.
 */
export function planEvenDistribution(
  organizationIds: readonly string[],
  internUserIds: readonly string[],
): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  if (internUserIds.length === 0) return plan;
  for (const internId of internUserIds) plan.set(internId, []);
  organizationIds.forEach((orgId, index) => {
    const internId = internUserIds[index % internUserIds.length]!;
    plan.get(internId)!.push(orgId);
  });
  return plan;
}
