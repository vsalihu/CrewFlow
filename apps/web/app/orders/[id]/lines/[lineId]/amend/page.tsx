import Link from 'next/link';
import { getOrderDetail, lineFieldsFromRow, previewAmendment } from '@cds/domain';
import { isDomainError } from '@cds/contracts';
import { Button, Empty, Field, Flash, Panel, inputClass, textareaClass } from '@/components/ui';
import { requireContext } from '@/lib/session';
import { amendLineAction, prepareAmendmentAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

const FIELDS = [
  ['serviceDate', 'Work date', 'date'],
  ['arrivalLocal', 'Arrive by', 'time'],
  ['startLocal', 'Paid start', 'time'],
  ['endLocal', 'Expected end', 'time'],
  ['requestedCount', 'Requested', 'number'],
  ['minimumCount', 'Minimum', 'number'],
  ['role', 'Role', 'text'],
  ['requiredSkill', 'Required skill', 'text'],
  ['teamLabel', 'Team / supervisor', 'text'],
  ['notes', 'Notes', 'text'],
] as const;

export default async function AmendPage({ params, searchParams }: { params: Promise<{ id: string; lineId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const { id, lineId } = await params;
  const sp = await searchParams;
  const d = await getOrderDetail(ctx, id);
  const line = d.lines.find((x) => x.l.id === lineId);
  if (!line) return <Empty>Line not found.</Empty>;
  const current = lineFieldsFromRow(line.l);

  // Step 2: a source has been captured and changes proposed; show the impact before saving.
  let preview: Awaited<ReturnType<typeof previewAmendment>> | null = null;
  let previewError: string | null = null;
  let change: Record<string, unknown> | null = null;
  if (sp.src && sp.change) {
    change = JSON.parse(sp.change) as Record<string, unknown>;
    try {
      preview = await previewAmendment(ctx, id, { expectedVersion: d.order.version, sourceMessageIds: [sp.src], reason: sp.reason ?? 'Amendment', lineChanges: [{ lineId, ...change }] });
    } catch (e) {
      if (!isDomainError(e)) throw e;
      previewError = e.message + ' ' + Object.values(e.fieldErrors).flat().join(' ');
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/orders/${id}`} className="text-sm text-accent hover:underline">
          ← {d.order.reference}
        </Link>
        <h1 className="text-lg font-semibold">Amend line {line.l.lineNo}</h1>
      </div>
      <Flash error={sp.error ?? previewError ?? undefined} notice={sp.notice} />
      {preview && change ? (
        <Panel title="Impact of this change">
          <div className="flex flex-col gap-3 text-sm">
            <ul className="list-disc pl-5">
              {preview.changes.map((c, i) => (
                <li key={i}>
                  {c.field}: {String(c.from ?? 'none')} → {String(c.to ?? 'none')}
                </li>
              ))}
            </ul>
            <ul className="flex flex-col gap-1 rounded-[var(--radius-ui)] bg-warn-bg p-3 text-warn">
              <li>{preview.reconfirmations.length} confirmed worker(s) must reconfirm{preview.reconfirmations.length ? `: ${preview.reconfirmations.map((r) => r.workerName).join(', ')}` : ''}.</li>
              <li>{preview.staleOffers.length} outstanding offer(s) must be re-sent.</li>
              <li>{preview.pendingMessagesToSupersede} unsent message(s) will be withdrawn; {preview.sentMessagesNeedingAmendment} sent message(s) need an amendment.</li>
              <li>{preview.tripsAffected.length} journey(s) affected{preview.tripsAffected.length ? `: ${preview.tripsAffected.map((t) => t.reference).join(', ')}` : ''}.</li>
              <li>{preview.externalBookingsToUpdate} JoinedUp booking(s) to update.</li>
              {preview.excessAssignments.map((e) => (
                <li key={e.lineId}>
                  {e.active} assigned but only {e.accepted} accepted: you will need to release people.
                </li>
              ))}
            </ul>
            <form action={amendLineAction} className="flex gap-2">
              <input type="hidden" name="orderId" value={id} />
              <input type="hidden" name="lineId" value={lineId} />
              <input type="hidden" name="version" value={preview.version} />
              <input type="hidden" name="sourceMessageId" value={sp.src} />
              <input type="hidden" name="reason" value={sp.reason ?? 'Amendment'} />
              <input type="hidden" name="change" value={JSON.stringify(change)} />
              <input type="hidden" name="token" value={preview.token} />
              <Button variant="primary" type="submit">
                Save Revision
              </Button>
              <Link href={`/orders/${id}/lines/${lineId}/amend`} className="inline-flex h-8 items-center px-3 text-sm text-ink-muted hover:underline">
                Start Again
              </Link>
            </form>
          </div>
        </Panel>
      ) : (
        <form action={prepareAmendmentAction} className="flex flex-col gap-4">
          <input type="hidden" name="orderId" value={id} />
          <input type="hidden" name="lineId" value={lineId} />
          <input type="hidden" name="branchId" value={d.order.branchId} />
          <Panel title="What asked for the change">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Linked source" htmlFor="sourceId" hint="Pick an existing message, or paste the new one below.">
                <select id="sourceId" name="sourceId" className={inputClass}>
                  <option value="">Paste a new message</option>
                  {d.sources.map(({ s }) => (
                    <option key={s.id} value={s.id}>
                      {s.rawText.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="reason">
                <input id="reason" name="reason" required placeholder="e.g. Client moved the start to 08:00…" className={inputClass} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="New message or call note (exactly as received)" htmlFor="rawText">
                <textarea id="rawText" name="rawText" rows={4} className={`${textareaClass} font-mono`} />
              </Field>
            </div>
          </Panel>
          <Panel title="Changes (leave a field as it is to keep it)">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {FIELDS.map(([k, labelText, type]) => (
                <Field key={k} label={labelText} htmlFor={k}>
                  <input id={k} name={k} type={type} defaultValue={String((current as Record<string, unknown>)[k] ?? '')} className={inputClass} />
                </Field>
              ))}
            </div>
          </Panel>
          <Button variant="primary" type="submit" className="self-start">
            Preview Impact
          </Button>
        </form>
      )}
    </div>
  );
}
