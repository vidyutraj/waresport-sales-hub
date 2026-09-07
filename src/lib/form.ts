import { z } from 'zod';

/**
 * Shared server-action result shape.
 *
 * Server actions always return one of these instead of throwing, so a client
 * form can render a field-level error, a form-level error, or a success
 * message without a boundary. Authorization failures are converted here too,
 * which keeps "permission denied" a normal, styled state rather than a crash.
 */
export type FormState = {
  status: 'idle' | 'success' | 'error';
  message: string | null;
  /** Field name -> first error message. */
  fieldErrors: Record<string, string>;
  /**
   * The values the user submitted, echoed back on failure.
   *
   * React resets an uncontrolled form once its action completes, so without
   * this a validation error would silently wipe everything the user typed.
   * Forms read `state.values?.field` as their `defaultValue`.
   */
  values?: Record<string, string>;
  /** Optional payload for the client (e.g. a created record's id). */
  data?: Record<string, string | number | boolean | null> | null;
};

export const IDLE: FormState = { status: 'idle', message: null, fieldErrors: {} };

export function ok(message: string, data?: FormState['data']): FormState {
  return { status: 'success', message, fieldErrors: {}, data: data ?? null };
}

export function fail(
  message: string,
  fieldErrors: Record<string, string> = {},
  values?: Record<string, string>,
): FormState {
  return { status: 'error', message, fieldErrors, values };
}

export function fromZodError(error: z.ZodError, values?: Record<string, string>): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    fieldErrors[key] ??= issue.message;
  }
  return {
    status: 'error',
    message: 'Fix the highlighted fields and try again.',
    fieldErrors,
    values,
  };
}

/** Flatten FormData into plain strings, for echoing back on failure. */
export function formValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    // Only the first occurrence: repeated keys are checkbox groups, which the
    // forms re-derive rather than restore from a single string.
    values[key] ??= String(value);
  }
  return values;
}

/** Parse a FormData payload, returning a FormState on failure. */
export function parseForm<T extends z.ZodType>(
  schema: T,
  formData: FormData,
):
  { ok: true; data: z.infer<T>; values: Record<string, string> } | { ok: false; state: FormState } {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    // Repeated keys (checkbox groups, multi-selects) collapse into an array.
    if (key in raw) {
      const existing = raw[key];
      raw[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      raw[key] = value;
    }
  }
  const values = formValues(formData);
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, data: parsed.data, values }
    : { ok: false, state: fromZodError(parsed.error, values) };
}

/** Empty string -> undefined, so optional text fields do not fail validation. */
export const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const requiredText = (message: string) => z.string().trim().min(1, message);

export const checkboxValue = z
  .union([z.literal('on'), z.literal('true'), z.literal('1'), z.string(), z.undefined()])
  .transform((v) => v === 'on' || v === 'true' || v === '1');

/** Convert a thrown domain/authorization error into a FormState. */
export function toFormState(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): FormState {
  if (error instanceof Error) {
    // Never surface a raw database message to a user.
    const isKnownDomainError = [
      'AuthorizationError',
      'AssignmentError',
      'OutreachError',
      'MeetingError',
      'PayoutError',
      'ProspectError',
      'AdminError',
      'UserCreationError',
      'WeakPasswordError',
      'ImportError',
    ].includes(error.name);
    if (isKnownDomainError) return fail(error.message);
  }
  return fail(fallback);
}
