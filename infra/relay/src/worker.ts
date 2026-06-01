import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  RelayHttpPlatformLayer,
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./api.ts";
import {
  MANAGED_ENDPOINT_BASE_DOMAIN,
  MANAGED_ENDPOINT_PROVISIONER_TOKEN_POLICIES,
  MANAGED_ENDPOINT_ZONE,
  RELAY_PUBLIC_DOMAIN,
  RELAY_PUBLIC_ORIGIN,
} from "./infra/ManagedEndpointStackConfig.ts";
import {
  RELAY_AXIOM_TRACE_DATASET,
  RELAY_OBSERVABILITY_EXPORT_INTERVAL,
  RELAY_OBSERVABILITY_SERVICE_NAME,
  provisionRelayObservability,
} from "./infra/RelayObservability.ts";
import * as DeliveryAttempts from "./persistence/DeliveryAttempts.ts";
import * as AgentActivityRows from "./persistence/AgentActivityRows.ts";
import * as Devices from "./persistence/Devices.ts";
import * as DpopProofs from "./persistence/DpopProofs.ts";
import * as EnvironmentCredentials from "./persistence/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./persistence/EnvironmentLinks.ts";
import * as LiveActivities from "./persistence/LiveActivities.ts";
import { RelayDb, RelayHyperdrive } from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./services/AgentActivityPublisher.ts";
import * as ApnsDeliveryQueue from "./services/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./services/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./services/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./services/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./services/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./services/ManagedEndpointProvider.ts";
import * as MobileRegistrations from "./services/MobileRegistrations.ts";
import * as RelayCrypto from "./RelayCrypto.ts";

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const makeRelayTraceLayer = (input: {
  readonly tracesEndpoint: string;
  readonly tracesDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) =>
  OtlpTracer.layer({
    url: input.tracesEndpoint,
    resource: {
      serviceName: RELAY_OBSERVABILITY_SERVICE_NAME,
      attributes: {
        "service.runtime": "cloudflare-worker",
        "service.component": "relay",
      },
    },
    headers: {
      Authorization: `Bearer ${Redacted.value(input.ingestToken)}`,
      "X-Axiom-Dataset": input.tracesDatasetName,
    },
    exportInterval: RELAY_OBSERVABILITY_EXPORT_INTERVAL,
  }).pipe(Layer.provide(OtlpSerialization.layerJson));

// Bind secrets explicitly and only read them through the runtime worker
// environment. Reading them through Config during Worker init currently
// registers a competing plaintext binding.
const apnsPrivateKeyConfig = Config.redacted("APNS_PRIVATE_KEY");
const clerkSecretKeyConfig = Config.redacted("CLERK_SECRET_KEY");

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    domain: RELAY_PUBLIC_DOMAIN,
    env: {
      APNS_PRIVATE_KEY: apnsPrivateKeyConfig,
      CLERK_SECRET_KEY: clerkSecretKeyConfig,
    },
  },
  Effect.gen(function* () {
    const managedEndpointProvisionerToken = yield* Cloudflare.AccountApiToken(
      "ManagedEndpointProvisionerToken",
      {
        name: "t3-code-relay-managed-endpoint-provisioner",
        policies: MANAGED_ENDPOINT_PROVISIONER_TOKEN_POLICIES,
      },
    );
    const managedEndpointCloudflareApiToken = yield* managedEndpointProvisionerToken.value;
    const relayHyperdrive = yield* RelayHyperdrive;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(relayHyperdrive);
    const apnsDeliveryQueueSender = yield* Cloudflare.QueueBinding.bind(apnsDeliveryQueue);
    const cloudMintKeyPair = yield* Alchemy.KeyPair("CloudMintKeyPair");
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    ).pipe(Config.withDefault("sandbox"));
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const relayObservability = yield* provisionRelayObservability;
    const axiomIngestToken = yield* relayObservability.ingestToken.token;
    const axiomTracesEndpoint = yield* relayObservability.traces.otelTracesEndpoint;
    const relayTraceLayer = Effect.all({
      tracesEndpoint: axiomTracesEndpoint,
      ingestToken: axiomIngestToken,
    }).pipe(
      Effect.map((input) =>
        makeRelayTraceLayer({ ...input, tracesDatasetName: RELAY_AXIOM_TRACE_DATASET }),
      ),
      Layer.unwrap,
    );
    const randomApnsDeliveryJobSigningSecret = yield* Alchemy.Random(
      "ApnsDeliveryJobSigningSecret",
      { bytes: 32 },
    );
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret.text;
    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const db = yield* Drizzle.postgres(hyperdrive.connectionString);

    const loadSettings = Effect.gen(function* () {
      const workerEnvironment = yield* Cloudflare.WorkerEnvironment;
      const apnsPrivateKey = Redacted.make(workerEnvironment.APNS_PRIVATE_KEY);
      const clerkSecretKey = Redacted.make(workerEnvironment.CLERK_SECRET_KEY);
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: RELAY_PUBLIC_ORIGIN,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: MANAGED_ENDPOINT_BASE_DOMAIN,
        cloudflareAccountId: MANAGED_ENDPOINT_ZONE.accountId,
        cloudflareZoneId: MANAGED_ENDPOINT_ZONE.zoneId,
        cloudflareApiToken: yield* managedEndpointCloudflareApiToken,
      });
    });

    const runtimeLayer = Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        return Layer.mergeAll(
          MobileRegistrations.layer.pipe(Layer.provideMerge(AgentActivityPublisher.layer)),
          EnvironmentConnector.layer,
          EnvironmentLinker.layer.pipe(
            Layer.provideMerge(ManagedEndpointProvider.layer),
            Layer.provideMerge(DpopProofs.layer),
          ),
          EnvironmentPublishSignatures.layer.pipe(Layer.provideMerge(DpopProofs.layer)),
          DpopProofs.layer,
        ).pipe(
          Layer.provide(ApnsDeliveries.layer),
          Layer.provide(ApnsDeliveryQueue.layer),
          Layer.provide(AgentActivityRows.layer),
          Layer.provide(Devices.layer),
          Layer.provide(EnvironmentCredentials.layer),
          Layer.provide(EnvironmentLinks.layer),
          Layer.provide(LiveActivities.layer),
          Layer.provide(DeliveryAttempts.layer),
          Layer.provide(Layer.succeed(RelayDb, db)),
          Layer.provide(
            Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
              send: (body) =>
                apnsDeliveryQueueSender
                  .send(body)
                  .pipe(
                    Effect.mapError(
                      (cause) => new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({ cause }),
                    ),
                  ) as Effect.Effect<void, ApnsDeliveryQueue.ApnsDeliveryQueueSendError>,
            }),
          ),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
          Layer.provide(RelayCrypto.layer),
        );
      }),
    );

    const appLayer = Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        return relayApiLayer.pipe(
          Layer.provide(runtimeLayer),
          Layer.provide(relayClientAuthLayer),
          Layer.provide(relayDpopClientAuthLayer),
          Layer.provide(relayEnvironmentAuthLayer),
          Layer.provide(EnvironmentCredentials.layer),
          Layer.provide(EnvironmentLinks.layer),
          Layer.provide(Layer.succeed(RelayDb, db)),
          Layer.provideMerge(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
          Layer.provide(RelayCrypto.layer),
        );
      }),
    );

    yield* Cloudflare.messages<unknown>(apnsDeliveryQueue, {
      batchSize: 10,
      maxRetries: 5,
      maxWaitTime: "5 seconds",
      retryDelay: "30 seconds",
      // Alchemy beta.45 expects a resolved string here although Queue names are Outputs.
      deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
    }).subscribe((stream) =>
      stream.pipe(
        Stream.withSpan("relay.apn_delivery_queue.process_batch"),
        Stream.runForEach(
          Effect.fn("relay.apn_delivery_queue.process_message")((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
            ),
          ),
        ),
        Effect.provide(runtimeLayer),
      ),
    );

    yield* Cloudflare.cron("*/5 * * * *").subscribe(() =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        Effect.withSpan("relay.cron.prune_expired_dpop_proofs"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      HttpApiBuilder.layer(RelayApi).pipe(
        Layer.provide(appLayer),
        Layer.provide([Etag.layerWeak, RelayHttpPlatformLayer, relayCors]),
      ),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.map((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
      Effect.flatten,
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.HyperdriveBindingLive,
        Cloudflare.CronEventSourceLive,
        Cloudflare.QueueBindingLive,
        Cloudflare.QueueEventSourceLive,
      ),
    ),
  ),
) {}
