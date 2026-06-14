/**
 * Tests for devServer/detect.ts.
 *
 * Tests `parseSsListeners` (pure) and `detectListening` (effectful, using fake
 * ProcessRunner + FileSystem layers).
 *
 * All tests use `it.effect` — bare `it(() => Effect.gen(...))` is vacuous in
 * this repo (passes without running the effect body).
 */
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { parseSsListeners, detectListening } from "./detect.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunOutput(stdout: string): ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(0),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/** Fake ProcessRunner that returns canned ss output. */
function makeFakeProcessRunner(stdout: string): Layer.Layer<ProcessRunner> {
  return Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: () => Effect.succeed(makeRunOutput(stdout)),
    }),
  );
}

/** Fake ProcessRunner that dies (simulates `ss` binary missing). */
function makeFakeProcessRunnerFailing(): Layer.Layer<ProcessRunner> {
  return Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: () => Effect.die(new Error("ss: command not found")),
    }),
  );
}

/**
 * Fake FileSystem whose `readLink` resolves `/proc/<pid>/cwd` from a
 * pid→cwd map. All other FS operations are noop.
 */
function makeFakeFileSystem(cwdByPid: Record<number, string>): Layer.Layer<FileSystem.FileSystem> {
  return FileSystem.layerNoop({
    readLink: (path) => {
      const match = /^\/proc\/(\d+)\/cwd$/.exec(path);
      if (!match) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readLink",
            description: `Not found: ${path}`,
            pathOrDescriptor: path,
          }),
        );
      }
      const pid = parseInt(match[1]!, 10);
      const resolved = cwdByPid[pid];
      if (resolved === undefined) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readLink",
            description: `No /proc/${pid}/cwd`,
            pathOrDescriptor: path,
          }),
        );
      }
      return Effect.succeed(resolved);
    },
  });
}

function makeServerConfigLayer(host?: string): Layer.Layer<ServerConfig> {
  return Layer.succeed(ServerConfig, { host } as ServerConfig["Service"]);
}

// ---------------------------------------------------------------------------
// parseSsListeners — pure unit tests
// ---------------------------------------------------------------------------

const SAMPLE_SS_OUTPUT = [
  "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))",
  "LISTEN 0      511              127.0.0.1:4101      0.0.0.0:*    users:((\"node\",pid=1691823,fd=21))",
  "LISTEN 0      4096   [2a02:4780:4:7556::1]:443        [::]:*    users:((\"caddy\",pid=500,fd=7))",
  "LISTEN 0      128                  0.0.0.0:22        0.0.0.0:*",
].join("\n");

describe("parseSsListeners", () => {
  it.effect("parses a Tailscale IPv4 listener", () =>
    Effect.sync(() => {
      const results = parseSsListeners(
        "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ localAddr: "100.99.237.12", port: 4001, pid: 99001 });
    }),
  );

  it.effect("parses a loopback IPv4 listener", () =>
    Effect.sync(() => {
      const results = parseSsListeners(
        "LISTEN 0      511              127.0.0.1:4101      0.0.0.0:*    users:((\"node\",pid=1691823,fd=21))",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ localAddr: "127.0.0.1", port: 4101, pid: 1691823 });
    }),
  );

  it.effect("parses an IPv6 listener and strips brackets from addr", () =>
    Effect.sync(() => {
      const results = parseSsListeners(
        "LISTEN 0      4096   [2a02:4780:4:7556::1]:443        [::]:*    users:((\"caddy\",pid=500,fd=7))",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ localAddr: "2a02:4780:4:7556::1", port: 443, pid: 500 });
    }),
  );

  it.effect("skips lines with no users/pid info", () =>
    Effect.sync(() => {
      const results = parseSsListeners(
        "LISTEN 0      128                  0.0.0.0:22        0.0.0.0:*",
      );
      expect(results).toHaveLength(0);
    }),
  );

  it.effect("parses all four sample lines — 3 have pids, 1 skipped", () =>
    Effect.sync(() => {
      const results = parseSsListeners(SAMPLE_SS_OUTPUT);
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ localAddr: "100.99.237.12", port: 4001, pid: 99001 });
      expect(results[1]).toMatchObject({ localAddr: "127.0.0.1", port: 4101, pid: 1691823 });
      expect(results[2]).toMatchObject({ localAddr: "2a02:4780:4:7556::1", port: 443, pid: 500 });
    }),
  );

  it.effect("parses wildcard 0.0.0.0 bind address", () =>
    Effect.sync(() => {
      const results = parseSsListeners(
        "LISTEN 0      511              0.0.0.0:3000      0.0.0.0:*    users:((\"node\",pid=12345,fd=5))",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ localAddr: "0.0.0.0", port: 3000, pid: 12345 });
    }),
  );
});

