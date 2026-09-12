# QA FINAL SAFETY Review — node-hudu agent execution layer (api-node-squad 3.0.1)

Reviewer: FINAL SAFETY GATE (independent cross-model lens, read-only)
Repo: /Users/maxs/gitrepos/node-hudu
Branch: feat/agent-execution-layer @ ca011f1 vs main @ 9332efe (v0.2.1)
Commits reviewed: git log --oneline main..HEAD (28 commits, whole branch)

## Re-verification of prior qa-safety.md findings (CLOSED / STILL OPEN / WRONG)

- [PENDING] CRITICAL — exports/s3_exports reversible:true dry-run claim
- [PENDING] HIGH — bulk-delete dry-run hardcodes affected:1 (activity_logs.deleteAll, magic_dash.delete)
- [PENDING] HIGH — impact only on dry-run, no executed-result/AuditEvent counterpart
- [PENDING] LOW — refuseExpectedUpdatedAt duplicated per-resource instead of shared helper
- [PENDING] NIT — capabilities.plan.json uncommitted diff at time of last review

## New surfaces (this pass)

- [PENDING] (a) bulk operations pre-read FLOOR with exact:false — real floor? dry run still zero mutating requests?
- [PENDING] (b) AuditEvent.impact / impact.exact — executed carries impact, read doesn't, dry-run vs executed agree
- [PENDING] (c) reversible:true audit across the whole tree vs vendor spec (undo path exists?)
- [PENDING] (d) every dry-run issues zero fetches, incl. multipart + two new operations helpers
- [PENDING] (e) expectedUpdatedAt refused on create/delete/archive everywhere; never fabricates STALE_OBJECT when no version field

## Findings (ranked)

(to fill)

## VERIFIED OK

(to fill)

## UNVERIFIED

(to fill)

## Grounding calls used: 0/55 (updating as I go)
