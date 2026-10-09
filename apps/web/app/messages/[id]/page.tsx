import Link from 'next/link';
import { getDraft } from '@cds/domain';
import { CopyButton } from '@/components/CopyButton';
import { StateBadge } from '@/components/Status';
import { Button, Field, Flash, Panel, inputClass } from '@/components/ui';
import { fmtDateTime, label, titleCase } from '@/lib/format';
import { orNotFound, requireContext } from '@/lib/session';
import { acknowledgeMessageAction, markSentAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function MessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireContext();
  const { id } = await params;
  const sp = await searchParams;
  const back = sp.back && sp.back.startsWith('/') ? sp.back : '/operations';
  const { draft: d, recipientName, contactStillCurrent } = await orNotFound(getDraft(ctx, id));
  const sendable = (d.state === 'draft' || d.state === 'copied') && contactStillCurrent;
  const sent = ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown'].includes(d.state);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Link href={back} className="text-sm text-accent hover:underline">
        ← Back
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{titleCase(d.template)}</h1>
        <StateBadge state={d.state} />
        <span className="text-sm text-ink-muted">
          To {recipientName} · <span className="font-mono num">{d.contactValue}</span> · describes{' '}
          {d.entityType === 'trip' ? 'journey revision' : 'shift version'} {d.entityRevision} · template v{d.templateVersion}
        </span>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      {!contactStillCurrent ? <Flash error="The recipient's contact details changed after this draft was made. Create a new draft." /> : null}
      {d.endReason ? <Flash error={`This message was ${label(d.state)}: ${d.endReason}. Do not send it.`} /> : null}
      <Panel title="Message">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm">{d.content}</pre>
      </Panel>
      {sendable ? (
        <Panel title="Send it yourself, then record it">
          <div className="flex flex-col gap-4">
            <CopyButton draftId={d.id} text={d.content} />
            <form action={markSentAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="draftId" value={d.id} />
              <input type="hidden" name="version" value={d.version} />
              <input type="hidden" name="back" value={back} />
              <Field label="How did you send it?" htmlFor="channel">
                <select id="channel" name="channel" className={inputClass}>
                  <option value="whatsapp_manual">WhatsApp (sent by me)</option>
                  <option value="sms_manual">SMS (sent by me)</option>
                  <option value="phone">Read out on a call</option>
                  <option value="email">Email</option>
                </select>
              </Field>
              <Button variant="primary" type="submit">
                I Have Sent It
              </Button>
            </form>
            <p className="text-xs text-ink-subtle">Recording a send is not the same as delivery or agreement. Record the reply separately when it comes.</p>
          </div>
        </Panel>
      ) : null}
      {sent ? (
        <Panel title="Acknowledgement">
          <p className="mb-3 text-sm text-ink-muted">
            Sent {fmtDateTime(d.sentAt)} by {label(d.sentChannel ?? '')}. Record the recipient&apos;s acknowledgement of this exact message.
          </p>
          <form action={acknowledgeMessageAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="draftId" value={d.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="What they said" htmlFor="note">
              <input id="note" name="note" required placeholder="e.g. Replied OK at 06:40…" className={inputClass} />
            </Field>
            <Button type="submit">Record Acknowledgement</Button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
