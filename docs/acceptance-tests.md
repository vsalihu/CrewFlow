# Acceptance tests and progress

Progress against the build plan's acceptance tests (§23) and phases (§25). "Tested" means an automated test exercises the scenario against real PostgreSQL (domain tests) or the running app (Playwright). Nothing is marked done on the strength of a screen alone.

Legend: **Tested** · **Partial** (part built and tested; the gap is stated) · **Planned** (phase noted) · **Blocked** (needs a business decision or provider access)

## Phase status

| Phase                         | Status                         | Evidence                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: boundaries and project     | Done for synthetic development | Workspace, pinned stack, CI, `.env.example`, migrations, capability matrix, two-branch synthetic organisation, honest integration matrix. Not done: Supabase/Render projects provisioned (needs owner accounts).                                                                                            |
| 1: first operational workflow | Done; exit gate passes         | `packages/domain/test/phase1-exit-gate.test.ts` plans a ten-person booking without inferring drivers. The source time conflict blocks instructions until resolved, and one worker decline, one driver change and one client reduction are handled end to end, including JoinedUp verification and handover. |
| 2: pilot hardening            | Started                        | Done: outbox/worker, stale-message suppression, permission tests. Not started: TXT/ZIP/.eml import, timesheets, exports, confirmation links, MFA, monitoring, backup/restore exercise.                                                                                                                      |
| 3–6                           | Not started                    | See the backlog at the end.                                                                                                                                                                                                                                                                                 |

## Acceptance tests

