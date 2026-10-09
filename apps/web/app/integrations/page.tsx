import { integrationStatus } from '@cds/domain';
import { INTEGRATIONS } from '@cds/integrations';
import { Badge, Panel } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { requireContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

const tone = { connected: 'ok', sandbox: 'info', manual: 'warn', disabled: 'neutral', degraded: 'bad', blocked: 'bad' } as const;

/** Honest integration status: what works, what is manual, and what is not connected. */
export default async function IntegrationsPage() {
  const ctx = await requireContext();
  const settings = await integrationStatus(ctx);
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Integrations</h1>
      <p className="text-sm text-ink-muted">
        Nothing here is simulated. A copied message is not a sent message, and an exported booking is not a confirmed JoinedUp booking. Every workflow works with these integrations off.
      </p>
      {INTEGRATIONS.map((i) => {
        const s = settings.find((x) => x.provider === i.provider);
        const status = (s?.status ?? i.status) as keyof typeof tone;
        return (
          <Panel key={i.provider} title={i.label} actions={<Badge tone={tone[status]}>{status}</Badge>}>
            <div className="flex flex-col gap-3 text-sm">
              {s?.note ? <p className="text-ink-muted">{s.note}</p> : null}
              <ul className="flex flex-col gap-1">
                {i.capabilities.map((c) => (
                  <li key={c.name} className="flex items-start gap-2">
                    <Badge tone={c.available ? 'ok' : 'neutral'}>{c.available ? 'available' : 'not available'}</Badge>
                    <span>
                      <span className="font-medium">{c.name}.</span> {c.note}
                    </span>
                  </li>
                ))}
              </ul>
              <p>
                <span className="font-medium">Manual route:</span> {i.manualFallback}
              </p>
              <p className="text-xs text-ink-subtle">Open questions: {i.openQuestions.join(' · ')}</p>
              {s?.lastSyncAt || s?.lastError ? (
                <p className="text-xs text-ink-subtle">
                  Last sync {fmtDateTime(s.lastSyncAt)} {s.lastError ? `· last error: ${s.lastError}` : ''}
                </p>
              ) : null}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
