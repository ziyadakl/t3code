import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import { withUserId } from "./telemetry.ts";

describe("relay telemetry", () => {
  it.effect("annotates the active span and descendant spans with the user id", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      yield* Effect.succeed("ok").pipe(
        Effect.withSpan("relay.test.child"),
        withUserId("user-123"),
        Effect.withSpan("relay.test.parent"),
        Effect.provide(Layer.succeed(Tracer.Tracer, tracer)),
      );

      expect(spans.map((span) => span.name)).toEqual(["relay.test.parent", "relay.test.child"]);
      expect(spans.map((span) => span.attributes.get("user.id"))).toEqual(["user-123", "user-123"]);
    }),
  );
});
