/**
 * DevServerRunner — manages long-lived dev-server processes.
 *
 * Keyed by resolved cwd (worktreePath ?? projectCwd).  Each entry holds the
 * URL the server printed and the PtyProcess that is still running.
 *
 * Design mirrored from terminal/Layers/Manager.ts (SynchronizedRef pattern).
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";
import type { DevServerPayload, DevServerStatus } from "@t3tools/contracts";
import { DevServerError } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { PtyAdapter } from "../terminal/Services/PTY.ts";
import type { PtyProcess } from "../terminal/Services/PTY.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { detectListening } from "./detect.ts";
import { DEV_START_CMD, DEV_STOP_CMD } from "./devServerCommands.ts";

// ---------------------------------------------------------------------------
// ANSI escape sequence strip + URL extraction
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJsuhl]/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, "");
}

const URL_RE = /https?:\/\/[^\s]+:\d+/;

export function extractUrl(text: string): string | null {
  const m = URL_RE.exec(stripAnsi(text));
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Readiness probe
// ---------------------------------------------------------------------------
//
// A dev server prints its URL the moment it binds the port, but it usually
// hasn't compiled anything yet — many dev servers (Next.js especially) only
// compile a route when a request actually hits it. So we don't just check that
// the port is up: we issue a real HTTP GET, which BOTH triggers the compile and
// blocks until the page is served. Once the GET returns, the page is warm and a
// browser tab opened to it loads immediately instead of a blank/loading screen.

/** Total time to keep probing before opening anyway (best-effort gate). */
const READINESS_TOTAL_TIMEOUT = Duration.seconds(60);
/** Per-request cap — generous, so one request can ride through a cold compile. */
const READINESS_REQUEST_TIMEOUT = Duration.seconds(30);
/** Gap between attempts while the server isn't yet accepting connections. */
const READINESS_RETRY_INTERVAL = Duration.millis(500);

/** A single readiness check: resolves true if the server answered, else false. */
export type ReadyProbe = (url: string) => Effect.Effect<boolean>;

export interface ReadinessOptions {
  readonly totalTimeout?: Duration.Duration;
  readonly retryInterval?: Duration.Duration;
}

/**
 * Build a readiness probe that issues a real HTTP GET via the Effect HttpClient.
 * ANY HTTP response (even 404/500) counts as ready — the server is up and
 * serving; only a connection error or a request exceeding `requestTimeout`
 * counts as not-ready. The GET also triggers compile-on-request dev servers.
 */
export function makeHttpProbe(
  client: HttpClient.HttpClient,
  requestTimeout: Duration.Duration,
): ReadyProbe {
  return (url) =>
    client.get(url).pipe(
      Effect.as(true),
      Effect.timeout(requestTimeout),
      Effect.orElseSucceed(() => false),
      Effect.scoped,
    );
}

/**
 * Poll `url` (via `probe`) until it actually answers, so callers only open the
 * tab once the page is compiled and serving. Best-effort: resolves false after
 * the total timeout so a broken / crash-looping server can't hang start().
 */
export function waitUntilReady(
  probe: ReadyProbe,
  url: string,
  opts: ReadinessOptions = {},
): Effect.Effect<boolean> {
  return probe(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(opts.retryInterval ?? READINESS_RETRY_INTERVAL),
      until: (ready) => ready === true,
    }),
    Effect.timeout(opts.totalTimeout ?? READINESS_TOTAL_TIMEOUT),
    Effect.orElseSucceed(() => false),
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RunningDevServer {
  /** Captured URL, or null while the slot is reserved but the server is still starting. */
  readonly url: string | null;
  /** The PTY process, or null while the slot is reserved before spawn has stored it. */
  readonly process: PtyProcess | null;
}

type DevServerMap = Map<string, RunningDevServer>;

