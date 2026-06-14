/**
 * Tests for DevServerRunner.
 *
 * Uses a fake PtyAdapter whose spawn() returns a stub PtyProcess you can
 * drive from outside.
 *
 * Key design: instead of needing concurrent fibers to push data, the stub
 * emits URL data synchronously when the first onData listener is registered.
 * This makes all tests fully sequential and avoids complex fiber scheduling.
 *
 * IMPORTANT: All tests use `it.effect` — bare `it(() => Effect.gen(...))` is
 * vacuous in this repo (passes without running the effect body).
 */
import { it, describe, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import type { DevServerPayload } from "@t3tools/contracts";
import { DevServerError } from "@t3tools/contracts";
import { PtyAdapter } from "../terminal/Services/PTY.ts";
import type { PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import type { PtySpawnError } from "../terminal/Services/PTY.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import {
  DevServerRunner,
  DevServerRunnerLive,
  stripAnsi,
  extractUrl,
  resolveCwd,
  devServerLogPath,
  waitUntilReady,
  makeHttpProbe,
  teeProcessOutput,
  type ReadyProbe,
} from "./DevServerRunner.ts";
import { DEV_STOP_CMD, DEV_START_CMD } from "./devServerCommands.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

// ---------------------------------------------------------------------------
// Fake PTY infrastructure
// ---------------------------------------------------------------------------

interface StubPtyProcess extends PtyProcess {
  pushData(data: string): void;
  triggerExit(exitCode: number, signal?: number | null): void;
  spawnedArgs: string[];
}

type StubMode =
  | { kind: "url"; url: string }           // emit URL on first onData subscription
  | { kind: "exit"; code: number }          // exit immediately on onExit subscription
  | { kind: "manual" }                      // manual control (for stop-command stubs)
  | { kind: "controlled"; deferred: Array<{ data?: string; exit?: number }> };

function makeStubProcess(spawnedArgs: string[], mode: StubMode = { kind: "manual" }): StubPtyProcess {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal: number | null }) => void> = [];

  const stub: StubPtyProcess = {
    pid: 12345,
    spawnedArgs,

    write(_data) { /* no-op */ },
    resize(_cols, _rows) { /* no-op */ },
    kill(_signal) { /* no-op */ },

    onData(cb) {
      dataListeners.push(cb);
      // If in url mode, emit the configured URL synchronously now
      if (mode.kind === "url") {
        cb(`- Local: ${mode.url}\n`);
      }
      return () => {
        const idx = dataListeners.indexOf(cb);
        if (idx !== -1) dataListeners.splice(idx, 1);
      };
    },

    onExit(cb) {
      exitListeners.push(cb);
      if (mode.kind === "exit") {
        cb({ exitCode: mode.code, signal: null });
      }
      return () => {
        const idx = exitListeners.indexOf(cb);
        if (idx !== -1) exitListeners.splice(idx, 1);
      };
    },

    pushData(data) {
      for (const cb of [...dataListeners]) cb(data);
    },

    triggerExit(exitCode, signal = null) {
      for (const cb of [...exitListeners]) cb({ exitCode, signal });
    },
  };

  return stub;
}

type SpawnFactory = (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;

function makeFakePtyLayer(factory: SpawnFactory): Layer.Layer<PtyAdapter> {
  return Layer.succeed(PtyAdapter, PtyAdapter.of({ spawn: factory }));
}

// ---------------------------------------------------------------------------
// Fake ProcessRunner / FileSystem / ServerConfig for detection
// ---------------------------------------------------------------------------

/**
 * Returns a fake ProcessRunner that makes `ss` output return no listeners,
 * so detectListening always resolves to null and the spawn path runs as before.
 */
const NoDetectionProcessRunnerLayer = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  }),
);

/**
 * Noop FileSystem — detectListening never calls readLink when ss returns empty.
 * makeDirectory/writeFileString are no-ops so start()'s logfile tee doesn't die.
 */
const NoopFileSystemLayer = FileSystem.layerNoop({
  makeDirectory: () => Effect.void,
  writeFileString: () => Effect.void,
});

/** Minimal ServerConfig for tests (.host for detect, .logsDir for the logfile). */
const TestServerConfigLayer = Layer.succeed(ServerConfig, {
  host: undefined,
  logsDir: "/tmp/test-logs",
} as ServerConfig["Service"]);

/**
 * A fake HttpClient that answers every request with 200, so start()'s readiness
 * probe resolves immediately in tests (no real dev server is running here).
 */
const HealthyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/**
 * Base detection-suppression layer: combine with PtyAdapter for existing tests.
 * Makes detectListening always return null so spawn tests behave as before.
 */
