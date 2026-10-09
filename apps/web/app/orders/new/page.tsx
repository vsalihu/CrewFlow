import { operationalDates, referenceData } from '@cds/domain';
import { LineEditor } from '@/components/LineEditor';
import { Button, Field, Flash, Panel, inputClass, textareaClass } from '@/components/ui';
import { requireContext } from '@/lib/session';
import { createOrderFromSource } from '../../actions';

export const dynamic = 'force-dynamic';

function nowLocalInput(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const { tomorrow } = operationalDates(new Date());
  return (
    <form action={createOrderFromSource} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">New Order</h1>
        <p className="text-sm text-ink-subtle">Saving records the request. It does not accept it or promise staff.</p>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <Panel title="Original request">
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 text-xs font-medium text-ink-muted">How it arrived</legend>
              {[
                ['pasted_message', 'Pasted message'],
                ['phone_note', 'Phone call (staff note)'],
                ['email', 'Email (pasted)'],
              ].map(([v, l], i) => (
                <label key={v} className="flex items-center gap-1.5">
                  <input type="radio" name="kind" value={v} defaultChecked={i === 0} />
                  {l}
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Branch" htmlFor="branchId">
                <select id="branchId" name="branchId" className={inputClass} required>
                  {ref.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Received at (UK time)" htmlFor="receivedAt" hint="When the client sent it or called.">
                <input id="receivedAt" name="receivedAt" type="datetime-local" required defaultValue={nowLocalInput()} className={inputClass} />
              </Field>
              <Field label="Sender" htmlFor="senderLabel">
                <input id="senderLabel" name="senderLabel" autoComplete="off" placeholder="e.g. supervisor name…" className={inputClass} />
              </Field>
              <Field label="Caller (phone notes)" htmlFor="callerName">
                <input id="callerName" name="callerName" autoComplete="off" className={inputClass} />
              </Field>
            </div>
            <Field label="Message or call notes, exactly as received" htmlFor="rawText" hint="Kept unchanged as evidence. Do not tidy it up.">
              <textarea id="rawText" name="rawText" required rows={12} className={`${textareaClass} font-mono`} placeholder="Paste the WhatsApp message or email here…" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="needsClarification" value="1" /> Needs clarification before we can act
            </label>
          </div>
        </Panel>
        <Panel title="Shift lines">
          <LineEditor
            clients={ref.clients.map((c) => ({ id: c.id, name: c.displayName }))}
            sites={ref.sites.map((s) => ({ id: s.id, name: s.canonicalName, clientId: s.clientId }))}
            locations={ref.locations.map((l) => ({ id: l.id, name: l.name, siteId: l.siteId, verified: !!l.verifiedAt }))}
            defaultDate={tomorrow}
          />
        </Panel>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" type="submit">
          Save Request
        </Button>
      </div>
    </form>
  );
}
