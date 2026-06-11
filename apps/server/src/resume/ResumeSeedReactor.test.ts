import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { handleCreatedThread, seedResumeBinding } from "./ResumeSeedReactor.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ResumeSeedReactor", (it) => {
  it.effect("seeds a stopped Claude resume binding carrying the picked session id", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      const threadId = ThreadId.make("thread-resume-1");
      const sessionId = "00a5c392-f7f3-4e01-ad14-1bba7c69d789";
      const instanceId = ProviderInstanceId.make("claude-default");

      yield* seedResumeBinding({
        threadId,
        resumeSessionId: sessionId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        // Survives the reaper (which skips "stopped") AND leaves no active
        // session, so the first turn takes the fresh-start path and picks up
        // the cursor below.
        assert.equal(binding.value.status, "stopped");
        // Must match the first turn's instance or ProviderService silently
        // drops the resume cursor.
        assert.equal(binding.value.providerInstanceId, instanceId);
        assert.equal(binding.value.provider, "claudeAgent");
        // The shape ClaudeAdapter.readClaudeResumeState reads: { resume } is
        // passed to the SDK query() as the resume session id.
        assert.deepEqual(binding.value.resumeCursor, {
          resume: sessionId,
          threadId,
        });
      }
    }));

  it.effect("seeds from a thread.created carrying a resumeSessionId, using the model's instance", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      const threadId = ThreadId.make("thread-created-resume");
      const sessionId = "0ed4e913-e0cf-4256-bc48-9ab382ddfc64";
      const instanceId = ProviderInstanceId.make("claude-default");

      yield* handleCreatedThread({
        threadId,
        resumeSessionId: sessionId,
        modelSelection: { instanceId },
        runtimeMode: "full-access",
      });

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.equal(binding.value.providerInstanceId, instanceId);
        assert.deepEqual(binding.value.resumeCursor, { resume: sessionId, threadId });
      }
    }));

  it.effect("does not seed a binding for a thread created without a resumeSessionId", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      const threadId = ThreadId.make("thread-created-plain");

      yield* handleCreatedThread({
        threadId,
        resumeSessionId: null,
        modelSelection: { instanceId: ProviderInstanceId.make("claude-default") },
        runtimeMode: "full-access",
      });

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isNone(binding), true);
    }));
});
