# Business-rule assumptions

Everything below is an **implementation decision**, not a claim about the
program guide (`Waresport_Internship_Program.pdf`). Each entry says what the
guide does specify, what it leaves open, what this system does instead, and
where an admin can change it.

---

## 1. What the program guide actually specifies

These are taken directly from the PDF and are implemented literally:

| Rule | Source |
| --- | --- |
| 12-week program, 6 interns, East and West groups of 3 | "PROGRAM SETUP" |
| Week 1: 75 emails, 50 LinkedIn requests | "OUTREACH GOALS" table |
| Weeks 2–12: 150 emails, 100 LinkedIn requests | "OUTREACH GOALS" table |
| Suggested daily pace: 15/10 in week 1, 30/20 afterwards | "OUTREACH GOALS" table |
| Primary sports: Basketball, Soccer, Gymnastics, Volleyball; others allowed | "Primary focus sports" |
| Cold calling is optional | "Cold calling is optional" |
| Follow-ups matter as much as new outreach | "Don't forget to follow up" |
| Every 10 meetings booked **and actually held** earns $100 | "MEETINGS & COMPENSATION" |
| The total builds across the internship and does not reset weekly | "rather than resetting week to week" |
| Waresport provides an email address, 2 months of LinkedIn Premium, scripts, personalization guidance, a platform walkthrough and training | "WHAT WE'LL PROVIDE" |
| Training topics | "TRAINING" |
| Project types and the end-of-program wrap-up questions | "PROJECTS" |

The 6-intern / 3-per-group split is treated as a **default, not a capacity
limit**: nothing in the system stops an admin adding more interns or a third
territory.

---

## 2. Where a program week starts and ends

**The guide does not define this.** It says "12 weeks" and gives different
week-1 targets, but never says whether a week runs Monday–Sunday, or from the
start date, or in whose timezone.

**Decision.** Week 1 is the first seven calendar days beginning on the cohort's
start date; weeks 2–12 follow consecutively. Boundaries are computed in the
cohort's IANA **reporting timezone** as half-open `[start, end)` instant ranges.

Consequences, all covered by tests:

- A week is always exactly seven *local* days. A week containing a daylight
  saving transition is 167 or 169 hours, not 168.
- The boundary instant belongs to the later week, never to both.
- An intern's personal timezone controls only how times are displayed to them.
  Every target, leaderboard and export uses the cohort's reporting timezone, so
  two interns in different timezones are measured identically.
- Dates outside the 12 weeks produce **no** target. The app never silently
  generates one; the intern dashboard says so explicitly.

**Configurable:** cohort start date, week count and reporting timezone, under
*Targets & Program*.

---

## 3. What counts toward the weekly email target

**The guide does not settle this.** It says "Emails / week: 150" and separately
that follow-ups matter, without saying whether a follow-up counts toward that
number.

**Default decision.** Both an initial email and a follow-up email count. Only
explicitly logged, actually-sent messages count — writing a draft, copying an
address or opening a mail client never does.

**Configurable:** *Targets & Program → Metric policy*. Changing it creates a new
**version** effective from that moment; weeks already worked keep the rule they
were measured under, so the change cannot rewrite history.

To stop a high email count from hiding repetitive outreach, first touches,
follow-ups and unique organizations are always displayed **separately**.

---

## 4. What counts toward the weekly LinkedIn target

**The guide says "LinkedIn requests / week: 100"** but does not say how
acceptances or later messages are treated.

**Default decision.** Only a **first-time connection request** for a given
profile counts, and it counts exactly once — enforced by a partial unique index
on `activity_events`, not by application logic. An accepted connection is not
outreach at all. A message sent after connecting is logged as outreach and
appears in the follow-up column, but does not count again toward the request
target.

Adding a prospect to the LinkedIn tracker is **research**, not outreach.

**Configurable:** the same metric policy version as above.

---

## 5. When a meeting is worth $100

**The guide says** "for every 10 meetings that are booked and actually take
place, you earn $100". It does not define who confirms that a meeting took
place, or what happens to a meeting held outside the program window.

**Decisions:**

1. **Approval requirement.** "Actually took place" is operationalised as a
   meeting an admin or owner has moved to `verified_held`. An intern can book a
   meeting and submit it as held, but cannot verify their own — enforced by a
   database trigger, not only by the UI.
