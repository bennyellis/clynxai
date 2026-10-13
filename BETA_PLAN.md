# Clynx controlled beta - rollout plan

This is a plan, not a record. **No beta has been run.** Nothing below claims real users have tried Clynx; numbers in "exit criteria" are targets to be measured.

## Goals
1. Find the failures a developer machine hides: a fresh Windows install, a different Chrome, slow disks, antivirus, unusual Marketplace layouts, small screens.
2. Measure whether deal alerts are trustworthy (right product, right price, worth the user's time).
3. Prove the account, plan and billing flow end to end in Stripe **test mode** before anyone is charged.

## Stages
| Stage | Who | Size | Plan/billing | Length | Move on when |
|---|---|---|---|---|---|
| 0. Internal | the owner, own machine(s) | 1 | comp Pro account | 1 week | no crash, no data loss, backups restore |
| 1. Friends | people the owner knows | 3-5 | comp Pro (no payment) | 2 weeks | exit criteria below, two weeks in a row |
| 2. Closed beta | invited, with a signed-off privacy/terms notice | 15-25 | Stripe **test mode** checkout only | 4 weeks | exit criteria; legal review of platform terms done |
| 3. Open paid beta | waitlist | grows in steps of ~25% | live billing (separate decision) | - | only after production billing is validated |

Each stage needs the owner's explicit go-ahead. Stage 3 involves real charges and is outside what this repository enables.

## Before stage 1
- Release checklist sections 1, 2, 4 done (signed Windows installer, tested on a clean machine, Chrome requirement stated).
- Cloud deployed per `cloud/DEPLOYMENT.md` on a server the owner chose; `ENFORCE_ENTITLEMENTS` still off.
- A way to hear from testers: one email address or chat group, and the "Save diagnostics" file they can send (it contains logs and settings with secrets removed - check before first use).
- Facebook: testers use their **own** accounts on their **own** machines at the app's conservative scan pace. Clynx never stores Facebook credentials in the cloud.

## What testers are asked to do
Install, sign up, add two Watches, let it run for a day, mark deals "interested" / "not interested", try the Database screen, break the internet connection once, and quit/relaunch. Weekly: send diagnostics and answer three questions (any wrong-product alerts? any missed obvious deals? anything confusing?).

## Exit criteria (targets, to be measured)
- No data loss: zero reports of a lost Database; every restore drill succeeds.
- Stability: no unexplained crashes in a week; app restarts cleanly after a forced kill.
- Alert quality: at least 8 in 10 alerts judged "worth looking at" by the tester; wrong-product alerts under 1 in 10.
- Reliability: scans run on schedule; Facebook session problems are explained in plain words (never a silent stop).
- Support load: fewer than one question per tester per week that the app should have answered itself.
- Billing (test mode): checkout, trial, failed payment, cancel and portal flows all behave; webhook replays are harmless.

## Rollback
- Keep the previous signed installer and manifest available. A tester can reinstall the older version over the newer one; the Database is migrated forward only (additive), so the older version still opens it.
- The app keeps automatic Database backups (Config > Account > Database backups); a bad build is undone with "Restore".
- If a release is bad: stop offering it (remove the manifest), tell testers, ship a fixed build. A version that fails to start 3 times is marked bad on that computer and never offered again (update design).

## Risks to watch
- Facebook layout or terms changes; scan pace and platform terms need legal advice before a paid launch.
- Chromium/Chrome availability on testers' machines.
- AI cost per user (plan limits are in `cloud/src/entitlements/plans.ts`; meter first, enforce later).
- Accounts: password resets are not built yet (see "Remaining launch requirements" in the final report).
