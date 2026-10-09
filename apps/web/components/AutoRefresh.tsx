'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Re-fetches the server-rendered board every 15 seconds while the tab is visible and shows
 * when it last refreshed. Writes are protected by version checks regardless of polling.
 */
export function AutoRefresh({ generatedAt }: { generatedAt: string }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible' && navigator.onLine) router.refresh();
    }, 15_000);
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    const on = () => setOffline(!navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    on();
    return () => {
      clearInterval(tick);
      clearInterval(clock);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [router]);
  const age = Math.max(0, Math.round((now - new Date(generatedAt).getTime()) / 1000));
  const stale = age > 60;
  return (
    <span aria-live="polite" className={`text-xs ${offline || stale ? 'font-medium text-bad' : 'text-ink-subtle'}`}>
      {offline
        ? 'Offline: this view may be out of date'
        : stale
          ? `Stale: last updated ${age}s ago`
          : `Updated ${new Date(generatedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}`}
    </span>
  );
}
