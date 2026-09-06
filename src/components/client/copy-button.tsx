'use client';

import { useState } from 'react';

/**
 * Copy a value to the clipboard.
 *
 * Copying an address is explicitly NOT outreach: nothing is logged here, and
 * the button says so in its accessible label so nobody assumes otherwise.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard access can be denied; the value is visible either way.
          setCopied(false);
        }
      }}
      aria-label={`${label} (copying does not log outreach)`}
      className="rounded border border-ink-200 px-1.5 py-0.5 text-[11px] font-medium text-ink-600 hover:bg-ink-50"
    >
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
