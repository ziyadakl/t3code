# Sandcastle Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, in-app view of Sandcastle runs to t3 — an all-projects dashboard that drills into a per-project detail view — surfacing each project's `.sandcastle/status.json` across both the local Mac and the remote VPS.

**Architecture:** Mirror the existing **dev-server** feature exactly (Effect-RPC-over-WebSocket, unary request/response, web polls). A new server service `SandcastleStatusReader` reads `<projectCwd>/.sandcastle/status.json` for a list of project cwds and returns parsed snapshots plus the reading server's clock (`serverNow`, used for clock-skew-safe staleness). The web side polls each environment's `sandcastle.statusAll` every 2s, merges results across environments, and renders a dashboard route + detail route reached from a new left-sidebar entry. t3 never writes the file and never imports Sandcastle code — it re-declares the status shape as an Effect Schema mirror and parses JSON defensively, flagging a `schemaOutdated` entry if Sandcastle's `schemaVersion` ever moves past `1`.

**Tech Stack:** Effect (Schema, Layer, Context.Service, FileSystem, Clock), Effect RPC (`effect/unstable/rpc/Rpc`), TanStack Router (file-based routes), Zustand (`useStore`), React, Tailwind, vitest / `@effect/vitest`.

---

## Conventions for this repo (read before starting)

