# Operations runbook

For coordinators, dispatchers and the duty owner. Written for the pilot; refine with the branch manager.

## Daily rhythm

- **Evening (tomorrow view):** for every expected client, check a request exists or record "no work". Clear red blockers line by line: decide the accepted count, resolve conflicts, assign workers, record replies, plan both transport legs, get driver acceptance for the current revision, publish journeys, enter and verify JoinedUp bookings. Hand over before you go, and make sure the next person acknowledges.
- **Morning (today view):** departures, late or missing workers, urgent tasks, cancellations still awaiting acknowledgement, breakdowns.
- **Day:** changed finish times, return queue, pickups, open cases.

## Rules that matter

- Saving a request does not accept it. Decide the quantity explicitly; a shortfall is recorded, not hidden.
- Never resolve "06:30 vs 07:00" by picking one. Record the conflict, call the client, resolve it with a note, then amend.
- `OWN` on a roster means nothing to the system. Only people with a driver record can drive, and only once they accept the current revision.
- A copied message is not sent; a sent message is not agreed. Record each step.
- After any change, follow the tasks it creates: reconfirm, re-send, tell the driver, update JoinedUp.
- Completing a task needs a written outcome (who, what was agreed).

## When something goes wrong

| Situation                        | Do this                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Urgent order, nobody on duty     | The board shows "no one on duty"; the backup or manager takes ownership via the task                                                         |
| Worker declines                  | A replacement task appears; if the client says no replacement, record that on the line                                                       |
| Driver cannot drive              | Revise the journey with a new driver (acceptance resets), or cancel it (passengers' legs reopen)                                             |
| Breakdown                        | Report disruption on the journey; follow the replacement-transport and client-ETA tasks                                                      |
| Same-day cancellation            | Cancel with scope; unsent instructions are withdrawn; draft cancellation messages for everyone already told and record their acknowledgement |
| Message stuck "delivery unknown" | Check with the recipient before sending again                                                                                                |

## Outage (application or database unavailable)

1. Use the most recent printed or exported board, noting its generated time; it is not current.
2. Coordinate by phone; keep a controlled incident log of every change (time, who, what, source).
3. When service returns, enter each change from the log as a source plus amendment, then reconcile messages and JoinedUp.
4. Check `/integrations` and the worker heartbeat before relying on automation again.
