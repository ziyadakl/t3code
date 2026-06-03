import { DesktopRelayClientStatusSchema } from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getRelayClientStatus = makeIpcMethod({
  channel: IpcChannels.GET_RELAY_CLIENT_STATUS_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopRelayClientStatusSchema,
  handler: Effect.fn("desktop.ipc.relayClient.getStatus")(function* () {
    const relayClient = yield* RelayClient.RelayClient;
    return yield* relayClient.resolve;
  }),
});

export const installRelayClient = makeIpcMethod({
  channel: IpcChannels.INSTALL_RELAY_CLIENT_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopRelayClientStatusSchema,
  handler: Effect.fn("desktop.ipc.relayClient.install")(function* () {
    const relayClient = yield* RelayClient.RelayClient;
    return yield* relayClient.install;
  }),
});
