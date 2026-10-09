import Link from 'next/link';
import { completeTaskAction } from '@/app/actions';
import { Badge, Empty } from './ui';
import { fmtDateTime } from '@/lib/format';

type TaskRow = {
  id: string;
  title: string;
  priority: string;
  type: string;
  dueAt: Date | null;
  coverageAlert: boolean;
  ownerName: string | null;
  entityType: string | null;
  entityId: string | null;
  version: number;
};

function hrefFor(t: TaskRow): string | null {
  if (!t.entityId) return null;
  if (t.entityType === 'order') return `/orders/${t.entityId}`;
  if (t.entityType === 'trip') return `/trips/${t.entityId}`;
  if (t.entityType === 'external_booking') return '/joinedup';
  return null;
}

/** Open tasks with a completion form. Completion requires a written outcome. */
export function TaskList({ tasks, back }: { tasks: TaskRow[]; back: string }) {
  if (!tasks.length) return <Empty>Nothing open. New tasks appear here as work changes.</Empty>;
  return (
    <ul className="flex flex-col divide-y divide-hairline text-sm">
      {tasks.map((t) => {
        const href = hrefFor(t);
        return (
          <li key={t.id} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-start gap-2">
              {t.priority !== 'normal' ? <Badge tone={t.priority === 'urgent' ? 'bad' : 'warn'}>{t.priority}</Badge> : null}
              {t.coverageAlert ? <Badge tone="bad">no one on duty</Badge> : null}
            </div>
            <span className="break-words">
              {href ? (
                <Link href={href} className="hover:underline">
                  {t.title}
                </Link>
              ) : (
                t.title
              )}
            </span>
            <span className="text-xs text-ink-subtle">
              {t.ownerName ?? 'Unowned'}
              {t.dueAt ? ` · due ${fmtDateTime(t.dueAt)}` : ''}
            </span>
            <details>
              <summary className="cursor-pointer text-xs text-accent">Record outcome</summary>
              <form action={completeTaskAction} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="taskId" value={t.id} />
                <input type="hidden" name="version" value={t.version} />
                <input type="hidden" name="back" value={back} />
                <label htmlFor={`outcome-${t.id}`} className="sr-only">
                  Outcome
                </label>
                <textarea
                  id={`outcome-${t.id}`}
                  name="outcome"
                  required
                  minLength={5}
                  rows={2}
                  placeholder="Who you spoke to and what was agreed…"
                  className="w-full rounded-[var(--radius-ui)] border border-hairline-strong bg-surface p-2 text-sm"
                />
                <button className="self-start rounded-[var(--radius-ui)] border border-hairline-strong px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                  Complete Task
                </button>
              </form>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