- **Test runner gotcha:** with `@effect/vitest`, a **bare** `it(() => Effect.gen(...))` passes *without running the effect*. Use `it.effect(...)` for Effect tests. Pure (non-Effect) functions use plain `it(...)` from vitest — that's fine.
- **Branch:** work on `custom` (the fork's working branch). Do not branch off `main`.
- **Fork hygiene:** every new unit of behavior goes in a NEW file. The only edits to existing files are small, additive wiring (registries, route tree, sidebar nav, layer composition) — never restructure upstream code.
- **Commit after each task.** Frequent commits.
- **Do NOT run the dev server while editing** — HMR re-opens the pair-URL and floods browser tabs. Live-verify happens only in the final task, headless or with the dev server you start at the end.
- **Effect FileSystem missing-file idiom:** `fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => fallback))`.
- **Package import specifiers:** contracts = `@t3tools/contracts`; shared = `@t3tools/shared/<subpath>`.

## File structure (what gets created / modified)

**Created:**
- `packages/contracts/src/sandcastle.ts` — Effect Schema mirror of the status snapshot + the `sandcastle.statusAll` RPC + `SandcastleError`.
- `packages/contracts/src/sandcastle.test.ts` — decode round-trip test for the schema mirror.
- `apps/server/src/sandcastle/buildStatusEntry.ts` — **pure** function: (cwd, hasSandcastleDir, rawJson) → `SandcastleStatusEntry`.
- `apps/server/src/sandcastle/buildStatusEntry.test.ts` — unit tests for the pure function (plain vitest).
- `apps/server/src/sandcastle/SandcastleStatusReader.ts` — Effect service + `SandcastleStatusReaderLive` layer (IO shell around the pure function).
- `apps/web/src/components/sandcastle/sandcastleView.ts` — **pure** view helpers: staleness, banner, GitHub issue URL, phase label/tone.
- `apps/web/src/components/sandcastle/sandcastleView.test.ts` — unit tests (plain vitest).
- `apps/web/src/components/sandcastle/useSandcastleStatuses.ts` — polling hook (per-environment, merged).
- `apps/web/src/components/sandcastle/SandcastleDashboard.tsx` — all-projects dashboard.
- `apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx` — per-project detail.
- `apps/web/src/routes/sandcastle.tsx` — layout route + auth guard (`<Outlet/>`).
- `apps/web/src/routes/sandcastle.index.tsx` — dashboard at `/sandcastle`.
- `apps/web/src/routes/sandcastle.$environmentId.$projectId.tsx` — detail route.

**Modified (additive wiring only):**
- `packages/contracts/src/rpc.ts` — import the RPC, add to `WS_METHODS`, add to `WsRpcGroup`.
- `packages/contracts/src/ipc.ts` — add `sandcastle` block to `EnvironmentApi`.
- `apps/server/src/ws.ts` — add auth scope, add handler, pull the service in the handler-building `Effect.gen`.
- `apps/server/src/server.ts` — import + provide `SandcastleStatusReaderLive`.
- `packages/client-runtime/src/wsRpcClient.ts` — add `sandcastle` type + impl block.
- `apps/web/src/environmentApi.ts` — add `sandcastle` block.
- `apps/web/src/components/Sidebar.tsx` — add a `Link to="/sandcastle"` nav entry.

---

## Task 1: Contract — status schema mirror + RPC

**Files:**
- Create: `packages/contracts/src/sandcastle.ts`
- Test: `packages/contracts/src/sandcastle.test.ts`

**Reference (source of truth for the shape):** `~/Dev/Sandcastle/.sandcastle/lib/status/schema.ts` (Zod). We mirror it as Effect Schema. Mirror template for RPC declaration style: `packages/contracts/src/devServer.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/contracts/src/sandcastle.test.ts
import { describe, it, expect } from "vitest";
import * as Schema from "effect/Schema";
import {
  SandcastleStatusSnapshot,
  SANDCASTLE_STATUS_SCHEMA_VERSION,
} from "./sandcastle.ts";

const SAMPLE = {
  schemaVersion: 1,
  state: "running",
  run: {
    branch: "sandcastle/run-jun4",
    repo: "affinity-tracker",
    startedAt: "2026-06-04T12:00:00.000Z",
    iterations: { current: 1, total: 50 },
    maxConcurrent: 2,
  },
  totals: { merged: 1, needsHuman: 1, requeued: 0, running: 1 },
  issues: [
    {
      number: 337,
      title: "backfilled txns uncategorized",
      branch: "agent/issue-337",
      phase: "implementer",
      startedAt: "2026-06-04T12:05:30.000Z",
    },
    {
      number: 339,
      title: "scope setUserEnabled to team",
      branch: "agent/issue-339",
      phase: "merged",
      detail: "ALL_CLEAR",
      startedAt: "2026-06-04T12:00:15.000Z",
      attention: false,
    },
  ],
  updatedAt: "2026-06-04T12:06:45.000Z",
  activity: "merging",
};

describe("SandcastleStatusSnapshot", () => {
  it("decodes a representative status.json", () => {
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)(SAMPLE);
    expect(decoded.state).toBe("running");
    expect(decoded.issues).toHaveLength(2);
    expect(decoded.issues[1]?.phase).toBe("merged");
    expect(decoded.totals.needsHuman).toBe(1);
  });

  it("decodes a snapshot with no issues and no activity", () => {
    const decoded = Schema.decodeUnknownSync(SandcastleStatusSnapshot)({
      ...SAMPLE,
      issues: [],
      activity: undefined,
    });
    expect(decoded.issues).toHaveLength(0);
  });

  it("rejects an unknown phase value", () => {
    expect(() =>
      Schema.decodeUnknownSync(SandcastleStatusSnapshot)({
        ...SAMPLE,
        issues: [{ number: 1, title: "x", branch: "b", phase: "bogus-phase" }],
      }),
    ).toThrow();
  });

  it("pins the known schema version to 1", () => {
    expect(SANDCASTLE_STATUS_SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run packages/contracts/src/sandcastle.test.ts`
Expected: FAIL — cannot resolve module `./sandcastle.ts`.

- [ ] **Step 3: Write the contract**

```typescript
// packages/contracts/src/sandcastle.ts
/**
 * Contracts for the Sandcastle viewer feature.
 *
 * t3 NEVER imports Sandcastle code. This is a defensive Effect Schema mirror of
 * the shape Sandcastle writes to `<repoRoot>/.sandcastle/status.json`. Source of
 * truth for the shape: ~/Dev/Sandcastle/.sandcastle/lib/status/schema.ts (Zod).
 *
 * The single RPC, sandcastle.statusAll, reads many projects' status files on one
 * environment's server in a single round-trip and returns the reading server's
 * clock (serverNow) so staleness is computed against the same clock that wrote
 * the file (the loop and the reader live on the same machine).
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

/** Bump in lockstep with Sandcastle's STATUS_SCHEMA_VERSION. Mismatch ⇒ "outdated". */
export const SANDCASTLE_STATUS_SCHEMA_VERSION = 1;

// Stable method-id constant (mirrors DEV_SERVER_WS_METHODS in devServer.ts).
export const SANDCASTLE_WS_METHODS = {
  sandcastleStatusAll: "sandcastle.statusAll",
} as const;

// --- snapshot shape (mirror of Sandcastle's Zod schema) --------------------

export const SandcastleIssuePhase = Schema.Literals([
  "planned",
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
  "merged",
  "needs-human",
  "deferred",
]);
export type SandcastleIssuePhase = typeof SandcastleIssuePhase.Type;

export const SandcastleRunState = Schema.Literals([
  "running",
  "done",
  "stopped",
  "restarting",
]);
export type SandcastleRunState = typeof SandcastleRunState.Type;

export const SandcastleStatusIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  branch: Schema.String,
  phase: SandcastleIssuePhase,
  detail: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  attention: Schema.optional(Schema.Boolean),
});
export type SandcastleStatusIssue = typeof SandcastleStatusIssue.Type;

export const SandcastleStatusTotals = Schema.Struct({
  merged: Schema.Number,
  needsHuman: Schema.Number,
  requeued: Schema.Number,
  running: Schema.Number,
});
export type SandcastleStatusTotals = typeof SandcastleStatusTotals.Type;

export const SandcastleStatusRun = Schema.Struct({
  branch: Schema.String,
  repo: Schema.String,
  startedAt: Schema.String,
  iterations: Schema.Struct({
    current: Schema.Number,
    total: Schema.Number,
  }),
  maxConcurrent: Schema.Number,
});
export type SandcastleStatusRun = typeof SandcastleStatusRun.Type;

export const SandcastleStatusSnapshot = Schema.Struct({
  // Loose Number (not Literal) on purpose: we detect version mismatch in code so
  // a future Sandcastle schema bump flags "outdated" instead of failing decode.
  schemaVersion: Schema.Number,
  state: SandcastleRunState,
  run: SandcastleStatusRun,
  totals: SandcastleStatusTotals,
  issues: Schema.Array(SandcastleStatusIssue),
  updatedAt: Schema.String,
  activity: Schema.optional(Schema.String),
});
export type SandcastleStatusSnapshot = typeof SandcastleStatusSnapshot.Type;

// --- per-project entry returned to the client ------------------------------

export const SandcastleStatusEntry = Schema.Struct({
  /** The project working directory this entry describes. */
  cwd: Schema.String,
  /** True when `<cwd>/.sandcastle/` exists (project is Sandcastle-enabled). */
  hasSandcastleDir: Schema.Boolean,
  /** Parsed snapshot, or null when no status.json / outdated / unparseable. */
  snapshot: Schema.NullOr(SandcastleStatusSnapshot),
  /** True when status.json's schemaVersion differs from what t3 understands. */
  schemaOutdated: Schema.Boolean,
  /** Human-readable read/parse failure, or null. */
  readError: Schema.NullOr(Schema.String),
});
export type SandcastleStatusEntry = typeof SandcastleStatusEntry.Type;

// --- RPC payload / result --------------------------------------------------

export const SandcastleStatusAllPayload = Schema.Struct({
  /** Project cwds to read on this environment's server. */
  cwds: Schema.Array(TrimmedNonEmptyString),
});
export type SandcastleStatusAllPayload = typeof SandcastleStatusAllPayload.Type;

export const SandcastleStatusAllResult = Schema.Struct({
  /** ISO time on the reading server — used for clock-skew-safe staleness. */
  serverNow: Schema.String,
  entries: Schema.Array(SandcastleStatusEntry),
});
export type SandcastleStatusAllResult = typeof SandcastleStatusAllResult.Type;

// --- error -----------------------------------------------------------------

export class SandcastleError extends Schema.TaggedErrorClass<SandcastleError>()(
  "SandcastleError",
  {
    message: Schema.String,
  },
) {}

// --- RPC (unary — no `stream: true`) ---------------------------------------

export const WsSandcastleStatusAllRpc = Rpc.make(
  SANDCASTLE_WS_METHODS.sandcastleStatusAll,
  {
    payload: SandcastleStatusAllPayload,
    success: SandcastleStatusAllResult,
    error: Schema.Union([SandcastleError, EnvironmentAuthorizationError]),
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run packages/contracts/src/sandcastle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/sandcastle.ts packages/contracts/src/sandcastle.test.ts
git commit -m "feat(sandcastle): add status schema mirror + statusAll RPC contract"
```

---

## Task 2: Contract wiring (rpc.ts + ipc.ts)

**Files:**
- Modify: `packages/contracts/src/rpc.ts` (3 insertion points)
- Modify: `packages/contracts/src/ipc.ts` (1 insertion point inside `EnvironmentApi`)

No new test — verified by typecheck. Mirrors how `devServer` is wired (rpc.ts lines ~119-124, ~189-193, ~605-608; ipc.ts ~601-606).

- [ ] **Step 1: Import the RPC in rpc.ts**

Add near the other contract imports (next to the `from "./devServer.ts"` import block):

```typescript
import {
  SANDCASTLE_WS_METHODS,
  WsSandcastleStatusAllRpc,
} from "./sandcastle.ts";
```

- [ ] **Step 2: Add the method name to `WS_METHODS`**

Inside the `WS_METHODS` object (right after the dev-server entries `devServerStart … devServerLogs`):

```typescript
  // Sandcastle viewer methods
  sandcastleStatusAll: SANDCASTLE_WS_METHODS.sandcastleStatusAll,
```

- [ ] **Step 3: Add the RPC to `WsRpcGroup`**

Inside the `RpcGroup.make(...)` argument list (next to `WsDevServerStartRpc … WsDevServerLogsRpc`):

```typescript
  WsSandcastleStatusAllRpc,
```

- [ ] **Step 4: Add the `sandcastle` block to `EnvironmentApi` in ipc.ts**

First ensure the types are imported at the top of `ipc.ts` (alongside the existing `DevServerPayload` import):

```typescript
import type {
  SandcastleStatusAllPayload,
  SandcastleStatusAllResult,
} from "./sandcastle.ts";
```

Then inside the `EnvironmentApi` interface (right after the `devServer: { … }` block):

```typescript
  sandcastle: {
    statusAll: (input: SandcastleStatusAllPayload) => Promise<SandcastleStatusAllResult>;
  };
```

- [ ] **Step 5: Typecheck the contracts package**

Run: `bun run vitest run packages/contracts/src/sandcastle.test.ts && bunx tsc -p packages/contracts --noEmit`
Expected: PASS / no type errors. (If the repo uses a different typecheck command, prefer `bun run typecheck` scoped to contracts; phantom errors from a parallel `.tsbuildinfo` race can be ignored — re-run clean before trusting.)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/rpc.ts packages/contracts/src/ipc.ts
git commit -m "feat(sandcastle): wire statusAll RPC into WsRpcGroup + EnvironmentApi"
```

---

## Task 3: Server — pure `buildStatusEntry`

**Files:**
- Create: `apps/server/src/sandcastle/buildStatusEntry.ts`
- Test: `apps/server/src/sandcastle/buildStatusEntry.test.ts`

This is the testable core: given the cwd, whether `.sandcastle/` exists, and the raw status.json text (or null), produce a `SandcastleStatusEntry`. Pure & synchronous (uses `Schema.decodeUnknownEither`), so it's plain-vitest testable with no Effect/FileSystem setup.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/src/sandcastle/buildStatusEntry.test.ts
import { describe, it, expect } from "vitest";
import { buildStatusEntry } from "./buildStatusEntry.ts";

const VALID = JSON.stringify({
  schemaVersion: 1,
  state: "running",
  run: {
    branch: "b",
    repo: "r",
    startedAt: "2026-06-04T12:00:00.000Z",
    iterations: { current: 1, total: 10 },
    maxConcurrent: 1,
  },
  totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
  issues: [],
  updatedAt: "2026-06-04T12:00:00.000Z",
});

describe("buildStatusEntry", () => {
  it("returns disabled entry when .sandcastle dir is absent", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: false, rawJson: null });
    expect(e.hasSandcastleDir).toBe(false);
    expect(e.snapshot).toBeNull();
    expect(e.schemaOutdated).toBe(false);
    expect(e.readError).toBeNull();
  });

  it("returns enabled-but-no-run when dir exists but status.json is missing", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: null });
    expect(e.hasSandcastleDir).toBe(true);
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeNull();
  });

  it("parses a valid status.json", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: VALID });
    expect(e.snapshot?.state).toBe("running");
    expect(e.schemaOutdated).toBe(false);
    expect(e.readError).toBeNull();
  });

  it("flags schemaOutdated when version differs and does not throw", () => {
    const future = JSON.stringify({ ...JSON.parse(VALID), schemaVersion: 2 });
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: future });
    expect(e.schemaOutdated).toBe(true);
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeNull();
  });

  it("records a readError on malformed JSON", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: "{not json" });
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeTruthy();
  });

  it("records a readError when JSON is valid but shape is wrong", () => {
    const e = buildStatusEntry({
      cwd: "/p",
      hasSandcastleDir: true,
      rawJson: JSON.stringify({ schemaVersion: 1, state: "nope" }),
    });
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/server/src/sandcastle/buildStatusEntry.test.ts`
Expected: FAIL — cannot resolve `./buildStatusEntry.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/server/src/sandcastle/buildStatusEntry.ts
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import {
  SANDCASTLE_STATUS_SCHEMA_VERSION,
  SandcastleStatusSnapshot,
  type SandcastleStatusEntry,
} from "@t3tools/contracts";

const decodeSnapshot = Schema.decodeUnknownEither(SandcastleStatusSnapshot);

export interface BuildStatusEntryInput {
  readonly cwd: string;
  readonly hasSandcastleDir: boolean;
  /** Raw contents of <cwd>/.sandcastle/status.json, or null if missing/unreadable. */
  readonly rawJson: string | null;
}

/**
 * Pure: turn raw filesystem facts into a SandcastleStatusEntry. Never throws.
 * Order: not-enabled → no-run → parse → version-peek → decode.
 */
export function buildStatusEntry(input: BuildStatusEntryInput): SandcastleStatusEntry {
  const base = {
    cwd: input.cwd,
    hasSandcastleDir: input.hasSandcastleDir,
    snapshot: null,
    schemaOutdated: false,
    readError: null,
  } satisfies SandcastleStatusEntry;

  if (!input.hasSandcastleDir) return base;
  if (input.rawJson === null) return base; // enabled, no run yet

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJson);
  } catch (err) {
    return { ...base, readError: `Invalid JSON: ${(err as Error).message}` };
  }

  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version === "number" && version !== SANDCASTLE_STATUS_SCHEMA_VERSION) {
    return { ...base, schemaOutdated: true };
  }

  const decoded = decodeSnapshot(parsed);
  if (Either.isLeft(decoded)) {
    return { ...base, readError: "status.json did not match the expected shape" };
  }
  return { ...base, snapshot: decoded.right };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/server/src/sandcastle/buildStatusEntry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandcastle/buildStatusEntry.ts apps/server/src/sandcastle/buildStatusEntry.test.ts
git commit -m "feat(sandcastle): pure buildStatusEntry parser with version + shape guards"
```

---

## Task 4: Server — `SandcastleStatusReader` service

**Files:**
- Create: `apps/server/src/sandcastle/SandcastleStatusReader.ts`

IO shell around `buildStatusEntry`. Mirrors the service/Layer idiom from `apps/server/src/devServer/DevServerRunner.ts` (`Context.Service` class + `Layer.effect(Tag, makeFn)`; missing-file reads via `Effect.orElseSucceed`). Verified by typecheck + the consuming handler in Task 5; the parsing logic itself is already covered by Task 3.

- [ ] **Step 1: Write the service**

```typescript
// apps/server/src/sandcastle/SandcastleStatusReader.ts
/**
 * SandcastleStatusReader — reads <cwd>/.sandcastle/status.json for a set of
 * project cwds on THIS environment's machine and returns parsed entries plus
 * the reading server's clock. Read-only; never writes. Mirrors the service
 * shape of devServer/DevServerRunner.ts.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type {
  SandcastleStatusAllPayload,
  SandcastleStatusAllResult,
  SandcastleStatusEntry,
} from "@t3tools/contracts";
import { SandcastleError } from "@t3tools/contracts";
import { buildStatusEntry } from "./buildStatusEntry.ts";

export interface SandcastleStatusReaderShape {
  statusAll(
    payload: SandcastleStatusAllPayload,
  ): Effect.Effect<SandcastleStatusAllResult, SandcastleError>;
}

export class SandcastleStatusReader extends Context.Service<
  SandcastleStatusReader,
  SandcastleStatusReaderShape
>()("t3/sandcastle/SandcastleStatusReader") {}

/** Absolute paths for a project's Sandcastle dir + status file. */
export function sandcastleDir(cwd: string): string {
  return `${cwd}/.sandcastle`;
}
export function sandcastleStatusPath(cwd: string): string {
  return `${sandcastleDir(cwd)}/status.json`;
}

const makeReader = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const readOne = (cwd: string): Effect.Effect<SandcastleStatusEntry> =>
    Effect.gen(function* () {
      const hasSandcastleDir = yield* fileSystem
        .exists(sandcastleDir(cwd))
        .pipe(Effect.orElseSucceed(() => false));

      const rawJson = hasSandcastleDir
        ? yield* fileSystem
            .readFileString(sandcastleStatusPath(cwd))
            .pipe(Effect.map((s): string | null => s), Effect.orElseSucceed(() => null))
        : null;

      return buildStatusEntry({ cwd, hasSandcastleDir, rawJson });
    });

  const statusAll = (
    payload: SandcastleStatusAllPayload,
  ): Effect.Effect<SandcastleStatusAllResult, SandcastleError> =>
    Effect.gen(function* () {
      const entries = yield* Effect.forEach(payload.cwds, readOne, {
        concurrency: 8,
      });
      const nowMs = yield* Clock.currentTimeMillis;
      return {
        serverNow: new Date(nowMs).toISOString(),
        entries,
      };
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(new SandcastleError({ message: String(cause) })),
      ),
    );

  return { statusAll } satisfies SandcastleStatusReaderShape;
});

export const SandcastleStatusReaderLive = Layer.effect(
  SandcastleStatusReader,
  makeReader,
);
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc -p apps/server --noEmit` (or the repo's server typecheck script)
Expected: no errors in the new file. (`fileSystem.exists`/`readFileString` come from `effect/FileSystem`, provided to the server runtime in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/sandcastle/SandcastleStatusReader.ts
git commit -m "feat(sandcastle): SandcastleStatusReader service (reads status.json, stamps serverNow)"
```

---

## Task 5: Server — register layer + wire RPC handler

**Files:**
- Modify: `apps/server/src/server.ts` (import + provide the layer)
- Modify: `apps/server/src/ws.ts` (auth scope, pull service, handler)

Mirrors dev-server: `server.ts` provides `DevServerRunnerLayerLive` via `Layer.provideMerge` (~line 262); `ws.ts` registers `[WS_METHODS.devServerStart, AuthTerminalOperateScope]` (~234), pulls `const devServerRunner = yield* DevServerRunner` (~318), and handles each method with `observeRpcEffect` (~1418).

- [ ] **Step 1: Provide the layer in server.ts**

Add the import next to `import { DevServerRunnerLive } from "./devServer/DevServerRunner.ts";`:

```typescript
import { SandcastleStatusReaderLive } from "./sandcastle/SandcastleStatusReader.ts";
```

`SandcastleStatusReaderLive` only needs `FileSystem.FileSystem` (provided by `PlatformServicesLive`, same as DevServerRunner relies on). Add it to the runtime composition right next to the dev-server merge (~line 262), in the same `RuntimeCoreDependenciesLive` block:

```typescript
  Layer.provideMerge(SandcastleStatusReaderLive),
```

- [ ] **Step 2: Register the auth scope in ws.ts**

In the auth-scope array (next to the four `devServer*` entries ~line 234-237):

```typescript
[WS_METHODS.sandcastleStatusAll, AuthTerminalOperateScope],
```

- [ ] **Step 3: Pull the service in the handler-building Effect.gen**

Next to `const devServerRunner = yield* DevServerRunner;` (~line 318), and add the import at the top of ws.ts alongside the DevServerRunner import:

```typescript
import { SandcastleStatusReader } from "./sandcastle/SandcastleStatusReader.ts";
```

```typescript
      const sandcastleStatusReader = yield* SandcastleStatusReader;
```

Also import the error type used in mapError — add to the `@t3tools/contracts` import group in ws.ts (next to `DevServerError`):

```typescript
import { SandcastleError } from "@t3tools/contracts";
```

- [ ] **Step 4: Add the handler**

In the handlers object, next to the `[WS_METHODS.devServerLogs]: …` entry (~line 1473):

```typescript
[WS_METHODS.sandcastleStatusAll]: (input) =>
  observeRpcEffect(
    WS_METHODS.sandcastleStatusAll,
    sandcastleStatusReader.statusAll(input).pipe(
      Effect.mapError((cause) => new SandcastleError({ message: cause.message })),
    ),
    { "rpc.aggregate": "sandcastle" },
  ),
```

- [ ] **Step 5: Typecheck the server**

Run: `bunx tsc -p apps/server --noEmit`
Expected: no errors. If a stale-`.tsbuildinfo` phantom appears after parallel work, re-run once clean before trusting.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/ws.ts
git commit -m "feat(sandcastle): register reader layer + statusAll WS handler"
```

---

## Task 6: Client runtime + environmentApi wiring

**Files:**
- Modify: `packages/client-runtime/src/wsRpcClient.ts` (type block + impl block)
- Modify: `apps/web/src/environmentApi.ts` (sandcastle block)

Mirrors dev-server (wsRpcClient.ts type ~174-179 + impl ~376-385; environmentApi.ts ~66-71).

- [ ] **Step 1: Add the type declaration in wsRpcClient.ts**

Next to the `readonly devServer: { … }` type block:

```typescript
  readonly sandcastle: {
    readonly statusAll: RpcUnaryMethod<typeof WS_METHODS.sandcastleStatusAll>;
  };
```

- [ ] **Step 2: Add the implementation block in wsRpcClient.ts**

Next to the `devServer: { … }` impl block:

```typescript
  sandcastle: {
    statusAll: (input) =>
      transport.request((client) => client[WS_METHODS.sandcastleStatusAll](input)),
  },
```

- [ ] **Step 3: Add the sandcastle block in environmentApi.ts**

Inside `createEnvironmentApi`, next to the `devServer: { … }` block:

```typescript
    sandcastle: {
      statusAll: (input) => rpcClient.sandcastle.statusAll(input as never),
    },
```

- [ ] **Step 4: Typecheck both packages**

Run: `bunx tsc -p packages/client-runtime --noEmit && bunx tsc -p apps/web --noEmit`
Expected: no errors related to these files.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/wsRpcClient.ts apps/web/src/environmentApi.ts
git commit -m "feat(sandcastle): expose statusAll on wsRpcClient + environmentApi"
```

---

## Task 7: Web — pure view helpers `sandcastleView.ts`

**Files:**
- Create: `apps/web/src/components/sandcastle/sandcastleView.ts`
- Test: `apps/web/src/components/sandcastle/sandcastleView.test.ts`

Pure, plain-vitest. Encapsulates the viewer's display logic (ported from the terminal viewer's reducer/banner rules) so components stay dumb.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/sandcastle/sandcastleView.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveBanner,
  isStale,
  githubIssueUrl,
  phaseLabel,
  STALE_AFTER_MS,
} from "./sandcastleView.ts";
import type { SandcastleStatusEntry } from "@t3tools/contracts";

function entry(over: Partial<SandcastleStatusEntry>): SandcastleStatusEntry {
  return {
    cwd: "/p",
    hasSandcastleDir: true,
    snapshot: null,
    schemaOutdated: false,
    readError: null,
    ...over,
  };
}

const runningSnapshot = {
  schemaVersion: 1,
  state: "running" as const,
  run: { branch: "b", repo: "r", startedAt: "x", iterations: { current: 1, total: 9 }, maxConcurrent: 1 },
  totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
  issues: [],
  updatedAt: "2026-06-04T12:00:00.000Z",
};

describe("isStale", () => {
  it("is false within the window", () => {
    const now = new Date("2026-06-04T12:01:00.000Z").toISOString();
    expect(isStale(runningSnapshot.updatedAt, now)).toBe(false);
  });
  it("is true past the window", () => {
    const now = new Date(Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000).toISOString();
    expect(isStale(runningSnapshot.updatedAt, now)).toBe(true);
  });
});

describe("deriveBanner", () => {
  const now = "2026-06-04T12:00:30.000Z";
  it("waiting when enabled but no snapshot", () => {
    expect(deriveBanner(entry({ snapshot: null }), now).kind).toBe("waiting");
  });
  it("outdated wins", () => {
    expect(deriveBanner(entry({ schemaOutdated: true }), now).kind).toBe("outdated");
  });
  it("error when readError present", () => {
    expect(deriveBanner(entry({ readError: "boom" }), now).kind).toBe("error");
  });
  it("live when running and fresh", () => {
    expect(deriveBanner(entry({ snapshot: runningSnapshot }), now).kind).toBe("live");
  });
  it("stale when running and old", () => {
    const late = new Date(Date.parse(runningSnapshot.updatedAt) + STALE_AFTER_MS + 1000).toISOString();
    expect(deriveBanner(entry({ snapshot: runningSnapshot }), late).kind).toBe("stale");
  });
  it("done state", () => {
    expect(deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "done" } }), now).kind).toBe("done");
  });
  it("stopped state", () => {
    expect(deriveBanner(entry({ snapshot: { ...runningSnapshot, state: "stopped" } }), now).kind).toBe("stopped");
  });
});

describe("githubIssueUrl", () => {
  it("builds from owner+name", () => {
    expect(
      githubIssueUrl({ owner: "acme", name: "widgets" } as never, 42),
    ).toBe("https://github.com/acme/widgets/issues/42");
  });
  it("falls back to remoteUrl parsing", () => {
    expect(
      githubIssueUrl(
        { locator: { remoteUrl: "git@github.com:acme/widgets.git" } } as never,
        7,
      ),
    ).toBe("https://github.com/acme/widgets/issues/7");
  });
  it("returns null when nothing usable", () => {
    expect(githubIssueUrl(null, 1)).toBeNull();
    expect(githubIssueUrl({} as never, 1)).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("humanizes phases", () => {
    expect(phaseLabel("implementer-retry")).toBe("Retry");
    expect(phaseLabel("needs-human")).toBe("Needs you");
    expect(phaseLabel("merged")).toBe("Merged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/web/src/components/sandcastle/sandcastleView.test.ts`
Expected: FAIL — cannot resolve `./sandcastleView.ts`.

- [ ] **Step 3: Write the helpers**

```typescript
// apps/web/src/components/sandcastle/sandcastleView.ts
import type {
  SandcastleIssuePhase,
  SandcastleStatusEntry,
} from "@t3tools/contracts";
import type { RepositoryIdentity } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

/** A snapshot older than this (vs the reading server's clock) reads as stale. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

export type BannerKind =
  | "waiting" // enabled, no status.json yet
  | "live" // running, fresh
  | "stale" // running, no update within STALE_AFTER_MS
  | "done"
  | "stopped"
  | "outdated" // schemaVersion mismatch
  | "error"; // read/parse failure

export interface Banner {
  readonly kind: BannerKind;
  readonly text: string;
}

export function isStale(updatedAtIso: string, serverNowIso: string): boolean {
  const updated = Date.parse(updatedAtIso);
  const now = Date.parse(serverNowIso);
  if (Number.isNaN(updated) || Number.isNaN(now)) return false;
  return now - updated > STALE_AFTER_MS;
}

export function deriveBanner(entry: SandcastleStatusEntry, serverNowIso: string): Banner {
  if (entry.readError) return { kind: "error", text: "Couldn't read status" };
  if (entry.schemaOutdated) return { kind: "outdated", text: "Viewer out of date — update t3" };
  const snap = entry.snapshot;
  if (!snap) return { kind: "waiting", text: "No run yet" };

  switch (snap.state) {
    case "done":
      return { kind: "done", text: "Done" };
    case "stopped":
      return { kind: "stopped", text: "Stopped" };
    case "running":
    case "restarting":
      return isStale(snap.updatedAt, serverNowIso)
        ? { kind: "stale", text: "Stale — loop may have stopped" }
        : { kind: "live", text: "Live" };
  }
}

/** Build a GitHub issue deep-link from the t3 project's repo identity. */
export function githubIssueUrl(
  identity: RepositoryIdentity | null | undefined,
  issueNumber: number,
): string | null {
  if (!identity) return null;
  const fromParts =
    identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
  const slug =
    fromParts ??
    parseGitHubRepositoryNameWithOwnerFromRemoteUrl(identity.locator?.remoteUrl ?? null);
  if (!slug) return null;
  return `https://github.com/${slug}/issues/${issueNumber}`;
}

const PHASE_LABELS: Record<SandcastleIssuePhase, string> = {
  planned: "Planned",
  implementer: "Implementing",
  reviewer: "Reviewing",
  "implementer-retry": "Retry",
  recovery: "Recovery",
  merge: "Merging",
  merged: "Merged",
  "needs-human": "Needs you",
  deferred: "Deferred",
};

export function phaseLabel(phase: SandcastleIssuePhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** Badge variant for a banner kind — maps to ui/badge.tsx variants. */
export function bannerTone(
  kind: BannerKind,
): "success" | "warning" | "error" | "info" | "secondary" {
  switch (kind) {
    case "live":
      return "success";
    case "stale":
    case "outdated":
      return "warning";
    case "error":
      return "error";
    case "done":
      return "info";
    case "stopped":
    case "waiting":
      return "secondary";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/web/src/components/sandcastle/sandcastleView.test.ts`
Expected: PASS. (If `@t3tools/shared/git` is not a resolvable subpath export, import from the package's git module per the repo's export map — verify with `rg "parseGitHubRepositoryNameWithOwnerFromRemoteUrl" packages/shared` and match an existing import site.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sandcastle/sandcastleView.ts apps/web/src/components/sandcastle/sandcastleView.test.ts
git commit -m "feat(sandcastle): pure web view helpers (banner, staleness, github url, phase)"
```

---

## Task 8: Web — polling hook `useSandcastleStatuses`

**Files:**
- Create: `apps/web/src/components/sandcastle/useSandcastleStatuses.ts`

Groups projects by environment, polls each environment's `sandcastle.statusAll` every 2s, merges into a map keyed by `${environmentId}::${cwd}`. No new test (thin glue over the typed api + verified helpers; covered by live verify in Task 13).

- [ ] **Step 1: Write the hook**

```typescript
// apps/web/src/components/sandcastle/useSandcastleStatuses.ts
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SandcastleStatusEntry } from "@t3tools/contracts";
import { readEnvironmentApi } from "../../environmentApi.ts";

const POLL_MS = 2000;

export interface SandcastleStatusValue {
  readonly environmentId: EnvironmentId;
  readonly entry: SandcastleStatusEntry;
  readonly serverNow: string;
}

/** key = `${environmentId}::${cwd}` */
export type SandcastleStatusMap = ReadonlyMap<string, SandcastleStatusValue>;

export function statusKey(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}::${cwd}`;
}

export interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function useSandcastleStatuses(projects: ReadonlyArray<ProjectRef>): SandcastleStatusMap {
  const [map, setMap] = useState<SandcastleStatusMap>(new Map());

  // Group cwds by environment; serialize so the effect only re-subscribes when
  // the actual set changes (not on every render's new array identity).
  const grouped = new Map<EnvironmentId, string[]>();
  for (const p of projects) {
    const list = grouped.get(p.environmentId) ?? [];
    list.push(p.cwd);
    grouped.set(p.environmentId, list);
  }
  const signature = JSON.stringify(
    [...grouped.entries()].map(([env, cwds]) => [env, [...cwds].sort()]).sort(),
  );

  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const pollOnce = () => {
      for (const [environmentId, cwds] of grouped.entries()) {
        const api = readEnvironmentApi(environmentId);
        if (!api) continue;
        void api.sandcastle
          .statusAll({ cwds })
          .then((res) => {
            if (cancelledRef.current) return;
            setMap((prev) => {
              const next = new Map(prev);
              for (const entry of res.entries) {
                next.set(statusKey(environmentId, entry.cwd), {
                  environmentId,
                  entry,
                  serverNow: res.serverNow,
                });
              }
              return next;
            });
          })
          .catch(() => undefined);
      }
    };

    pollOnce();
    const id = window.setInterval(pollOnce, POLL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
    // grouped is derived from `signature`; re-run only when the set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return map;
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc -p apps/web --noEmit`
Expected: no errors in the new file. (`EnvironmentId` is exported from `@t3tools/contracts`; if the web app re-exports it elsewhere — check an existing component's import — match that import site.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/sandcastle/useSandcastleStatuses.ts
git commit -m "feat(sandcastle): useSandcastleStatuses polling hook (per-env, merged)"
```

---

## Task 9: Web — dashboard component + routes

**Files:**
- Create: `apps/web/src/components/sandcastle/SandcastleDashboard.tsx`
- Create: `apps/web/src/routes/sandcastle.tsx` (layout + auth guard)
- Create: `apps/web/src/routes/sandcastle.index.tsx` (dashboard)

Route layout mirrors `routes/settings.tsx` (`createFileRoute` + `beforeLoad` auth redirect + a layout component rendering `<Outlet/>`). The TanStack route tree is generated by the vite plugin on dev/build; if the repo commits `routeTree.gen.ts`, regenerate it (the dev server / `bun run build` does this automatically).

- [ ] **Step 1: Write the dashboard component**

```tsx
// apps/web/src/components/sandcastle/SandcastleDashboard.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import {
  useSandcastleStatuses,
  statusKey,
  type ProjectRef,
} from "./useSandcastleStatuses.ts";
import { deriveBanner, bannerTone } from "./sandcastleView.ts";

function EnvLabel({ environmentId }: { environmentId: string }) {
  const label = useSavedEnvironmentRegistryStore(
    (s) => s.byId[environmentId]?.label ?? "Local",
  );
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

export function SandcastleDashboard() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const refs = useMemo<ProjectRef[]>(
    () => projects.map((p) => ({ environmentId: p.environmentId, cwd: p.cwd })),
    [projects],
  );
  const statuses = useSandcastleStatuses(refs);

  // Only show Sandcastle-enabled projects (those with a .sandcastle/ dir).
  const rows = projects
    .map((p) => ({ project: p, value: statuses.get(statusKey(p.environmentId, p.cwd)) }))
    .filter((r) => r.value?.entry.hasSandcastleDir);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Sandcastle</h1>
        <span className="text-xs text-muted-foreground">
          {rows.length} project{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Sandcastle runs found. Projects appear here once they have a
          <code className="mx-1 rounded bg-muted px-1 py-0.5">.sandcastle/</code>
          directory.
        </p>
      ) : (
        <div className="grid gap-3">
          {rows.map(({ project, value }) => {
            const entry = value!.entry;
            const banner = deriveBanner(entry, value!.serverNow);
            const snap = entry.snapshot;
            return (
              <Link
                key={`${project.environmentId}-${project.id}`}
                to="/sandcastle/$environmentId/$projectId"
                params={{ environmentId: project.environmentId, projectId: project.id }}
                className="block outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
              >
                <Card className="flex-row items-center justify-between gap-4 p-4 transition-colors hover:bg-accent/40">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                      <EnvLabel environmentId={project.environmentId} />
                    </div>
                    {snap ? (
                      <span className="truncate text-xs text-muted-foreground">
                        iter {snap.run.iterations.current}/{snap.run.iterations.total} ·{" "}
                        {snap.run.branch}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {snap ? (
                      <>
                        <Badge variant="info" size="sm">▶ {snap.totals.running}</Badge>
                        <Badge variant="success" size="sm">✓ {snap.totals.merged}</Badge>
                        <Badge variant="warning" size="sm">⚠ {snap.totals.needsHuman}</Badge>
                      </>
                    ) : null}
                    <Badge variant={bannerTone(banner.kind)} size="sm">{banner.text}</Badge>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the layout route (auth guard)**

```tsx
// apps/web/src/routes/sandcastle.tsx
import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sandcastle")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <Outlet />,
});
```

- [ ] **Step 3: Write the index route**

```tsx
// apps/web/src/routes/sandcastle.index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { SandcastleDashboard } from "../components/sandcastle/SandcastleDashboard.tsx";

export const Route = createFileRoute("/sandcastle/")({
  component: SandcastleDashboard,
});
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc -p apps/web --noEmit`
Expected: no errors. (Confirm the `Card` accepts `flex-row` overrides; if `selectProjectsAcrossEnvironments` is exported from a different module than `store.ts`, match the export site found by `rg "export function selectProjectsAcrossEnvironments"`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sandcastle/SandcastleDashboard.tsx apps/web/src/routes/sandcastle.tsx apps/web/src/routes/sandcastle.index.tsx
git commit -m "feat(sandcastle): dashboard route listing runs across environments"
```

---

## Task 10: Web — per-project detail component + route

**Files:**
- Create: `apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx`
- Create: `apps/web/src/routes/sandcastle.$environmentId.$projectId.tsx`

- [ ] **Step 1: Write the detail component**

```tsx
// apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useStore, selectProjectsAcrossEnvironments } from "../../store.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import {
  useSandcastleStatuses,
  statusKey,
  type ProjectRef,
} from "./useSandcastleStatuses.ts";
import {
  deriveBanner,
  bannerTone,
  phaseLabel,
  githubIssueUrl,
} from "./sandcastleView.ts";

export function SandcastleProjectDetail({
  environmentId,
  projectId,
}: {
  environmentId: string;
  projectId: string;
}) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const project = projects.find(
    (p) => p.environmentId === environmentId && p.id === projectId,
  );

  const refs = useMemo<ProjectRef[]>(
    () => (project ? [{ environmentId: project.environmentId, cwd: project.cwd }] : []),
    [project],
  );
  const statuses = useSandcastleStatuses(refs);

  if (!project) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Project not found. <Link to="/sandcastle" className="underline">Back to dashboard</Link>
      </div>
    );
  }

  const value = statuses.get(statusKey(project.environmentId, project.cwd));
  const entry = value?.entry;
  const banner = entry ? deriveBanner(entry, value!.serverNow) : null;
  const snap = entry?.snapshot ?? null;

  const active = snap ? snap.issues.filter((i) => i.phase !== "merged" && i.phase !== "needs-human" && i.phase !== "deferred") : [];
  const recent = snap ? snap.issues.filter((i) => i.phase === "merged" || i.phase === "needs-human" || i.phase === "deferred") : [];

  const issueLink = (n: number) => githubIssueUrl(project.repositoryIdentity ?? null, n);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <header className="flex items-center gap-3">
        <Link to="/sandcastle" className="text-sm text-muted-foreground underline">← Sandcastle</Link>
        <h1 className="text-lg font-semibold">{project.name}</h1>
        {banner ? <Badge variant={bannerTone(banner.kind)} size="sm">{banner.text}</Badge> : null}
      </header>

      {!snap ? (
        <p className="text-sm text-muted-foreground">{banner?.text ?? "No run data."}</p>
      ) : (
        <>
          <Card className="flex-row flex-wrap items-center gap-3 p-4 text-sm">
            <span className="text-muted-foreground">
              iter {snap.run.iterations.current}/{snap.run.iterations.total}
            </span>
            <span className="text-muted-foreground">{snap.run.branch}</span>
            {snap.activity ? <Badge variant="info" size="sm">{snap.activity}…</Badge> : null}
            <div className="ms-auto flex gap-2">
              <Badge variant="success" size="sm">✓ {snap.totals.merged} merged</Badge>
              <Badge variant="warning" size="sm">⚠ {snap.totals.needsHuman} needs you</Badge>
              <Badge variant="secondary" size="sm">↻ {snap.totals.requeued} requeued</Badge>
              <Badge variant="info" size="sm">▶ {snap.totals.running} running</Badge>
            </div>
          </Card>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Active</h2>
            {active.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active issues.</p>
            ) : (
              active.map((i) => {
                const href = issueLink(i.number);
                return (
                  <Card key={i.number} className="flex-row items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer" className="text-sm font-medium underline">
                            #{i.number}
                          </a>
                        ) : (
                          <span className="text-sm font-medium">#{i.number}</span>
                        )}
                        <span className="truncate text-sm">{i.title}</span>
                      </div>
                      {i.detail ? <span className="text-xs text-muted-foreground">{i.detail}</span> : null}
                    </div>
                    <Badge variant={i.attention ? "warning" : "secondary"} size="sm">
                      {phaseLabel(i.phase)}
                    </Badge>
                  </Card>
                );
              })
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Recent</h2>
            {recent.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing finished yet.</p>
            ) : (
              recent.map((i) => {
                const href = issueLink(i.number);
                return (
                  <div key={i.number} className="flex items-center justify-between gap-3 px-1 py-1 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="font-medium underline">#{i.number}</a>
                      ) : (
                        <span className="font-medium">#{i.number}</span>
                      )}
                      <span className="truncate text-muted-foreground">{i.title}</span>
                    </div>
                    <Badge variant="secondary" size="sm">{phaseLabel(i.phase)}</Badge>
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the detail route**

```tsx
// apps/web/src/routes/sandcastle.$environmentId.$projectId.tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { SandcastleProjectDetail } from "../components/sandcastle/SandcastleProjectDetail.tsx";

export const Route = createFileRoute("/sandcastle/$environmentId/$projectId")({
  component: function SandcastleDetailRoute() {
    const { environmentId, projectId } = useParams({
      from: "/sandcastle/$environmentId/$projectId",
    });
    return <SandcastleProjectDetail environmentId={environmentId} projectId={projectId} />;
  },
});
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc -p apps/web --noEmit`
Expected: no errors. (Confirm `project.repositoryIdentity` is the field name on the web `Project` type — `apps/web/src/types.ts:84`. Confirm `Project` exposes `id`, `name`, `cwd`, `environmentId`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/sandcastle/SandcastleProjectDetail.tsx "apps/web/src/routes/sandcastle.\$environmentId.\$projectId.tsx"
git commit -m "feat(sandcastle): per-project detail route (active/recent issues + github links)"
```

---

## Task 11: Web — sidebar nav entry

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`

Add a top-level link to `/sandcastle`. Place it adjacent to the existing "Go to threads" wordmark `Link` (~Sidebar.tsx:2537) — find that block and add a sibling nav link. Use a lucide icon already imported in the file if available (e.g. `LayoutDashboardIcon`); otherwise import one.

- [ ] **Step 1: Ensure an icon import exists**

At the top of `Sidebar.tsx`, in the `lucide-react` import group, add (only if not already imported):

```typescript
import { CastleIcon } from "lucide-react";
```

(If `CastleIcon` isn't available in the installed lucide version, use `LayoutDashboardIcon` or `BoxesIcon` — confirm by checking another lucide import in the repo.)

- [ ] **Step 2: Add the nav link**

Next to the existing `<Link ... to="/">` wordmark block (~line 2537), add:

```tsx
<Link
  aria-label="Sandcastle"
  title="Sandcastle"
  to="/sandcastle"
  className="flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
>
  <CastleIcon className="size-4 shrink-0" />
  <span className="truncate">Sandcastle</span>
</Link>
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc -p apps/web --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(sandcastle): add Sandcastle entry to the left sidebar"
```

---

## Task 12: Full verification + lint

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suites**

Run: `bun run vitest run packages/contracts apps/server apps/web`
Expected: all green, including the new Task 1/3/7 tests. Note the prior server suite baseline (~1155 passing) plus the new tests.

- [ ] **Step 2: Typecheck the whole repo**

Run: `bun run typecheck` (or the repo's root typecheck script)
Expected: no errors. If a phantom `.tsbuildinfo` race error appears right after parallel runs, re-run once clean before trusting it.

- [ ] **Step 3: Lint the touched files**

Run: `bunx oxlint apps/server/src/sandcastle apps/web/src/components/sandcastle packages/contracts/src/sandcastle.ts`
Expected: 0 errors. (Repo-wide `oxfmt`/`bun fmt:check` has pre-existing drift on ~35 files — do NOT reformat unrelated files; only ensure the new files are clean.)

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(sandcastle): lint fixes for new files" || echo "nothing to commit"
```

---

## Task 13: Deploy + live verification

**Files:** none (deploy + manual verify). Uses the `verify` skill for the browser pass.

- [ ] **Step 1: Push the branch**

```bash
git push origin custom
```

- [ ] **Step 2: Deploy to the VPS**

Run: `bun run deploy`
Expected: full dist shipped, smoke test passes, swap-by-rename succeeds, a `dist.bak-*` rollback dir is reported. (Auto-deploy is OFF, so this explicit deploy is required for the VPS to get the feature.)

- [ ] **Step 3: Start the local dev/app and open the Sandcastle view**

Use the `verify` skill (or `run` skill) to launch the app and:
- Confirm the **Sandcastle** entry appears in the left sidebar and navigates to `/sandcastle`.
- Confirm the dashboard lists Sandcastle-enabled projects from BOTH environments (local Mac + VPS), each tagged with its environment label.
- For a project with a live `status.json`, confirm counts (▶ ✓ ⚠) and the banner (Live/Stale/Done) render, and that they refresh (~2s poll) without full-page reload.
- Click a row → detail view shows run header, Active and Recent issues with phases, and issue numbers link to GitHub.
- Confirm a project whose Sandcastle `schemaVersion` you bump (or simulate) shows the **outdated** banner rather than crashing.
- Confirm a project with no `.sandcastle/` dir does NOT appear.

- [ ] **Step 4: Capture evidence + report**

Note pass/fail per bullet with a screenshot. If anything fails, fix test-first and re-deploy. Do NOT claim completion without observing the live behavior.

---

## Self-Review (run before handing off to execution)

**Spec coverage check:**
- All-projects dashboard → Task 9 ✓
- Per-project drill-down detail → Task 10 ✓
- Dedicated sidebar view → Tasks 9 (routes) + 11 (nav) ✓
- Spans Mac + VPS, merged, env-tagged → Task 8 (per-env poll) + Task 9 (`EnvLabel`) ✓
- Read file → unary RPC → web polls (mirror dev-server) → Tasks 1–6, 8 ✓
- Read-only, no writes → server service only reads; no write paths anywhere ✓
- GitHub issue links → Task 7 `githubIssueUrl` + Task 10 usage ✓
- Liveness (stale/done/stopped/outdated/waiting) → Task 7 `deriveBanner` ✓ (ported from terminal viewer rules)
- Out of scope (notifications, loop controls) → not present ✓
- New files only / fork hygiene → all logic in new files; existing-file edits are additive registry/route/sidebar/layer wiring ✓

**Placeholder scan:** no TBD/TODO; every code step has complete code; every test step has assertions.

**Type consistency:** `SandcastleStatusEntry` fields (`cwd`, `hasSandcastleDir`, `snapshot`, `schemaOutdated`, `readError`) identical across Task 1 (schema), Task 3 (builder), Task 7 (helpers), Tasks 9/10 (UI). `statusKey(environmentId, cwd)` defined once (Task 8) and reused. `deriveBanner(entry, serverNowIso)` / `bannerTone(kind)` / `phaseLabel(phase)` / `githubIssueUrl(identity, n)` signatures consistent between Task 7 definition and Task 10 usage. RPC name `sandcastle.statusAll` consistent across contract, rpc.ts, ws.ts, wsRpcClient.ts, environmentApi.ts.

**Known verify-on-execution points (not blockers, just confirm against the live tree):**
- `@t3tools/shared/git` subpath export for `parseGitHubRepositoryNameWithOwnerFromRemoteUrl` (Task 7).
- `EnvironmentId` import source for web (Task 8).
- `selectProjectsAcrossEnvironments` export module (Tasks 9/10).
- Auth scope name `AuthTerminalOperateScope` is reused for the read-only method (Task 5) — swap to a narrower read scope only if one already exists.
- Exact insertion point of the sidebar `Link` (Task 11).
