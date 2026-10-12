# Permissions

Code checks **capabilities**, never role names (`requireCapability(actor, 'order.accept', branchId)`). Roles map to capabilities in `packages/contracts/src/capabilities.ts`. Organisation roles (e.g. `org_admin`) apply everywhere; branch roles apply in that branch only. Row-level security independently limits every query to the actor's organisation and visible branches.

| Capability                                                 | Org admin | Branch manager | Coordinator | Dispatcher | Compliance | Payroll | Sales |
| ---------------------------------------------------------- | :-------: | :------------: | :---------: | :--------: | :--------: | :-----: | :---: |
| order.create / amend / accept / cancel                     |           |       ✓        |      ✓      |            |            |         |       |
| conflict.resolve                                           |           |       ✓        |      ✓      |            |            |         |       |
| assignment.propose / record_response                       |           |       ✓        |      ✓      |            |            |         |       |
| readiness.approve                                          |           |                |             |            |     ✓      |         |       |
| trip.plan / record_acceptance / publish                    |           |       ✓        |      ✓      |     ✓      |            |         |       |
| message.draft / record_sent                                |           |       ✓        |      ✓      |     ✓      |            |         |       |
| external_booking.verify                                    |           |       ✓        |      ✓      |            |            |         |       |
| task.manage                                                |           |       ✓        |      ✓      |     ✓      |     ✓      |    ✓    |   ✓   |
| duty.manage, site.verify, worker.manage, branch.override   |           |       ✓        |             |            |            |         |       |
| attendance.record (arrivals, timesheet entry, corrections) |           |       ✓        |      ✓      |            |            |    ✓    |       |
| attendance.approve                                         |           |       ✓        |             |            |            |    ✓    |       |
| payroll.export                                             |           |                |             |            |            |    ✓    |       |
| sensitive_document.read                                    |           |                |             |            |     ✓      |         |       |
| membership.manage, integration.manage, policy.manage       |     ✓     |                |             |            |            |         |       |
| audit.read                                                 |     ✓     |       ✓        |             |            |            |         |       |

Notable restrictions (tested): the person who entered a timesheet cannot approve it, even with `attendance.approve`; only `payroll.export` can create, download or acknowledge exports, and every download is audited; break rules need `policy.manage`; coordinators cannot approve readiness; a coordinator from another branch gets 404 for an order URL and cannot capture sources in that branch; the runtime database role cannot update audit or revision rows or delete anything.

Client, worker and driver portal roles are planned (P1/P3) and will use scoped, expiring, hashed confirmation tokens rather than staff capabilities.