const DetectionNullLayer = Layer.mergeAll(
  NoDetectionProcessRunnerLayer,
  NoopFileSystemLayer,
  TestServerConfigLayer,
  HealthyHttpClientLayer,
);

// ---------------------------------------------------------------------------
// Shared test payload
// ---------------------------------------------------------------------------

const basePayload: DevServerPayload = {
  threadId: "thread-001" as DevServerPayload["threadId"],
  worktreePath: "/project/worktree",
  projectCwd: "/project",
};

const nullCwdPayload: DevServerPayload = {
  threadId: "thread-null" as DevServerPayload["threadId"],
  worktreePath: null,
  projectCwd: null,
};

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it.effect("strips ANSI colour codes", () =>
    Effect.sync(() => {
      const raw = "\x1b[36mhttp://localhost:4001\x1b[39m";
      expect(stripAnsi(raw)).toBe("http://localhost:4001");
    }),
  );
});

describe("extractUrl", () => {
  it.effect("URL parse: ANSI-wrapped output → correct URL extracted", () =>
    Effect.sync(() => {
      const line = "  - Local: \x1b[36mhttp://100.99.237.12:4001\x1b[39m";
      expect(extractUrl(line)).toBe("http://100.99.237.12:4001");
    }),
  );

  it.effect("returns null when no URL present", () =>
    Effect.sync(() => {
      expect(extractUrl("starting dev server...")).toBeNull();
    }),
  );
});

describe("resolveCwd", () => {
  it.effect("prefers worktreePath over projectCwd", () =>
    Effect.sync(() => {
      expect(resolveCwd(basePayload)).toBe("/project/worktree");
    }),
  );

  it.effect("falls back to projectCwd when worktreePath is null", () =>
    Effect.sync(() => {
      const p: DevServerPayload = { ...basePayload, worktreePath: null };
      expect(resolveCwd(p)).toBe("/project");
    }),
  );

  it.effect("returns null when both are null", () =>
    Effect.sync(() => {
      expect(resolveCwd(nullCwdPayload)).toBeNull();
    }),
  );
});

describe("devServerLogPath", () => {
  it.effect("builds a stable, cwd-specific path under <logsDir>/devserver", () =>
    Effect.sync(() => {
      const p = devServerLogPath("/x/logs", "/home/me/proj");
      expect(p.startsWith("/x/logs/devserver/")).toBe(true);
      expect(p.endsWith(".log")).toBe(true);
      // Stable for the same cwd, distinct for a different cwd.
      expect(devServerLogPath("/x/logs", "/home/me/proj")).toBe(p);
      expect(devServerLogPath("/x/logs", "/home/me/other")).not.toBe(p);
    }),
  );
});

// ---------------------------------------------------------------------------
// Readiness probe (uses it.live for the real clock + a stubbed global fetch)
// ---------------------------------------------------------------------------

describe("waitUntilReady", () => {
  const fastOpts = { totalTimeout: Duration.seconds(2), retryInterval: Duration.millis(10) };

  it.live("resolves true once the probe reports ready", () =>
    Effect.gen(function* () {
      const probe: ReadyProbe = () => Effect.succeed(true);
      const ready = yield* waitUntilReady(probe, "http://x", fastOpts);
      expect(ready).toBe(true);
    }),
  );

  it.live("retries while the probe reports not-ready, then succeeds", () =>
    Effect.gen(function* () {
      let calls = 0;
      const probe: ReadyProbe = () =>
        Effect.sync(() => {
          calls += 1;
          return calls >= 3;
        });
      const ready = yield* waitUntilReady(probe, "http://x", fastOpts);
      expect(ready).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(3);
    }),
  );

  it.live("gives up (false) after the total timeout when never ready", () =>
    Effect.gen(function* () {
      const probe: ReadyProbe = () => Effect.succeed(false);
      const ready = yield* waitUntilReady(probe, "http://x", {
        totalTimeout: Duration.millis(60),
        retryInterval: Duration.millis(10),
      });
      expect(ready).toBe(false);
    }),
  );
});

