'use client';

import { useState } from 'react';
import { markCopiedAction } from '@/app/actions';

/** Copies the message text. Copying is recorded, but it is not sending. */
export function CopyButton({ draftId, text, disabled }: { draftId: string; text: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            const r = await markCopiedAction(draftId);
            if (!r.ok) {
              setState('error');
              setError(r.error ?? null);
            } else setState('copied');
          } catch {
            setState('error');
            setError('Clipboard access was blocked. Select the text and copy it manually.');
          }
        }}
        className="inline-flex h-8 items-center rounded-[var(--radius-ui)] border border-transparent bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
      >
        Copy Message
      </button>
      <span aria-live="polite" className={`text-xs ${state === 'error' ? 'text-bad' : 'text-ink-subtle'}`}>
        {state === 'copied' ? 'Copied. Now send it, then record it below.' : state === 'error' ? error : ''}
      </span>
    </div>
  );
}
