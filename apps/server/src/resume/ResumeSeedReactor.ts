/**
 * ResumeSeedReactor — seeds a provider runtime binding so a freshly-created
 * thread resumes a previously-recorded Claude SDK session on its first turn.
 *
 * When a thread is created from the /resume picker it carries a
 * `resumeSessionId`. We write a `stopped` binding whose `resumeCursor` holds
 * `{ resume: <sessionId> }`. The first turn then takes the fresh-start path
 * (no active session), and `ProviderService.startSession` merges this persisted
 * cursor — gated only on the provider instance matching — into the adapter
 * call, where `ClaudeAdapter.readClaudeResumeState` hands `resume` to the SDK.
 *
 * `stopped` is load-bearing: the reaper skips stopped bindings (so the seed
 * survives until the first turn) and it leaves no active session (so the turn
 * actually starts a new query rather than attaching to nothing).
 *
 * @module ResumeSeedReactor
 */
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export interface ResumeSeedInput {
  readonly threadId: ThreadId;
  readonly resumeSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
}

export const seedResumeBinding = (input: ResumeSeedInput) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    yield* directory.upsert({
      threadId: input.threadId,
      provider: CLAUDE_DRIVER_KIND,
      providerInstanceId: input.providerInstanceId,
      status: "stopped",
      runtimeMode: input.runtimeMode,
      resumeCursor: { resume: input.resumeSessionId, threadId: input.threadId },
    });
  });

/**
 * The slice of a `thread.created` payload the reactor needs. Declared narrow so
 * the reactor can pass `event.payload` directly (structural supertype) without
 * coupling to every ThreadCreatedPayload field.
 */
export interface CreatedThreadForResume {
  readonly threadId: ThreadId;
  readonly resumeSessionId?: string | null | undefined;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly runtimeMode: RuntimeMode;
}

/**
 * React to a `thread.created`: seed the resume binding only when the thread was
 * created from the /resume picker (i.e. it carries a `resumeSessionId`). The
 * binding's instance is taken from the thread's model selection so it matches
 * the first turn's instance — the equality `ProviderService` gates the merge on.
 */
export const handleCreatedThread = (payload: CreatedThreadForResume) =>
  Effect.gen(function* () {
    if (payload.resumeSessionId == null) {
      return;
    }
    yield* seedResumeBinding({
      threadId: payload.threadId,
      resumeSessionId: payload.resumeSessionId,
      providerInstanceId: payload.modelSelection.instanceId,
      runtimeMode: payload.runtimeMode,
    });
  });

export interface ResumeSeedReactorShape {
  /**
   * Start the reactor. Must run in a scope so the subscription fiber is
   * finalized on shutdown. Mirrors CheckpointReactor's forkScoped pattern.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ResumeSeedReactor extends Context.Service<
  ResumeSeedReactor,
  ResumeSeedReactorShape
>()("t3/resume/ResumeSeedReactor") {}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  // Captured here so the forked stream effect does not leak
  // ProviderSessionDirectory into `start`'s scope-only requirement.
  const directory = yield* ProviderSessionDirectory;

  const start: ResumeSeedReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.created") {
          return Effect.void;
        }
        // One failing event must not tear down the subscription.
        return handleCreatedThread(event.payload).pipe(
          Effect.provideService(ProviderSessionDirectory, directory),
          Effect.catchCause((cause) =>
            Effect.logWarning("resume seed reactor failed to seed binding", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }),
    );
  });

  return { start } satisfies ResumeSeedReactorShape;
});

export const ResumeSeedReactorLive = Layer.effect(ResumeSeedReactor, make);
