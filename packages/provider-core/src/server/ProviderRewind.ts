/**
 * The optional `rewindFiles` session method (Claude Code style rewind): its error, input and
 * result. Fork feature (ADR 0003); `ProviderAdapter.ts` re-exports this file.
 */
import type { ModelSelection, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

export class ProviderAdapterRewindFilesError extends Schema.TaggedError<ProviderAdapterRewindFilesError>()(
  "ProviderAdapterRewindFilesError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to restore files of ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export interface ProviderAdapterV2RewindFilesInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  /** The provider's id for the user message whose pre-turn file state is restored. */
  readonly nativeUserMessageId: string;
  /** Reports what a restore would change without touching any file. */
  readonly dryRun: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2RewindFilesResult {
  readonly canRewind: boolean;
  /** Why the provider cannot restore, when `canRewind` is false. */
  readonly error?: string;
  /** Files a dry run would change; a real restore leaves it empty. */
  readonly filesChanged: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
  /** Files a real restore left alone because a link made them unsafe to write. */
  readonly skippedLinks: number;
}
