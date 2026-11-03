/**
 * Fork (sidebar project groups): the "Float to the top" client setting and the
 * patch merge it needs. `settings.ts` re-exports this file, so every import of
 * `@t3tools/contracts/settings` keeps working.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { ClientSettings, ClientSettingsPatch } from "./settings.ts";

/**
 * Which sidebar top statuses float a thread above the project groups. Keys
 * match the web sidebar's `SidebarV2TopStatusKind` (minus `working`, which
 * lives in the Working shelf). A missing key decodes to its default.
 */
export const SidebarFloatToTopStatuses = Schema.Struct({
  done: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  input: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  approval: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  failed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  woke: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  limited: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  waiting: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SidebarFloatToTopStatuses = typeof SidebarFloatToTopStatuses.Type;
export type SidebarFloatToTopStatus = keyof SidebarFloatToTopStatuses;

/** A "Float to the top" update: statuses it leaves out keep their saved value. */
export const SidebarFloatToTopStatusesPatch = Schema.Struct({
  done: Schema.optionalKey(Schema.Boolean),
  input: Schema.optionalKey(Schema.Boolean),
  approval: Schema.optionalKey(Schema.Boolean),
  failed: Schema.optionalKey(Schema.Boolean),
  woke: Schema.optionalKey(Schema.Boolean),
  limited: Schema.optionalKey(Schema.Boolean),
  waiting: Schema.optionalKey(Schema.Boolean),
});

/** The statuses switched on in a "Float to the top" record. */
export function resolveSidebarFloatToTopStatusSet(
  statuses: SidebarFloatToTopStatuses,
): ReadonlySet<SidebarFloatToTopStatus> {
  return new Set(Struct.keys(statuses).filter((status) => statuses[status]));
}

/**
 * Applies a client-settings patch. Top-level keys replace the saved value; the
 * "Float to the top" record merges, so a patch naming some statuses keeps the rest.
 */
export function applyClientSettingsPatch(
  current: ClientSettings,
  patch: ClientSettingsPatch,
): ClientSettings {
  const { sidebarFloatToTopStatuses, ...rest } = patch;
  return {
    ...current,
    ...rest,
    ...(sidebarFloatToTopStatuses === undefined
      ? {}
      : {
          sidebarFloatToTopStatuses: {
            ...current.sidebarFloatToTopStatuses,
            ...sidebarFloatToTopStatuses,
          },
        }),
  };
}
