'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col gap-3 pt-16 text-center">
      <h1 className="text-lg font-semibold">Something Went Wrong</h1>
      <p className="text-sm text-ink-muted">
        Nothing was saved by this page. Try again; if it keeps happening, quote reference {error.digest ?? 'unknown'} to support.
      </p>
      <button onClick={reset} className="self-center rounded-[var(--radius-ui)] border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-2">
        Try Again
      </button>
    </div>
  );
}
