import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

export const RELAY_OBSERVABILITY_SERVICE_NAME = "t3-code-relay-worker";
export const RELAY_OBSERVABILITY_EXPORT_INTERVAL = "1 second";
export const RELAY_AXIOM_TRACE_DATASET = "t3-code-relay-traces";

export const relayTraceQuery = (query: string, dataset: string = RELAY_AXIOM_TRACE_DATASET) =>
  `['${dataset}']\n${query}`;

export const relayRecentSpansQuery = (dataset: string = RELAY_AXIOM_TRACE_DATASET) =>
  relayTraceQuery(
    "| where isnotnull(span_id) or isnotnull(trace_id)\n| extend requestMethod = column_ifexists('attributes.http.request.method', ''), path = column_ifexists('attributes.url.path', ''), endpoint = column_ifexists('attributes.http.route', ''), statusCode = column_ifexists('attributes.http.response.status_code', 0), customAttributes = column_ifexists('attributes.custom', dynamic({}))\n| extend userId = customAttributes['user.id']\n| project _time, name, trace_id, span_id, duration, requestMethod, path, statusCode, endpoint, userId\n| order by _time desc\n| limit 200",
    dataset,
  );

export const relayAxiomIngestDatasetCapabilities = (
  dataset: string = RELAY_AXIOM_TRACE_DATASET,
) => ({
  [dataset]: { ingest: ["create" as const] },
});

export const relayAxiomQueryDatasetCapabilities = (
  dataset: string = RELAY_AXIOM_TRACE_DATASET,
) => ({
  [dataset]: { query: ["read" as const] },
});

export const provisionRelayObservability = Effect.gen(function* () {
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: RELAY_AXIOM_TRACE_DATASET,
    kind: "otel:traces:v1",
    description: "T3 Code relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const ingestToken = yield* Axiom.ApiToken("RelayAxiomIngestToken", {
    name: "t3-code-relay-otel-ingest",
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, relayAxiomIngestDatasetCapabilities),
  });
  const queryToken = yield* Axiom.ApiToken("RelayAxiomQueryToken", {
    name: "t3-code-relay-readonly-query",
    description: "Owned by Alchemy. Read-only query token for relay HTTP span diagnostics.",
    datasetCapabilities: Output.map(traces.name, relayAxiomQueryDatasetCapabilities),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: "t3-code-relay-recent-spans",
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  return { traces, ingestToken, queryToken } as const;
});
