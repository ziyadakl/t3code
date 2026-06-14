/**
 * SandcastleStatusReader — reads <cwd>/.sandcastle/status.json for a set of
 * project cwds on THIS environment's machine and returns parsed entries plus
 * the reading server's clock. Read-only; never writes. Mirrors the service
 * shape of devServer/DevServerRunner.ts.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type {
  SandcastleStatusAllPayload,
  SandcastleStatusAllResult,
  SandcastleStatusEntry,
} from "@t3tools/contracts";
import { SandcastleError } from "@t3tools/contracts";
import { buildStatusEntry } from "./buildStatusEntry.ts";

export interface SandcastleStatusReaderShape {
  statusAll(
    payload: SandcastleStatusAllPayload,
  ): Effect.Effect<SandcastleStatusAllResult, SandcastleError>;
}

export class SandcastleStatusReader extends Context.Service<
  SandcastleStatusReader,
  SandcastleStatusReaderShape
>()("t3/sandcastle/SandcastleStatusReader") {}

/** Absolute paths for a project's Sandcastle dir + status file. */
export function sandcastleDir(cwd: string): string {
  return `${cwd}/.sandcastle`;
}
export function sandcastleStatusPath(cwd: string): string {
  return `${sandcastleDir(cwd)}/status.json`;
}

const makeReader = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const readOne = (cwd: string): Effect.Effect<SandcastleStatusEntry> =>
    Effect.gen(function* () {
      const hasSandcastleDir = yield* fileSystem
        .exists(sandcastleDir(cwd))
        .pipe(Effect.orElseSucceed(() => false));

      const rawJson = hasSandcastleDir
        ? yield* fileSystem
            .readFileString(sandcastleStatusPath(cwd))
            .pipe(Effect.map((s): string | null => s), Effect.orElseSucceed(() => null))
        : null;

      return buildStatusEntry({ cwd, hasSandcastleDir, rawJson });
    });

  const statusAll = (
    payload: SandcastleStatusAllPayload,
  ): Effect.Effect<SandcastleStatusAllResult, SandcastleError> =>
    Effect.gen(function* () {
      const entries = yield* Effect.forEach(payload.cwds, readOne, {
        concurrency: 8,
      });
      const now = yield* DateTime.now;
      return {
        serverNow: DateTime.formatIso(now),
        entries,
      };
    }).pipe(
      Effect.catch((cause) =>
        Effect.fail(new SandcastleError({ message: String(cause) })),
      ),
    );

  return { statusAll } satisfies SandcastleStatusReaderShape;
});

export const SandcastleStatusReaderLive = Layer.effect(
  SandcastleStatusReader,
  makeReader,
);
