/**
 * The client command behind the rewind menu (`thread.rewind`). Fork feature
 * (docs/adr/0003-fork-features-in-own-files.md); `commands.ts` re-exports it so
 * existing importers keep working.
 */
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type MessageId,
  type ThreadRewindChoice,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";
import type { ThreadCommandInput } from "./commands.ts";

export interface RewindThreadInput extends ThreadCommandInput {
  readonly messageId: MessageId;
  readonly choice: ThreadRewindChoice;
  readonly instructions?: string;
}

export const rewindThread = Effect.fn("EnvironmentCommands.rewindThread")(function* (
  input: RewindThreadInput,
) {
  const instructions = input.instructions?.trim() ?? "";
  const commandId =
    input.commandId ??
    CommandId.make(yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie));
  return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    type: "thread.rewind",
    commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    choice: input.choice,
    ...(instructions.length === 0
      ? {}
      : { instructions: TrimmedNonEmptyString.make(instructions) }),
  });
});