// ---------------------------------------------------------------------------
// detectListening — effectful tests
// ---------------------------------------------------------------------------

describe("detectListening", () => {
  it.effect("returns the Tailscale URL when a matching non-loopback listener is found", () => {
    const ssOutput = [
      "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))",
      "LISTEN 0      511              127.0.0.1:4101      0.0.0.0:*    users:((\"node\",pid=1691823,fd=21))",
    ].join("\n");

    const layer = Layer.mergeAll(
      makeFakeProcessRunner(ssOutput),
      makeFakeFileSystem({ 99001: "/project/worktree", 1691823: "/other/project" }),
      makeServerConfigLayer(),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project/worktree").pipe(Effect.provide(layer));
      expect(url).toBe("http://100.99.237.12:4001");
    });
  });

  it.effect("returns null when no pid's cwd matches the target", () => {
    const ssOutput =
      "LISTEN 0      511          100.99.237.12:4001      0.0.0.0:*    users:((\"node\",pid=99001,fd=21))";

    const layer = Layer.mergeAll(
      makeFakeProcessRunner(ssOutput),
      makeFakeFileSystem({ 99001: "/completely/different/path" }),
      makeServerConfigLayer(),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project/worktree").pipe(Effect.provide(layer));
      expect(url).toBeNull();
    });
  });

  it.effect("returns null gracefully when ProcessRunner dies (ss missing)", () => {
    const layer = Layer.mergeAll(
      makeFakeProcessRunnerFailing(),
      makeFakeFileSystem({}),
      makeServerConfigLayer(),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project/worktree").pipe(Effect.provide(layer));
      expect(url).toBeNull();
    });
  });

  it.effect("matches when process cwd is nested under target worktree", () => {
    const ssOutput =
      "LISTEN 0      511          100.99.237.12:5000      0.0.0.0:*    users:((\"node\",pid=42,fd=3))";

    const layer = Layer.mergeAll(
      makeFakeProcessRunner(ssOutput),
      makeFakeFileSystem({ 42: "/project/worktree/packages/app" }),
      makeServerConfigLayer(),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project/worktree").pipe(Effect.provide(layer));
      expect(url).toBe("http://100.99.237.12:5000");
    });
  });

  it.effect("substitutes config host for wildcard 0.0.0.0 bind", () => {
    const ssOutput =
      "LISTEN 0      511              0.0.0.0:3000      0.0.0.0:*    users:((\"node\",pid=77,fd=5))";

    const layer = Layer.mergeAll(
      makeFakeProcessRunner(ssOutput),
      makeFakeFileSystem({ 77: "/project" }),
      makeServerConfigLayer("100.99.237.12"),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project").pipe(Effect.provide(layer));
      expect(url).toBe("http://100.99.237.12:3000");
    });
  });

  it.effect("falls back to 127.0.0.1 for wildcard when config host is undefined", () => {
    const ssOutput =
      "LISTEN 0      511              0.0.0.0:3000      0.0.0.0:*    users:((\"node\",pid=77,fd=5))";

    const layer = Layer.mergeAll(
      makeFakeProcessRunner(ssOutput),
      makeFakeFileSystem({ 77: "/project" }),
      makeServerConfigLayer(undefined),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project").pipe(Effect.provide(layer));
      expect(url).toBe("http://127.0.0.1:3000");
    });
  });

  it.effect("returns null when ss output is empty", () => {
    const layer = Layer.mergeAll(
      makeFakeProcessRunner(""),
      makeFakeFileSystem({}),
      makeServerConfigLayer(),
    );

    return Effect.gen(function* () {
      const url = yield* detectListening("/project/worktree").pipe(Effect.provide(layer));
      expect(url).toBeNull();
    });
  });
});
