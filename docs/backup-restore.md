# Backup and restore

Proposed pilot targets (§22.4), to be proven, not assumed: database RPO 15 minutes, operational RTO 4 hours, document-object RPO 24 hours.

## Database

- Enable Supabase point-in-time recovery on a plan that meets the RPO.
- Database backups do **not** include Storage object bytes. When document storage is introduced, back up the private bucket separately (encrypted, with retention).

## Restore exercise (required before pilot; not yet performed)

1. Restore staging from a production-like backup (synthetic data) to a new project.
2. Apply the same application version; set runtime credentials.
3. **Before starting the worker:** inspect `app.outbox_events`. Mark events created before the restore point and still `pending` as `manual_required`, and reconcile them by hand. Drafts in `delivery_unknown` must be checked with recipients. Message sends are guarded by write-ahead `delivery_unknown`, so the worker never resends those automatically.
4. Start the worker; confirm the heartbeat and that no messages were sent.
5. Record time to restore and data loss window against the targets.

## Exports

The business must be able to export its operational data without lock-in: all data is in documented PostgreSQL tables ([data-dictionary.md](data-dictionary.md)). Versioned export batches are on the P2 backlog.
