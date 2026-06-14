/**
 * Dev-server command constants.
 *
 * Kept in one place so they are trivial to override later without hunting
 * through multiple files.
 */

/** Command run as a long-lived PTY to start the project's dev server. */
export const DEV_START_CMD = "pnpm dev:next:safe:direct";

/** Command run as a one-shot PTY to gracefully shut down the dev server. */
export const DEV_STOP_CMD = "pnpm shutdown";
