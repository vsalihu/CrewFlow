import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { can } from '@cds/auth';
import { currentActor } from '@/lib/session';
import { env } from '@/lib/env';
import { signOut } from './actions';

export const metadata: Metadata = { title: 'CDS Operations', description: 'Orders, staffing, transport and confirmations' };
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1011' },
  ],
};

const NAV = [
  { href: '/operations', label: 'Operations' },
  { href: '/orders/new', label: 'New Order' },
  { href: '/transport', label: 'Transport' },
  { href: '/joinedup', label: 'JoinedUp Queue' },
  { href: '/attendance', label: 'Attendance', capability: 'attendance.record' as const },
  { href: '/attendance/rules', label: 'Break Rules', capability: 'policy.manage' as const },
  { href: '/exports', label: 'Payroll Exports', capability: 'payroll.export' as const },
  { href: '/workers', label: 'Workers' },
  { href: '/handover', label: 'Handover' },
  { href: '/integrations', label: 'Integrations' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  const appEnv = env().APP_ENV;
  return (
    <html lang="en-GB">
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-hairline bg-surface">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 lg:h-12 lg:flex-nowrap lg:py-0">
            <Link href="/operations" className="shrink-0 text-sm font-semibold tracking-tight" translate="no">
              CDS Operations
            </Link>
            {actor ? (
              <nav aria-label="Main" className="order-last -mx-2 flex w-full min-w-0 items-center gap-1 overflow-x-auto lg:order-none lg:mx-0 lg:w-auto">
                {NAV.filter((n) => !('capability' in n) || can(actor, n.capability!)).map((n) => (
                  <Link key={n.href} href={n.href} className="whitespace-nowrap rounded px-2 py-1 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                    {n.label}
                  </Link>
                ))}
              </nav>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-ink-subtle">
              {appEnv !== 'production' ? (
                <span className="rounded bg-warn-bg px-1.5 py-0.5 font-medium text-warn">
                  {appEnv}
                  <span className="hidden sm:inline">: synthetic data only</span>
                </span>
              ) : null}
              {actor ? (
                <form action={signOut} className="flex items-center gap-2">
                  <span className="hidden text-ink-muted sm:inline">{actor.displayName}</span>
                  <button className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-ink">Sign Out</button>
                </form>
              ) : null}
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-[1500px] px-4 py-5">
          {children}
        </main>
      </body>
    </html>
  );
}
