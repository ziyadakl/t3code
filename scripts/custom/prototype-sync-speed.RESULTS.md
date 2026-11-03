# PROTOTYPE results: sync speed (2026-11-03). Throwaway, never merge.

Question: which sync pipeline gets from `upstream/main` to a green, mergeable `custom-v2` in the
least wall-clock time, with today's safety? Trial: custom-v2 9b8590569 + upstream/main cefb544af
(121 commits, 6 files, 7 conflict hunks). Local steps on affinity-vps (12 CPUs, Node 26.12.1),
timed by `prototype-sync-speed.sh`; CI timed on draft PRs ziyadakl/t3code#55 and #56.

## Local steps (affinity-vps)

| Step | Time |
|---|---|
| fetch | 2.1 s |
| merge | 0.4 s; rerere replayed 0 of 6 files |
| pnpm install, fresh worktree, warm store | 2.1 s (1,661 packages reused) |
| pnpm install after moving 121 commits | 3.8 s |
| knip / vp check / typecheck / web build, one after another | 20.2 / 11.7 / 24.5 / 7.9 s |
| the same four side by side | 22.4 s |
| typecheck after moving 121 commits (cache kept) | 25.7 s (the cache does not carry over) |
| server shard 3/8, `test:cached` (one runner per file, all cache misses) | 160.0 s |
| server shard 3/8, one `vp test run --shard` | 114.8 s (-28 %) |
| web tests, all files, 12 CPUs | 206.8 s |
| web tests, shard 1/4, 4 CPUs | 106.6 s |
| agent fix of the merge (Sonnet helper) | 10 min 56 s: conflicts 1 min 25 s, install 22 s, silent breakage (Upstream dropped `effect/Crypto`, 6 Fork files) ~6 min, neighbour tests 2 min 40 s |

Tests that reach a Fork change (`vp test list --changed <merge-base>`): server 469/469, web
525/525, mobile 270/270, also with the two package.json rerun triggers reset. Running only
affected tests saves nothing for this Fork.

## CI (GitHub-hosted, 4 vCPU)

| Shape | Last Linux job ends | Longest runner wait | Runner-seconds |
|---|---|---|---|
| Today (runs 41601964186, 41600312661) | 489 s, 683 s | 9 s | ~3,100 |
| v1: web 5 parts, test 5 groups, server 12 (#55) | 346 s | 167 s | ~4,350 |
| v2: + one runner per server shard, server 10 (#55) | 331 s | 161 s | ~3,900 |
| v2 on the real merge (#56) | 357 s | 145 s | 4,045 |

- About 20 jobs run at once; more wait (Build waited 159 s in v2). Floor ≈ runner-seconds / 20 +
  setup ≈ 4 min.
- `GitVcsDriverCore.test.ts` alone takes 93 s: no server shard can be shorter.
- macOS lint (`macos-26`) queued 10+ min in all 3 afternoon runs, 2 s in the morning runs. The
  Fork layer has 0 native mobile files.
- Sharded Test Web had one flaky browser failure in 2 of 3 runs (MessagesTimeline timeout,
  OpenInPicker assertion); both pass alone and the shard passes twice on 4 VPS CPUs. Unsharded
  Test Web failed 3 of 37 normal runs, all on the 2026-11-02 sync branch.
- Mac build (Custom Mac CLI Build): archive uploaded at ~167 s of a 244 s job; it starts only
  after the merge.

## Verdict

1. Biggest attended saving: replace `sync-upstream.sh check` (20-30 min) with the 22 s parallel
   static gate. Its slow part was the touched tests, run one file at a time; CI runs them anyway.
2. CI sharding (v2) saves 3-5 min per round, and stops near 4 min on free runners. It needs a
   flake answer first (retry once, or fix the two tests).
3. Mac build during CI saves 2.8-4.1 min, if the merge keeps the commit (fast-forward) and
   switch-build.sh accepts a build whose commit is now custom-v2.
4. macOS lint off the sync gate when the Fork layer has no native files: removes an unbounded queue.
5. The agent fix (~11 min) is then the largest step left, and machines cannot shorten it. Only
   doing it before Ziyad asks (the nightly update) brings "update" to "build ready" near 1-2 min.
