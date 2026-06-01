import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  RELAY_AXIOM_TRACE_DATASET,
  provisionRelayObservability,
  relayAxiomIngestDatasetCapabilities,
  relayAxiomQueryDatasetCapabilities,
  relayRecentSpansQuery,
  relayTraceQuery,
} from "./RelayObservability.ts";

describe("RelayObservability", () => {
  it("scopes the ingest token only to HTTP span ingestion", () => {
    expect(relayAxiomIngestDatasetCapabilities()).toEqual({
      [RELAY_AXIOM_TRACE_DATASET]: { ingest: ["create"] },
    });
  });

  it("scopes the diagnostics query token only to HTTP spans", () => {
    expect(relayAxiomQueryDatasetCapabilities()).toEqual({
      [RELAY_AXIOM_TRACE_DATASET]: { query: ["read"] },
    });
  });

  it("builds APL queries for the trace dataset", () => {
    expect(relayTraceQuery("| where name == 'GET /health'", "relay-traces-test")).toBe(
      "['relay-traces-test']\n| where name == 'GET /health'",
    );
  });

  it("projects Effect HTTP span attributes through their OTLP field names", () => {
    const query = relayRecentSpansQuery("relay-traces-test");

    expect(query).toContain("['relay-traces-test']");
    expect(query).toContain("attributes.http.request.method");
    expect(query).toContain("attributes.http.response.status_code");
    expect(query).toContain("attributes.url.path");
    expect(query).toContain("attributes.http.route");
    expect(query).toContain("customAttributes = column_ifexists('attributes.custom', dynamic({}))");
    expect(query).toContain("customAttributes['user.id']");
    expect(query).not.toContain("['http.request.method']");
  });

  it("orders token and view resources behind the trace dataset", async () => {
    const stack = {
      name: "RelayObservabilityTest",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    };

    await Effect.runPromise(
      provisionRelayObservability.pipe(
        Effect.provideService(Alchemy.Stack, stack),
        Effect.provideService(Axiom.Providers, {
          kind: "ProviderCollection",
          get: () => undefined,
        }),
      ),
    );

    const resources = stack.resources as Record<string, { FQN: string; Props: unknown }>;
    const traces = resources.RelayTracesDataset;

    expect(traces).toBeDefined();
    for (const logicalId of [
      "RelayAxiomIngestToken",
      "RelayAxiomQueryToken",
      "RelayRecentSpansView",
    ]) {
      expect(resources[logicalId]).toBeDefined();
      expect(Object.keys(Output.resolveUpstream(resources[logicalId]!.Props))).toContain(
        traces!.FQN,
      );
    }
  });
});
