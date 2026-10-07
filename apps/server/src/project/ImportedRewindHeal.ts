import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";

const make = Effect.gen(function* () {
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  /**
   * Gives every Claude chat imported before imports kept transcript uuids its
   * rewind points. Safe to repeat: a healed chat is left as it is. Each chat is
   * healed under its command lock, so a turn started meanwhile waits and takes
   * the run ordinal after the healed ones instead of sharing a run id with
   * one. Returns the number of chats healed.
   */
  const run = Effect.fn("ImportedRewindHeal.run")(function* () {
    const rows = yield* runtimes.list();
    let healed = 0;
    for (const row of rows) {
      if (
        row.providerName !== "claudeAgent" ||
        !AgentSessionImporter.isImportedThreadId(row.threadId)
      ) {
        continue;
      }
      const source = AgentSessionImporter.latestImportedTranscript(row.runtimePayload);
      if (source === undefined) continue;
      const didHeal = yield* threadCommands.withLock(
        row.threadId,
        importer.healImportedThread({ threadId: row.threadId, source }),
      );
      if (didHeal) healed += 1;
    }
    return healed;
  });

  return { run };
});

/** Heals chats imported before imports kept rewind points. */
export class ImportedRewindHeal extends Context.Service<
  ImportedRewindHeal,
  Effect.Success<typeof make>
>()("t3/project/ImportedRewindHeal") {}

export const layer = Layer.effect(ImportedRewindHeal, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
