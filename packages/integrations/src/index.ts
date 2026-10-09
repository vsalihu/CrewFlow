import type { IntegrationStatus } from '@cds/contracts';

// Integration adapters (build plan §19). Each adapter declares its status and capabilities.
// Nothing here simulates a successful live integration: a disabled or manual adapter
// refuses to send, and the UI shows the manual route instead.

export type Capability = { name: string; available: boolean; note: string };

export type AdapterDescriptor = {
  provider: 'whatsapp' | 'joinedup' | 'email' | 'ai_extraction';
  label: string;
  status: IntegrationStatus;
  capabilities: Capability[];
  manualFallback: string;
  openQuestions: string[];
};

export type SendResult =
  | { kind: 'accepted'; providerMessageId: string }
  /** Timeout or unclear response after a possible send: never blindly resend. */
  | { kind: 'unknown'; detail: string }
  | { kind: 'failed'; retryable: boolean; error: string };

export interface MessagingAdapter {
  readonly provider: 'whatsapp';
  status(): IntegrationStatus;
  send(msg: { draftId: string; to: string; body: string; idempotencyKey: string }): Promise<SendResult>;
}

/** The only production messaging adapter today: sending is done by a person, then recorded. */
export class ManualMessagingAdapter implements MessagingAdapter {
  readonly provider = 'whatsapp' as const;
  status(): IntegrationStatus {
    return 'disabled';
  }
  async send(): Promise<SendResult> {
    return { kind: 'failed', retryable: false, error: 'WhatsApp sending is disabled. Send manually and record it.' };
  }
}

/**
 * Test double for automated tests only. It never runs in production because the worker
 * only constructs it when APP_ENV is "test".
 */
export class SandboxMessagingAdapter implements MessagingAdapter {
  readonly provider = 'whatsapp' as const;
  readonly sent: { draftId: string; to: string; body: string; idempotencyKey: string }[] = [];
  constructor(private readonly behaviour: 'accept' | 'timeout' | 'fail' = 'accept') {}
  status(): IntegrationStatus {
    return 'sandbox';
  }
  async send(msg: { draftId: string; to: string; body: string; idempotencyKey: string }): Promise<SendResult> {
    this.sent.push(msg);
    if (this.behaviour === 'timeout') return { kind: 'unknown', detail: 'Provider timed out after the request was sent' };
    if (this.behaviour === 'fail') return { kind: 'failed', retryable: true, error: 'Sandbox failure' };
    return { kind: 'accepted', providerMessageId: `sandbox-${msg.idempotencyKey}` };
  }
}

export const INTEGRATIONS: AdapterDescriptor[] = [
  {
    provider: 'joinedup',
    label: 'JoinedUp',
    status: 'manual',
    capabilities: [
      { name: 'Create booking', available: false, note: 'No API entitlement or documentation verified.' },
      { name: 'Booking entry queue', available: true, note: 'Staff enter bookings in JoinedUp, then record the booking ID and verify.' },
      { name: 'Compatible import file', available: false, note: 'No supported JoinedUp template obtained; exports are canonical CDS files only.' },
    ],
    manualFallback: 'Use the JoinedUp queue: enter, record the JoinedUp booking ID, then verify with evidence.',
    openQuestions: ['Is JoinedUp mandatory for every client?', 'What API or import access exists?', 'Which system owns each worker and compliance field?'],
  },
  {
    provider: 'whatsapp',
    label: 'WhatsApp',
    status: 'disabled',
    capabilities: [
      { name: 'Send messages', available: false, note: 'Business account, templates and recipients not configured.' },
      { name: 'Read existing groups', available: false, note: 'Existing chat exports do not prove API access to those groups.' },
      { name: 'Paste a message', available: true, note: 'Paste text into intake; the original is preserved.' },
    ],
    manualFallback: 'Copy the generated message, send it yourself, then record it as sent.',
    openQuestions: ['Business number and Groups API eligibility on the actual account', 'Approved templates and consent policy'],
  },
  {
    provider: 'email',
    label: 'Email',
    status: 'manual',
    capabilities: [
      { name: 'Mailbox ingestion', available: false, note: 'Provider (Microsoft 365, Google Workspace or other) not confirmed.' },
      { name: 'Paste email text', available: true, note: 'Paste the email into intake; it is kept as evidence.' },
    ],
    manualFallback: 'Paste the email (including the time it was received) into intake.',
    openQuestions: ['Which email provider and which operational mailboxes?'],
  },
  {
    provider: 'ai_extraction',
    label: 'AI extraction',
    status: 'disabled',
    capabilities: [{ name: 'Propose structured fields from messages', available: false, note: 'Optional P2 feature. The app works fully without it.' }],
    manualFallback: 'Enter order details by hand beside the original message.',
    openQuestions: ['Approved provider data-processing terms', 'Cost limits'],
  },
];