| ID   | Scenario                                | Status                                | Where                                                                                                                                   |
| ---- | --------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| AT01 | One chat, several roles/sites/starts    | Tested                                | `orders.test.ts` AT01/AT05                                                                                                              |
| AT02 | 06:30 vs 07:00 source conflict          | Tested                                | `orders.test.ts` AT02, `communications.test.ts`, exit gate                                                                              |
| AT03 | Count increases 4 → 10                  | Tested                                | `orders.test.ts` AT03                                                                                                                   |
| AT04 | Duplicate person in roster              | Tested                                | `orders.test.ts` AT04/AT20                                                                                                              |
| AT05 | 4 at 07:00, 6 at 11:30                  | Tested                                | `orders.test.ts` AT01/AT05                                                                                                              |
| AT06 | `OWN` after every name                  | Tested                                | `transport.test.ts` AT06/AT08, e2e                                                                                                      |
| AT07 | Private couple, no extra passengers     | Tested                                | `transport.test.ts` AT07                                                                                                                |
| AT08 | No driver evidence                      | Tested                                | `transport.test.ts` AT06/AT08                                                                                                           |
| AT09 | Driver proposed, not accepted           | Tested                                | `transport.test.ts` AT09/AT18                                                                                                           |
| AT10 | Five people, four seats                 | Tested                                | `transport.test.ts` AT10                                                                                                                |
| AT11 | Multi-drop capacity; driver's own shift | Tested                                | `transport.test.ts` AT11                                                                                                                |
| AT12 | Breakdown affects all passengers        | Tested                                | `transport.test.ts` AT12/AT13                                                                                                           |
| AT13 | Unknown finish, later pickup request    | Tested                                | `transport.test.ts` AT12/AT13                                                                                                           |
| AT14 | Unwell worker immediate pickup          | Tested                                | `transport.test.ts` AT14                                                                                                                |
| AT15 | 06:29 cancellation                      | Tested                                | `communications.test.ts` AT15                                                                                                           |
| AT16 | Delay confused with cancellation        | Planned (P2/P4 intake classification) | Manual intake keeps the source; no classifier yet                                                                                       |
| AT17 | Accepts revision 2 after revision 3     | Tested                                | `orders.test.ts` AT17                                                                                                                   |
| AT18 | Pickup added after driver acceptance    | Tested                                | `transport.test.ts` AT09/AT18                                                                                                           |
| AT19 | Client declines replacement             | Tested                                | `orders.test.ts` AT19                                                                                                                   |
| AT20 | Five arrive for three accepted          | Partial                               | Over-allocation prevented (tested). Recording extra arrivals as exceptions needs attendance (P2).                                       |
| AT21 | Must leave 18:00, shift to 20:00        | Tested                                | `orders.test.ts` AT21                                                                                                                   |
| AT22 | Same worker proposed twice concurrently | Tested                                | `orders.test.ts` AT22 (database exclusion constraint)                                                                                   |
| AT23 | Similar names; name correction          | Partial                               | Distinct people are never merged (no merge path exists); aliases are searchable. Name-correction service with history is not built yet. |
| AT24 | Leading-zero external ID                | Tested                                | exit gate (`000417`), UI shows the string                                                                                               |
| AT25 | Pending/expired readiness blocks        | Tested                                | `orders.test.ts` AT25                                                                                                                   |
| AT26 | Work reported despite block             | Planned (P2 attendance)               |                                                                                                                                         |
| AT27 | Duplicate timesheet hours               | Planned (P2)                          |                                                                                                                                         |
| AT28 | Paid vs unpaid breaks                   | Planned (P2)                          |                                                                                                                                         |
| AT29 | Midnight / DST                          | Partial                               | Shift times tested (`orders.test.ts` AT29); attendance durations come with P2                                                           |
| AT30 | Historical timesheet in today's inbox   | Planned (P2)                          |                                                                                                                                         |
| AT31 | Timesheet vs JoinedUp discrepancy       | Partial                               | JoinedUp states `discrepancy`/out-of-date shown in queue; timesheet side is P2                                                          |
| AT32 | Change after export                     | Planned (P2)                          |                                                                                                                                         |
| AT33 | P45 vs active work                      | Planned (P3)                          |                                                                                                                                         |
| AT34 | Email-required client, chat heads-up    | Partial                               | `needs_clarification`/`draft` request states and source authority field; per-client channel policy not enforced yet                     |
| AT35 | Follow-up email adds second FLT         | Partial                               | Amendment and skill-specific lines work; email adapter is P3                                                                            |
| AT36 | Site resembles another                  | Partial                               | Unverified location blocks dispatch (tested); alias review UI not built                                                                 |
| AT37 | Overlapping re-import                   | Planned (P2 import)                   | Provider message-ID uniqueness exists in schema                                                                                         |
| AT38 | "Tomorrow" in an old message            | Planned (P2 import/extraction)        | `localDateOf` helper exists                                                                                                             |
| AT39 | Omitted attachment                      | Planned (P2 import)                   |                                                                                                                                         |
| AT40 | Malicious archive / injected text       | Planned (P2 import)                   | Pasted text is stored and displayed as data only                                                                                        |
| AT41 | Contact changed                         | Tested                                | `readiness.test.ts` AT41 (propagation tasks to JoinedUp/payroll not yet generated)                                                      |
| AT42 | Cross-branch URL                        | Tested                                | `security.test.ts` AT42, e2e (404)                                                                                                      |
| AT43 | Pooled connection reuse                 | Tested                                | `security.test.ts` AT43                                                                                                                 |
| AT44 | Last seat taken concurrently            | Tested                                | `transport.test.ts` AT44                                                                                                                |
| AT45 | Provider timeout                        | Tested                                | `communications.test.ts` AT45                                                                                                           |
| AT46 | Old outbox job after cancellation       | Tested                                | `communications.test.ts` AT46                                                                                                           |
| AT47 | Worker crash after commit               | Tested                                | `communications.test.ts` AT47                                                                                                           |
| AT48 | Restore with old send jobs              | Partial                               | Write-ahead `delivery_unknown` prevents blind resend; restore exercise not done (P2)                                                    |
| AT49 | PPE gloves by size                      | Planned (P5)                          |                                                                                                                                         |
| AT50 | Accommodation staggered arrivals        | Planned (P5)                          |                                                                                                                                         |
| AT51 | Blocking site onboarding requirement    | Tested                                | `readiness.test.ts` AT51                                                                                                                |
| AT52 | Forecast ended, drafts remain           | Planned (P5)                          |                                                                                                                                         |
| AT53 | Early request, nobody on duty           | Tested                                | `orders.test.ts` AT53                                                                                                                   |
| AT54 | Integrations unavailable                | Tested                                | All tests and e2e run with WhatsApp disabled and JoinedUp manual                                                                        |

Additional tested rules: idempotency replay/conflict, append-only audit and revisions for the runtime role, cross-organisation foreign keys, impact-token tampering, stale draft after amendment, driver manifest without phone numbers.

## Backlog (next, in order)

1. Worker name correction with history and identity review (AT23); contact-change propagation tasks (AT41).
2. TXT/ZIP/.eml import with limits, preview, provenance and duplicate review (AT37–AT40, AT38).
3. Attendance segments, breaks, timesheet approval, versioned exports, reconciliation (AT26–AT32).
4. Scoped worker/driver confirmation links; staff MFA; monitoring/alerts; backup and restore exercise (AT48).
5. Client portal, email adapter, expected-request chase queue, onboarding documents, payroll/P45 cases (P3).
6. Optional AI extraction and an official WhatsApp adapter only after account capabilities are proven (P4).
7. PPE, accommodation and forecasts (P5).
