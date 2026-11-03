/**
 * The rewind menu's atoms: the `rewind` thread command and the code-restore
 * preview query. Fork feature (docs/adr/0003-fork-features-in-own-files.md);
 * `threadCommands.ts` and `orchestration.ts` each spread one builder.
 */
import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type RewindThreadInput, rewindThread } from "../operations/threadRewind.ts";
import {
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function threadRewindCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  options: {
    readonly scheduler: AtomCommandScheduler;
    readonly concurrency: AtomCommandConcurrency<{
      readonly environmentId: EnvironmentId;
      readonly input: RewindThreadInput;
    }>;
  },
) {
  return {
    rewind: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:rewind",
      execute: (input: RewindThreadInput) => rewindThread(input),
      scheduler: options.scheduler,
      concurrency: options.concurrency,
    }),
  };
}

export function threadRewindQueryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // A dry run of a code restore for one message; always fresh, files change.
    threadRewindPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-rewind-preview",
      tag: ORCHESTRATION_V2_WS_METHODS.previewThreadRewind,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}