/** Outcome of the atomic check-and-reserve at the start of start(). */
type StartDecision =
  | { readonly _tag: "running"; readonly url: string }
  | { readonly _tag: "starting" }
  | { readonly _tag: "proceed" };

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface DevServerRunnerShape {
  start(payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError>;
  stop(payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError>;
  status(payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError>;
}

export class DevServerRunner extends Context.Service<DevServerRunner, DevServerRunnerShape>()(
  "t3/devServer/DevServerRunner",
) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the effective cwd from the payload. */
export function resolveCwd(payload: DevServerPayload): string | null {
  return payload.worktreePath ?? payload.projectCwd;
}

/**
 * Build the environment for the spawned process.
 *
 * Mirrors the Manager's approach:
 *  1. Start from process.env (the server's env — has PATH, HOME, etc.).
 *  2. Strip known noise vars (T3CODE_*, VITE_*, PORT…) that the terminal
 *     manager also strips, so the child process doesn't inherit internal knobs.
 *  3. Layer project-specific vars on top (T3CODE_PROJECT_ROOT /
 *     T3CODE_WORKTREE_PATH) from projectScriptRuntimeEnv.
 *
 * A login shell (-lc) is required so the user's profile / mise PATH loads;
 * but having process.env as a base already includes whatever PATH the server
 * inherited, which ensures the absolute minimum is always present.
 */
const SERVER_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
]);

function shouldExcludeKey(key: string): boolean {
  const up = key.toUpperCase();
  return (
    up.startsWith("T3CODE_") ||
    up.startsWith("VITE_") ||
    SERVER_ENV_BLOCKLIST.has(up)
  );
}

export function buildSpawnEnv(payload: DevServerPayload): NodeJS.ProcessEnv {
  // Base: a clean copy of the server process env (has PATH, HOME, SHELL, …)
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (shouldExcludeKey(k)) continue;
    base[k] = v;
  }

  // Overlay the project-specific runtime vars
  const projectCwd = payload.projectCwd ?? payload.worktreePath ?? ".";
  const runtimeEnv = projectScriptRuntimeEnv({
    project: { cwd: projectCwd },
    worktreePath: payload.worktreePath ?? null,
  });
  return { ...base, ...runtimeEnv };
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

const makeDevServerRunner = Effect.gen(function* () {
  const ptyAdapter = yield* PtyAdapter;
  // Services needed for detectListening — yielded here so the context
  // is always available when we call detect from within status/start.
  const processRunner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  // Readiness probe used to warm a dev server (compile-on-request) before the
  // client opens its tab — so the tab loads a compiled page, not a blank one.
  const readyProbe = makeHttpProbe(httpClient, READINESS_REQUEST_TIMEOUT);

  // Capture the current Effect context so we can use Effect.runForkWith from
  // sync callbacks (same pattern as terminal/Layers/Manager.ts:952).
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  /** Helper that runs detectListening with the captured services. */
  const detect = (cwd: string): Effect.Effect<string | null> =>
    detectListening(cwd).pipe(
      Effect.provideService(ProcessRunner, processRunner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ServerConfig, serverConfig),
    );

  const stateRef = yield* SynchronizedRef.make<DevServerMap>(new Map());

  const shell = process.env.SHELL ?? "bash";

  // ---- status ---------------------------------------------------------------

  const status = (payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError> =>
    Effect.gen(function* () {
      const cwd = resolveCwd(payload);
      if (!cwd) {
        return yield* new DevServerError({ message: "No working directory for dev server" });
      }
      const map = yield* SynchronizedRef.get(stateRef);
      const entry = map.get(cwd);
      if (entry) {
        // Known to this process — return as-is (url may still be null while starting).
        return { running: true, url: entry.url };
      }

      // Not in our map — probe for an externally started server.
      const detectedUrl = yield* detect(cwd);
      if (detectedUrl !== null) {
        return { running: true, url: detectedUrl };
      }
      return { running: false, url: null };
    });

  // ---- start ----------------------------------------------------------------

  const start = (payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError> =>
    Effect.gen(function* () {
      const cwd = resolveCwd(payload);
      if (!cwd) {
        return yield* new DevServerError({ message: "No working directory for dev server" });
      }

      // Atomically check existing state and, if the cwd is free, RESERVE the slot
      // BEFORE spawning. This closes a double-start race: two concurrent start()
      // calls for the same cwd can no longer both spawn a dev server.
      const decision = yield* SynchronizedRef.modify(
        stateRef,
        (map): readonly [StartDecision, DevServerMap] => {
          const existing = map.get(cwd);
          if (existing) {
            return existing.url !== null
              ? [{ _tag: "running", url: existing.url }, map]
              : [{ _tag: "starting" }, map];
          }
          const next = new Map(map);
          next.set(cwd, { url: null, process: null });
          return [{ _tag: "proceed" }, next];
        },
      );

      if (decision._tag === "running") {
        return { running: true, url: decision.url };
      }
      if (decision._tag === "starting") {
        return yield* new DevServerError({
          message: "Dev server is already starting for this worktree.",
          reason: "already-starting",
        });
      }

      // We hold the reservation. Before spawning, check if a server is already
      // listening externally (e.g. started in a terminal). If so, ADOPT it:
      // store in map with process: null and return immediately without spawning.
      const adoptedUrl = yield* detect(cwd);
      if (adoptedUrl !== null) {
        yield* SynchronizedRef.update(stateRef, (map) => {
          const next = new Map(map);
          next.set(cwd, { url: adoptedUrl, process: null });
          return next;
        });
        // Warm it up before the caller opens the tab (compile-on-request).
        yield* waitUntilReady(readyProbe, adoptedUrl);
        return { running: true, url: adoptedUrl } satisfies DevServerStatus;
      }

      // No external server found — proceed to spawn. ANY failure below must release the reservation.
      const releaseReservation = SynchronizedRef.update(stateRef, (map) => {
        const entry = map.get(cwd);
        // Only delete the unfulfilled reservation (process not yet stored).
        if (entry && entry.process === null) {
          const next = new Map(map);
          next.delete(cwd);
          return next;
        }
        return map;
      });

      const spawnAndCapture = Effect.gen(function* () {
      const env = buildSpawnEnv(payload);

      const proc = yield* ptyAdapter
        .spawn({
          shell,
          args: ["-lc", DEV_START_CMD],
          cwd,
          cols: 80,
          rows: 24,
          env,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new DevServerError({
                message: `Failed to spawn dev server: ${err.message}`,
                reason: "spawn-error",
              }),
          ),
        );

      // Deferred resolves with the first captured URL (or fails on early exit).
      // We use Deferred.doneUnsafe to settle it synchronously from PTY callbacks
      // (exactly as Manager.ts does for process events with runFork).
      const urlDeferred = yield* Deferred.make<string, DevServerError>();
      let deferredSettled = false;

      const settleDeferred = (successUrl: string | null, failure?: DevServerError) => {
        if (deferredSettled) return;
        deferredSettled = true;
        if (failure) {
          Deferred.doneUnsafe(urlDeferred, Effect.fail(failure));
        } else if (successUrl !== null) {
          Deferred.doneUnsafe(urlDeferred, Effect.succeed(successUrl));
        }
      };

      let accumulatedOutput = "";

      const unsubscribeData = proc.onData((data) => {
        if (deferredSettled) return;
        accumulatedOutput += stripAnsi(data);
        const url = extractUrl(accumulatedOutput);
        if (url) {
          settleDeferred(url);
        }
      });

      const _unsubscribeExit = proc.onExit((event) => {
        // Fail the deferred if the process exits before printing a URL
        settleDeferred(
          null,
          new DevServerError({
            message: `Dev server process exited before printing a URL (code ${event.exitCode})`,
            reason: "early-exit",
          }),
        );
        // Remove the map entry when this particular process exits.
        // Using runFork here is safe — SynchronizedRef.update has no service deps.
        runFork(
          SynchronizedRef.update(stateRef, (map) => {
            const entry = map.get(cwd);
            if (entry && entry.process === proc) {
              const next = new Map(map);
              next.delete(cwd);
              return next;
            }
            return map;
          }),
        );
      });

      // Race: URL captured vs 60-second timeout.
      // On timeout we also kill the spawned process.
      const urlResult = yield* Deferred.await(urlDeferred).pipe(
        Effect.timeout("60 seconds"),
        Effect.tapError(() =>
          Effect.sync(() => {
            try { proc.kill(); } catch { /* ignore */ }
          }),
        ),
        Effect.mapError((err): DevServerError => {
          if (err._tag === "TimeoutError") {
            return new DevServerError({
              message: "Dev server did not print a URL within 60s",
              reason: "timeout",
            });
          }
          // err is already a DevServerError
          return err;
        }),
        Effect.ensuring(
          Effect.sync(() => {
            // Always detach the data listener after we're done waiting
            unsubscribeData();
          }),
        ),
      );

      // Fulfil the reservation with the captured url + live process.
      // The onExit handler registered above cleans the entry up when the process dies.
      yield* SynchronizedRef.update(stateRef, (map) => {
        const next = new Map(map);
        next.set(cwd, { url: urlResult, process: proc });
        return next;
      });

        // The server printed its URL but likely hasn't compiled yet — poll it
        // (which triggers + waits for the compile) so the tab opens warm.
        yield* waitUntilReady(readyProbe, urlResult);
        return { running: true, url: urlResult } satisfies DevServerStatus;
      });

      return yield* spawnAndCapture.pipe(Effect.tapCause(() => releaseReservation));
    });

  // ---- stop -----------------------------------------------------------------

  const stop = (payload: DevServerPayload): Effect.Effect<DevServerStatus, DevServerError> =>
    Effect.gen(function* () {
      const cwd = resolveCwd(payload);
      if (!cwd) {
        return yield* new DevServerError({ message: "No working directory for dev server" });
      }

      const env = buildSpawnEnv(payload);

      // Run the stop command as a one-shot PTY and wait for it to exit
      const stopProc = yield* ptyAdapter
        .spawn({
          shell,
          args: ["-lc", DEV_STOP_CMD],
          cwd,
          cols: 80,
          rows: 24,
          env,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new DevServerError({
                message: `Failed to spawn stop command: ${err.message}`,
                reason: "spawn-error",
              }),
          ),
        );

      // Wait for the stop command to exit (up to 30 seconds)
      const exitDeferred = yield* Deferred.make<void, never>();
      stopProc.onExit(() => {
        Deferred.doneUnsafe(exitDeferred, Effect.void);
      });
      yield* Deferred.await(exitDeferred).pipe(
        Effect.timeout("30 seconds"),
        Effect.ignore,
      );

      // Kill any held start-process and remove from map
      yield* SynchronizedRef.updateEffect(stateRef, (map) =>
        Effect.gen(function* () {
          const entry = map.get(cwd);
          if (entry?.process) {
            yield* Effect.try({
              try: () => entry.process!.kill(),
              catch: () => undefined,
            }).pipe(Effect.ignore);
          }
          const next = new Map(map);
          next.delete(cwd);
          return next;
        }),
      );

      return { running: false, url: null };
    });

  return { start, stop, status } satisfies DevServerRunnerShape;
});

export const DevServerRunnerLive = Layer.effect(DevServerRunner, makeDevServerRunner);
