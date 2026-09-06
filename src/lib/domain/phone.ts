/**
 * Phone handling.
 *
 * The supplied lead file has a value in every phone column, but a populated
 * field is not the same as a reachable number. Phones are therefore always
 * preserved as the original text (extensions, leading zeros, punctuation) and
 * normalisation is stored *alongside* the raw value, never instead of it.
 */

export type PhoneAnalysis = {
  raw: string | null;
  digits: string | null;
  e164: string | null;
  extension: string | null;
  valid: boolean;
  warning: string | null;
};

const EXTENSION_RE = /(?:\b(?:ext|extension|x)\b\.?|#)\s*([0-9]{1,6})\s*$/i;
const PLACEHOLDER_DIGITS = new Set([
  '0000000000',
  '1111111111',
  '1234567890',
  '9999999999',
  '5555555555',
  '0000000',
  '1234567',
]);

export function analysePhone(input: string | null | undefined): PhoneAnalysis {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return { raw: null, digits: null, e164: null, extension: null, valid: false, warning: null };
  }

  let body = raw;
  let extension: string | null = null;
  const extMatch = EXTENSION_RE.exec(body);
  if (extMatch?.[1]) {
    extension = extMatch[1];
    body = body.slice(0, extMatch.index).trim();
  }

  const digits = body.replace(/\D/g, '');
  const base: PhoneAnalysis = {
    raw,
    digits: digits === '' ? null : digits,
    e164: null,
    extension,
    valid: false,
    warning: null,
  };

  if (digits === '') return { ...base, warning: 'Phone value contains no digits.' };
  if (PLACEHOLDER_DIGITS.has(digits) || /^(\d)\1+$/.test(digits)) {
    return { ...base, warning: 'Phone looks like a placeholder value.' };
  }

  // North American Numbering Plan validation. Anything else is preserved but
  // flagged rather than discarded — the record still has research value.
  let nanp: string | null = null;
  if (digits.length === 10) nanp = digits;
  else if (digits.length === 11 && digits.startsWith('1')) nanp = digits.slice(1);

  if (nanp) {
    const area = nanp.slice(0, 3);
    const exchange = nanp.slice(3, 6);
    const areaOk = /^[2-9][0-9]{2}$/.test(area) && !/^\d11$/.test(area);
    const exchangeOk = /^[2-9][0-9]{2}$/.test(exchange);
    if (areaOk && exchangeOk) {
      return { ...base, e164: `+1${nanp}`, valid: true };
    }
    return { ...base, warning: 'Phone is not a valid North American number.' };
  }

  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return { ...base, e164: `+${digits}`, valid: true };
  }

  return {
    ...base,
    warning:
      digits.length < 10
        ? 'Phone has too few digits to dial.'
        : 'Phone could not be normalised; stored as written.',
  };
}

/** Display form: pretty for valid NANP numbers, verbatim otherwise. */
export function formatPhone(analysis: PhoneAnalysis): string {
  if (!analysis.raw) return 'Not available';
  if (analysis.valid && analysis.e164?.startsWith('+1') && analysis.e164.length === 12) {
    const d = analysis.e164.slice(2);
    const pretty = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return analysis.extension ? `${pretty} ext. ${analysis.extension}` : pretty;
  }
  return analysis.raw;
}

/** `tel:` href, or null when there is nothing safely dialable. */
export function telHref(analysis: PhoneAnalysis): string | null {
  if (!analysis.valid || !analysis.e164) return null;
  return analysis.extension
    ? `tel:${analysis.e164};ext=${analysis.extension}`
    : `tel:${analysis.e164}`;
}
