import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

// Small, owned UI primitives (see DESIGN.md). One radius (6px), one accent, semantic tones
// always paired with a text label so meaning never depends on colour alone.

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const toneClass: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-info',
  neutral: 'bg-surface-2 text-ink-muted',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}>{children}</span>;
}

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' };
const buttonClass = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink hover:bg-surface-2 border-hairline-strong',
  danger: 'bg-surface text-bad hover:bg-bad-bg border-hairline-strong',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-ui)] border px-3 text-sm font-medium transition-colors active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${buttonClass[variant]} ${className}`}
    />
  );
}

export function LinkButton({ href, children, variant = 'secondary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  return (
    <Link href={href} className={`inline-flex h-8 items-center whitespace-nowrap rounded-[var(--radius-ui)] border px-3 text-sm font-medium transition-colors ${buttonClass[variant]}`}>
      {children}
    </Link>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'h-8 w-full min-w-0 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle';
export const textareaClass =
  'w-full min-w-0 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface p-2 text-sm text-ink placeholder:text-ink-subtle';

export function Panel({ title, actions, children, id }: { title?: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="min-w-0 rounded-[var(--radius-ui)] border border-hairline bg-surface">
      {title || actions ? (
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Flash({ error, notice }: { error?: string; notice?: string }) {
  if (!error && !notice) return null;
  return (
    <div role={error ? 'alert' : 'status'} aria-live="polite" className={`rounded-[var(--radius-ui)] px-3 py-2 text-sm ${error ? 'bg-bad-bg text-bad' : 'bg-ok-bg text-ok'}`}>
      {error ?? notice}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-subtle">{children}</p>;
}

export function Stat({ label, value, tone = 'neutral' }: { label: string; value: number | string; tone?: Tone }) {
  const color = tone === 'neutral' ? 'text-ink' : tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-info';
  return (
    <div className="flex min-w-0 flex-col">
      <span className={`num text-lg font-semibold ${color}`}>{value}</span>
      <span className="truncate text-xs text-ink-subtle">{label}</span>
    </div>
  );
}

export const th = 'border-b border-hairline px-3 py-2 text-left text-xs font-medium text-ink-subtle';
export const td = 'border-b border-hairline px-3 py-2 align-top';
