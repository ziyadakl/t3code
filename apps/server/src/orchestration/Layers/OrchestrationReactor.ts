import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { RewindReactor } from "../Services/RewindReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ResumeSeedReactor } from "../../resume/ResumeSeedReactor.ts";
import { SessionTitleReactor } from "../../resume/SessionTitleReactor.ts";
import { SdkTitleReactor } from "../../resume/SdkTitleReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const rewindReactor = yield* RewindReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const resumeSeedReactor = yield* ResumeSeedReactor;
  const sessionTitleReactor = yield* SessionTitleReactor;
  const sdkTitleReactor = yield* SdkTitleReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* rewindReactor.start();
    yield* threadDeletionReactor.start();
    yield* resumeSeedReactor.start();
    yield* sessionTitleReactor.start();
    yield* sdkTitleReactor.start();
    yield* agentAwarenessRelay.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
