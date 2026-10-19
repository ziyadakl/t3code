import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

/** Claude desktop and CLI sessions in one project that the resume picker can continue. */
export const agentSessionListResumable = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:list-resumable",
  tag: WS_METHODS.agentSessionsListResumable,
});

export const agentSessionResume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:resume",
  tag: WS_METHODS.agentSessionsResume,
});