2. **Eligibility window.** A meeting counts when its **held date** falls inside
   the credited intern's cohort window, regardless of when an admin got round to
   approving it. Late approval of an eligible meeting still counts.
3. **Exceptions.** An admin may verify a meeting held outside that window, but
   only with a typed reason, which is stored on the meeting and in the audit log.
4. **No per-club limit.** The guide imposes no one-meeting-per-club lifetime
   cap, so none is invented. A second verified meeting at a club is *flagged for
   review* in the verification queue rather than blocked.
5. **Nothing else pays.** Scheduled, pending, cancelled and no-show meetings are
   worth zero. Rescheduling updates the same meeting rather than creating a
   second payable event.

Arithmetic, with `H` = eligible verified-held meetings:

```
earned milestones          = floor(H / 10)
earned dollars             = floor(H / 10) * 100
progress to next milestone = H mod 10
meetings until next        = 10 - (H mod 10)
paid dollars               = sum of non-voided payout ledger entries
balance                    = earned - paid
```

At `H = 10` the display reads **"$100 earned; 0/10 toward your next $100"** —
never a misleading "0 earned". Worked examples are pinned in
`tests/unit/compensation.test.ts` and re-verified against the database in
`tests/integration/compensation.test.ts`.

---

## 6. Payouts are records, not transfers

Nothing in this system moves money. A payout row records that an admin paid a
milestone outside the system, with a date and reference. A milestone can be
recorded at most once, guaranteed by a partial unique index, so two concurrent
"mark paid" requests cannot both succeed.

Reversing a verification recalculates earned dollars but **never deletes a
payout**. If that leaves an intern overpaid, the difference is written to
`payout_adjustments` and surfaced as "Reconciliation needed" on both the admin
and intern screens, rather than hidden behind a negative balance.

---

## 7. Territory mapping

**The guide does not define a state-to-territory map.** It only says East and
West groups are responsible for "their part of the country".

**Decision.** The map is *data*, editable under *Settings*. The seed ships a
reasonable East/West split of all 50 states, but nothing in the code depends on
it. A state with no mapping imports as **unassigned** and is visibly flagged in
the import report and on the leads screen.

A cross-territory assignment is allowed, but only with an explicit override
reason, which is stored on the assignment row and in the audit log.

---

## 8. Organization identity and duplicate handling

The supplied file has 1,231 data rows but only 967 distinct club names — several
national bodies appear once per state, and several clubs list more than one
director.

**Decision.** An organization's identity is *normalised name + state + city*.

- Same name, different state → **different** clubs. ("Diamond Youth Softball"
  appears in 44 states.)
- Same name and state, different city → **different** clubs.
- Same name and state, one row with no city → **uncertain**. The row is held for
  admin review rather than merged or duplicated.
- A shared consumer-mail domain (gmail.com and similar) is **never** evidence
  that two clubs are the same.
- The same email at a different organization → held for review, never merged.

Duplicates default to **skip**. Contacts live in their own table, so several
directors at one club never become conflicting assignments.

---

## 9. Backdating and corrections

Outreach cannot be logged with a future timestamp (a one-minute grace absorbs
clock skew). Backdating is allowed but only within the intern's cohort window,
and every entry records both when it happened and when it was logged.

A logged activity is **immutable**. A mistake is corrected by voiding it with a
reason; the row stays in the timeline and the audit trail, and metrics
recalculate from the remaining non-voided rows. There is no delete, and no way
to type a metric directly.

---

## 10. What this system deliberately does not do

- It does **not** send outreach. Interns send from their own Waresport mailbox
  and LinkedIn account and record it here. The system sends no email at all.
- It does **not** scrape or fetch LinkedIn. Profile URLs are validated and
  canonicalised as text.
- It does **not** track opens, clicks or deliverability. A `mailto:` link, a
  copy button or a LinkedIn link never counts as outreach.
- It does **not** provision Waresport mailboxes or LinkedIn Premium. Those are
  an admin-managed checklist recording what was set up elsewhere.
- It does **not** move money.
- Self-reported outreach is labelled as such wherever it is shown. Nothing in
  this system independently verifies that an email was sent.
