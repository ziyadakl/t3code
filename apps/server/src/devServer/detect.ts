/**
 * detect.ts — Detect a dev server that is already listening for a given cwd.
 *
 * Uses `ss -tlnpH` (Linux) to enumerate TCP listeners, cross-references each
 * listener's PID with /proc/<pid>/cwd to find one whose working directory is
 * at or under the target cwd, then reconstructs a URL from the bound address.
 *
 * This is intentionally failure-proof: if ss is missing, non-Linux, or any
 * I/O error occurs, the function resolves to null rather than failing.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ProcessRunner } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// parseSsListeners — PURE parsing of `ss -tlnpH` stdout
// ---------------------------------------------------------------------------

export interface SsListener {
  readonly localAddr: string;
  readonly port: number;
  readonly pid: number;
}

/**
 * Parse the output of `ss -tlnpH`.
 *
 * Each line has whitespace-separated columns; the LOCAL ADDRESS:PORT is the
 * 4th column (index 3). The process info is in a trailing
 * `users:(("name",pid=1234,fd=NN),...)` field anywhere in the line.
 *
 * Handles:
 *   IPv4  100.99.237.12:4001   0.0.0.0:80
 *   IPv6  [2a02:4780:4:7556::1]:443   [::]:443
 *   wild  *:443
 *
 * Lines with no pid info are skipped.
 */
export function parseSsListeners(stdout: string): SsListener[] {
  const lines = stdout.split("\n");
  const result: SsListener[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Extract pid from `users:(("name",pid=1234,fd=NN),...)` — first match.
    const pidMatch = /pid=(\d+)/.exec(trimmed);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1]!, 10);

    // Split on whitespace; local address is the 4th column (index 3).
    const cols = trimmed.split(/\s+/);
    if (cols.length < 4) continue;
    const localCol = cols[3]!;

    // Parse localAddr:port — port is everything after the LAST colon.
    const lastColon = localCol.lastIndexOf(":");
    if (lastColon === -1) continue;

    const portStr = localCol.slice(lastColon + 1);
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0 || port > 65535) continue;

    // localAddr is everything before the last colon, stripped of surrounding [].
    let localAddr = localCol.slice(0, lastColon);
    if (localAddr.startsWith("[") && localAddr.endsWith("]")) {
      localAddr = localAddr.slice(1, -1);
    }

    result.push({ localAddr, port, pid });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for loopback addresses we prefer to skip. */
function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

/** Returns true for wildcard bind addresses. */
function isWildcard(addr: string): boolean {
  return addr === "0.0.0.0" || addr === "*" || addr === "::" || addr === "";
}

/**
 * Build the URL for a listener.
 *
 * - IPv6 non-wildcard → http://[addr]:port
 * - Wildcard → substitute ServerConfig.host; skip if unusable.
 * - IPv4 → http://addr:port
 *
 * Returns null if the address is unusable (wildcard with no host config).
 */
function buildUrl(
  localAddr: string,
  port: number,
  configHost: string | undefined,
): string | null {
  let host: string;

  if (isWildcard(localAddr)) {
    // Use the server's configured host, or fall back to 127.0.0.1.
    host = configHost ?? "127.0.0.1";
  } else {
    host = localAddr;
  }

  // IPv6 literal in URL must be bracketed.
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  const hostPart = needsBrackets ? `[${host}]` : host;

  return `http://${hostPart}:${port}`;
}

// ---------------------------------------------------------------------------
// detectListening
// ---------------------------------------------------------------------------

/**
 * Detect whether a dev server is already listening for the given cwd.
 *
 * Returns `http://<host>:<port>` if found, `null` otherwise.
 * Never fails — all errors resolve to null.
 */
export const detectListening = (
  cwd: string,
): Effect.Effect<string | null, never, ProcessRunner | FileSystem.FileSystem | ServerConfig> =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;

    // Run `ss -tlnpH` to list TCP listeners.
    const result = yield* processRunner
      .run({
        command: "ss",
        args: ["-tlnpH"],
        timeout: "2 seconds",
        outputMode: "truncate",
      })
      .pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", code: null, timedOut: false, stdoutTruncated: false, stderrTruncated: false })));

    if (!result.stdout) return null;

    const listeners = parseSsListeners(result.stdout);
    if (listeners.length === 0) return null;

    // Partition: prefer non-loopback; fall back to loopback.
    const preferred = listeners.filter((l) => !isLoopback(l.localAddr));
    const fallback = listeners.filter((l) => isLoopback(l.localAddr));
    const ordered = [...preferred, ...fallback];

    for (const listener of ordered) {
      // Resolve /proc/<pid>/cwd → the process's working directory.
      const cwdLink = `/proc/${listener.pid}/cwd`;
      const resolvedCwd = yield* fs
        .readLink(cwdLink)
        .pipe(Effect.orElseSucceed(() => null));

      if (resolvedCwd === null) continue;

      // Match if the process's cwd IS the target cwd or is nested under it.
      if (resolvedCwd !== cwd && !resolvedCwd.startsWith(cwd + "/")) continue;

      const url = buildUrl(listener.localAddr, listener.port, config.host);
      if (url === null) continue;

      return url;
    }

    return null;
  }).pipe(
    // Wrap entire detection: any uncaught defect/error resolves to null.
    Effect.catchCause(() => Effect.succeed(null)),
  );
