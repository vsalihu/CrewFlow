import { captureSourceSchema, type CaptureSourceInput } from '@cds/contracts';

/** The route decides the kind of source; the body cannot override it. */
export function captureSchema(kind: 'pasted_message' | 'phone_note', body: unknown): CaptureSourceInput {
  return captureSourceSchema.parse({ ...(body as object), kind });
}
