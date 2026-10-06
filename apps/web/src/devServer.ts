import type { ProjectScript } from "@t3tools/contracts";

/**
 * The thread terminal a dev server runs in. One fixed id per thread keeps the
 * running state and its output findable after a reload or from another client,
 * because the server owns terminal sessions and reports their subprocesses.
 */
export const DEV_SERVER_TERMINAL_ID = "dev-server";

const DEV_NAME_PATTERN = /\bdev\b/i;

/**
 * The project action that starts the dev server: the first action with a
 * preview URL, since that is what marks an action as serving something.
 * Projects that never set one fall back to an action named "dev".
 */
export function devServerScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const runnable = scripts.filter((script) => !script.runOnWorktreeCreate);
  return (
    runnable.find((script) => script.previewUrl !== undefined) ??
    runnable.find((script) => DEV_NAME_PATTERN.test(script.name) || script.id === "dev") ??
    null
  );
}

/** Ctrl-C: stops the foreground command and leaves its output in the terminal. */
export const DEV_SERVER_STOP_INPUT = "\u0003";
