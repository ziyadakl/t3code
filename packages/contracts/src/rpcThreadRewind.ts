/**
 * The `previewThreadRewind` RPC behind the rewind menu's code choices. Fork
 * feature (docs/adr/0003-fork-features-in-own-files.md); `rpc.ts` only lists it
 * in its group.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  OrchestrationPreviewThreadRewindError,
  ThreadRewindPreviewRpcSchema,
} from "./threadRewind.ts";

export const WsOrchestrationV2PreviewThreadRewindRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.previewThreadRewind,
  {
    payload: ThreadRewindPreviewRpcSchema.input,
    success: ThreadRewindPreviewRpcSchema.output,
    error: Schema.Union([OrchestrationPreviewThreadRewindError, EnvironmentAuthorizationError]),
  },
);