describe("makeHttpProbe", () => {
  it.live("treats any HTTP response (even non-2xx) as ready", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
      );
      const probe = makeHttpProbe(client, Duration.seconds(1));
      const ready = yield* probe("http://127.0.0.1:65535");
      expect(ready).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("DevServerRunner", () => {
  it.effect("both-null cwd → DevServerError", () => {
    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer(() => Effect.die("should not be called") as never),
          DetectionNullLayer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      const err = yield* runner.start(nullCwdPayload).pipe(Effect.flip);
      expect(err._tag).toBe("DevServerError");
      expect((err as DevServerError).message).toContain("No working directory");
    }).pipe(Effect.provide(layer));
  });

  it.effect("start: URL parsed — ANSI-wrapped output → captures correct URL", () => {
    // Stub emits ANSI-wrapped URL synchronously on onData registration
    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer((input) =>
            Effect.sync(() =>
              makeStubProcess(input.args ?? [], {
                kind: "url",
                url: "http://100.99.237.12:4001",
              }) as PtyProcess,
            ),
          ),
          DetectionNullLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      // The stub emits URL when onData is registered; start() returns synchronously
      const result = yield* runner.start({
        ...basePayload,
        worktreePath: "/ansi-test",
        projectCwd: "/ansi-test",
      });
      expect(result.running).toBe(true);
      expect(result.url).toBe("http://100.99.237.12:4001");
    }).pipe(Effect.provide(layer));
  });

  it.effect("start idempotency: second call returns same url without re-spawning", () => {
    let spawnCount = 0;

    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer((input) =>
            Effect.sync(() => {
              spawnCount++;
              return makeStubProcess(input.args ?? [], {
                kind: "url",
                url: "http://localhost:3000",
              }) as PtyProcess;
            }),
          ),
          DetectionNullLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;

      const result1 = yield* runner.start(basePayload);
      const result2 = yield* runner.start(basePayload);

      expect(result1.url).toBe("http://localhost:3000");
      expect(result2.url).toBe("http://localhost:3000");
      expect(spawnCount).toBe(1); // only one spawn
    }).pipe(Effect.provide(layer));
  });

  it.effect("status reflects running/url after start", () => {
    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer((input) =>
            Effect.sync(() =>
              makeStubProcess(input.args ?? [], {
                kind: "url",
                url: "http://0.0.0.0:5173",
              }) as PtyProcess,
            ),
          ),
          DetectionNullLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;

      const before = yield* runner.status(basePayload);
      expect(before.running).toBe(false);
      expect(before.url).toBeNull();

      yield* runner.start(basePayload);

      const after = yield* runner.status(basePayload);
      expect(after.running).toBe(true);
      expect(after.url).toBe("http://0.0.0.0:5173");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stop: runs DEV_STOP_CMD, kills start process, clears state", () => {
    const seenCommands: string[] = [];

    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer((input) =>
            Effect.sync(() => {
              const args = input.args ?? [];
              const cmd = args[1] ?? "";
              seenCommands.push(cmd);

              if (cmd.includes("pnpm dev")) {
                // Start command: emit URL synchronously
                return makeStubProcess(args, { kind: "url", url: "http://localhost:4321" }) as PtyProcess;
              } else {
                // Stop command: exit immediately
                return makeStubProcess(args, { kind: "exit", code: 0 }) as PtyProcess;
              }
            }),
          ),
          DetectionNullLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;

      yield* runner.start(basePayload);

      const mid = yield* runner.status(basePayload);
      expect(mid.running).toBe(true);

      const stopResult = yield* runner.stop(basePayload);
      expect(stopResult.running).toBe(false);
      expect(stopResult.url).toBeNull();

      const after = yield* runner.status(basePayload);
      expect(after.running).toBe(false);

      expect(seenCommands.some((c) => c.includes(DEV_STOP_CMD))).toBe(true);
      expect(seenCommands.some((c) => c.includes(DEV_START_CMD))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("early exit before URL → DevServerError with reason early-exit", () => {
    // Stub exits immediately (before any URL)
    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.merge(
          makeFakePtyLayer((input) =>
            Effect.sync(() =>
              makeStubProcess(input.args ?? [], { kind: "exit", code: 1 }) as PtyProcess,
            ),
          ),
          DetectionNullLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      const err = yield* runner.start(basePayload).pipe(Effect.flip);
      const devErr = err as Partial<DevServerError> & { _tag?: string };
      expect(devErr._tag).toBe("DevServerError");
      expect(devErr.reason).toBe("early-exit");
    }).pipe(Effect.provide(layer));
  });

  // ---- detection tests -------------------------------------------------------

  it.effect("status: detects an externally started server via detectListening", () => {
    // Fake ss output: one listener on /project/worktree's pid
    const ssOutput =
      "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))";

    const fakeProcessRunner = Layer.succeed(
      ProcessRunner,
      ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: ssOutput,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    );

    const fakeFileSystem = FileSystem.layerNoop({
      readLink: (path) => {
        if (path === "/proc/99001/cwd") return Effect.succeed("/project/worktree");
        return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readLink", pathOrDescriptor: path }));
      },
    });

    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeFakePtyLayer(() => Effect.die("should not be called") as never),
          fakeProcessRunner,
          fakeFileSystem,
          TestServerConfigLayer,
          HealthyHttpClientLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      const result = yield* runner.status(basePayload);
      expect(result.running).toBe(true);
      expect(result.url).toBe("http://100.99.237.12:4001");
    }).pipe(Effect.provide(layer));
  });

  it.effect("start: adopts an externally started server without spawning", () => {
    let spawnCount = 0;

    const ssOutput =
      "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))";

    const fakeProcessRunner = Layer.succeed(
      ProcessRunner,
      ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: ssOutput,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    );

    const fakeFileSystem = FileSystem.layerNoop({
      readLink: (path) => {
        if (path === "/proc/99001/cwd") return Effect.succeed("/project/worktree");
        return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readLink", pathOrDescriptor: path }));
      },
    });

    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeFakePtyLayer((input) =>
            Effect.sync(() => {
              spawnCount++;
              return makeStubProcess(input.args ?? [], { kind: "url", url: "http://wrong:1" }) as PtyProcess;
            }),
          ),
          fakeProcessRunner,
          fakeFileSystem,
          TestServerConfigLayer,
          HealthyHttpClientLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      const result = yield* runner.start(basePayload);
      expect(result.running).toBe(true);
      expect(result.url).toBe("http://100.99.237.12:4001");
      expect(spawnCount).toBe(0); // ADOPT: no spawn
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs: returns the ANSI-stripped tail of the logfile + its path", () => {
    const fakeFileSystem = FileSystem.layerNoop({
      readFileString: () => Effect.succeed("\x1b[36mhello\x1b[39m\nworld\n"),
    });
    const layer = DevServerRunnerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          makeFakePtyLayer(() => Effect.die("should not be called") as never),
          NoDetectionProcessRunnerLayer,
          fakeFileSystem,
          TestServerConfigLayer,
          HealthyHttpClientLayer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* DevServerRunner;
      const result = yield* runner.logs(basePayload);
      expect(result.content).toContain("hello");
      expect(result.content).toContain("world");
      expect(result.content).not.toContain("\x1b");
      expect(result.logPath).toContain("/devserver/");
      expect(result.logPath?.startsWith("/tmp/test-logs/")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// teeProcessOutput — the log tee (ordered single-consumer drain + teardown)
// ---------------------------------------------------------------------------

/**
 * Minimal onData source: lets a test push data synchronously (as the PTY does)
 * and observe whether the unsubscribe handle was actually called.
 */
function makeDataStub() {
  const listeners: Array<(data: string) => void> = [];
  let detached = false;
  const proc: Pick<PtyProcess, "onData"> = {
    onData(cb) {
      listeners.push(cb);
      return () => {
        detached = true;
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
  };
  return {
    proc,
    push: (data: string) => {
      for (const cb of listeners) cb(data);
    },
    get detached() {
      return detached;
    },
  };
}

describe("teeProcessOutput", () => {
  it.effect("ordering: chunks are written in the order onData received them", () =>
    Effect.gen(function* () {
      const src = makeDataStub();
      const writes: string[] = [];
      const appendChunk = (_path: string, data: string) =>
        Effect.sync(() => {
          writes.push(data);
        });
      const runFork = Effect.runForkWith(yield* Effect.context<never>());

      const tee = yield* teeProcessOutput({ proc: src.proc, logPath: "/x.log", appendChunk, runFork });
      src.push("a");
      src.push("b");
      src.push("c");
      yield* tee.shutdown;

      // Chunks may coalesce, but their concatenation must be "abc" —
      // never "acb"/"bca"/interleaved (the bug the old per-chunk fork allowed).
      expect(writes.join("")).toBe("abc");
    }),
  );

  it.effect("shutdown detaches the onData listener", () =>
    Effect.gen(function* () {
      const src = makeDataStub();
      const writes: string[] = [];
      const appendChunk = (_path: string, data: string) =>
        Effect.sync(() => {
          writes.push(data);
        });
      const runFork = Effect.runForkWith(yield* Effect.context<never>());

      const tee = yield* teeProcessOutput({ proc: src.proc, logPath: "/x.log", appendChunk, runFork });
      src.push("early");
      yield* tee.shutdown;

      expect(src.detached).toBe(true);
      src.push("late"); // listener gone — must not reach the log
      expect(writes.join("")).toBe("early");
    }),
  );

  it.effect("shutdown flushes the buffered tail (no chunk lost)", () =>
    Effect.gen(function* () {
      const src = makeDataStub();
      const writes: string[] = [];
      const appendChunk = (_path: string, data: string) =>
        Effect.sync(() => {
          writes.push(data);
        });
      const runFork = Effect.runForkWith(yield* Effect.context<never>());

      const tee = yield* teeProcessOutput({ proc: src.proc, logPath: "/x.log", appendChunk, runFork });
      src.push("tail");
      yield* tee.shutdown; // must flush "tail" before resolving

      expect(writes.join("")).toBe("tail");
    }),
  );
});
