import { Badge, type Tone } from './ui';
import { label } from '@/lib/format';

const STATE_TONES: Record<string, Tone> = {
  accepted: 'ok',
  arrived: 'ok',
  completed: 'ok',
  confirmed_full: 'ok',
  ready: 'ok',
  published: 'ok',
  verified: 'ok',
  driver_accepted: 'info',
  proposed: 'info',
  offered: 'info',
  partly_confirmed: 'warn',
  partly_proposed: 'warn',
  proposed_full: 'info',
  partially_accepted: 'warn',
  received: 'info',
  needs_clarification: 'warn',
  reconfirmation_required: 'warn',
  unfilled: 'bad',
  unplanned: 'warn',
  over_allocated: 'bad',
  declined: 'bad',
  cancelled: 'neutral',
  disrupted: 'bad',
  draft: 'neutral',
  pending_entry: 'warn',
  entered_unverified: 'warn',
  discrepancy: 'bad',
  failed: 'bad',
  urgent: 'bad',
  late: 'warn',
  high: 'warn',
};

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONES[state] ?? 'neutral'}>{label(state)}</Badge>;
}
