# Daily publication reliability

## Incident assessment — 21 October 2026

The workflow at commit `1dc1cf8c2cce3b55bc751725fa6d100acbe67d8c`
scheduled `15 3 * * *` (03:15 UTC). Run `39569513555` was created and
started at 08:28:21 UTC: **5 h 13 min 21 s late**. Its runner started at
08:28:25, calculation ran from 08:28:31 to 08:28:38, and the push of
`7a2210ab98820e6e33fb3688c6dff2844ee89ae3` succeeded at 08:28:40.
The run completed successfully (updated at 08:28:43).

The most likely cause is delayed delivery of GitHub's scheduled event,
before the run was created, rather than slow RSS processing or a runner
waiting for hours. GitHub documents delayed and sometimes dropped schedule
events under load. The available logs do not prove the particular underlying
GitHub incident. UTC rules out a Paris daylight-saving explanation; the
existing minute 15 already avoids the top of the hour. Moving the cron
alone would not ensure delivery.

Sources:
- https://github.com/botsmarket75-lgtm/botsmarket-ranking/actions/runs/39569513555
- https://github.com/botsmarket75-lgtm/botsmarket-ranking/blob/1dc1cf8c2cce3b55bc751725fa6d100acbe67d8c/.github/workflows/daily.yml
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## Behaviour

- Preserve the primary 03:15 UTC schedule. Add recovery opportunities at
  04:37, 05:37, 06:37, 09:37 and 12:37 UTC, plus manual dispatch.
- Serialize publishers with `cancel-in-progress: false`; use the latest
  `main` after obtaining the lock. GitHub may replace an older pending run;
  any surviving run performs the same daily check.
- A coherent current UTC day's publication is a no-op, including manual
  reruns. This matters because a second calculation would use today's
  `prev_ranking.json` and could apply the daily score cap again.
- Check nonempty ranking rows, the date, and equality with `prev_ranking.json`
  and `history/YYYYMMDD.json` before committing and again on remote `main`.
  A successful build alone is not considered a successful publication.
- Fail on actual commit errors. Retry a push up to three times only while
  `main` remains unchanged; recognize an accepted push with a lost response.
  If another writer advances `main`, fail safely and let a later run start
  from that new state. No force push or blind rebase of generated rankings.
- Partial/corrupt current-day data fails rather than recalculating scores.
  Restore the three files from a known complete publication before retrying.
  If a build crosses UTC midnight, verification fails; a subsequent run
  builds for the new day. Missed historical days are not backfilled.
- `build_rankings.js` and `solutions.json` remain unchanged: no scoring
  recalibration, weighting changes or RSS error-handling changes.

## Monitoring and limits

The watchdog runs independently of the publishing job at 04:47, 10:47,
16:47 and 22:47 UTC. It reads the actual JSON bundle, not a previous workflow's
green status. Until 04:15 UTC, yesterday's publication is acceptable; from
04:15 onward today's publication is required. Missing, stale, corrupt or
inconsistent output makes the watchdog fail. A publication commit more
than 60 minutes after 03:15 creates a warning and a step summary even if
the files are now current. A delayed recovery also warns before building.

Commit time is a proxy for repository publication time. These checks confirm
files on GitHub `main`; they do not verify a separate website or CDN.
Warnings are visible in Actions. Failed-workflow email/web notifications
depend on the account's GitHub Actions notification settings; this patch
does not configure an external notification recipient.

Both workflows still rely on the same GitHub scheduler. Neither can alert
at its nominal time if all schedule events are delayed or dropped, or Actions
is disabled. Multiple opportunities improve recovery, not punctuality guarantees.
For a strict morning deadline, use an independent scheduler to run the
read-only check below and alert on a nonzero exit code. It can also invoke
`gh workflow run daily.yml --ref main --repo botsmarket75-lgtm/botsmarket-ranking`
with an Actions-write credential stored securely by that scheduler.
No external scheduler or credential is provisioned by this patch.

## Tests and rollout

Local tests (Node 20 or later; no network, RSS requests or production writes):

```sh
node --test test/*.test.cjs
bash -n scripts/publish-ranking.sh
git diff --check
```

Tests cover the UTC deadline and grace boundary, stale/missing output,
duplicate-run suppression, partial/malformed data, UTC rollover, remote
verification, commit failure, a concurrent push, and a lost push response.
The new `Publication tests` workflow runs these checks on relevant PRs.

After merging the patch into `main`:

1. Run `Daily ranking` manually. If today's coherent bundle is already
   present, confirm calculation and push are skipped and remote verification
   passes. Otherwise confirm one new publication is committed.
2. Run it a second time: no additional ranking commit should be created.
3. Run `Publication watchdog` manually and inspect its summary. A late
   existing publication should warn, without pretending publication failed.
4. Observe the next primary/recovery cycle. Scheduled workflows use the
   default branch; a PR or feature branch alone does not activate them.

Read-only check from a fresh independent checkout (exit 1 means investigate):

```sh
git clone --branch main https://github.com/botsmarket75-lgtm/botsmarket-ranking.git
cd botsmarket-ranking
node scripts/publication.cjs check
```

Do not intentionally break production files to exercise the watchdog;
the test suite creates disposable fixtures and local Git remotes for that.
