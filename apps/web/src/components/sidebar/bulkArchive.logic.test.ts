import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  archiveSelectedThreadEntries,
  archiveThreadsAndReport,
  buildBulkArchiveContextMenuItem,
  refreshBulkArchiveTargets,
  resolveBulkArchiveCompletion,
} from "./bulkArchive.logic";

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("archiveThreadsAndReport", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const run = async (
    archive: (
      entry: (typeof entries)[number],
      onArchived: () => void,
    ) => Promise<AsyncResult.Success<void, unknown> | AsyncResult.Failure<void, unknown>>,
  ) => {
    const errors: Array<{ title: string; description: string }> = [];
    const removeFromSelection = vi.fn();
    const onAllArchived = vi.fn();
    await archiveThreadsAndReport({
      entries,
      archive,
      reportError: (title, description) => errors.push({ title, description }),
      removeFromSelection,
      onAllArchived,
    });
    return { errors, removeFromSelection, onAllArchived };
  };

  it("finishes the selection when every thread archives", async () => {
    const { errors, removeFromSelection, onAllArchived } = await run(async (_entry, onArchived) => {
      onArchived();
      return AsyncResult.success(undefined);
    });
    expect(errors).toEqual([]);
    expect(removeFromSelection).not.toHaveBeenCalled();
    expect(onAllArchived).toHaveBeenCalledWith(["one", "two", "three"]);
  });

  it("reports a failed archive and keeps only the unarchived threads selected", async () => {
    const { errors, removeFromSelection, onAllArchived } = await run(async (entry, onArchived) => {
      if (entry.threadKey === "two") {
        return AsyncResult.failure(Cause.fail(new Error("Archive refused")));
      }
      onArchived();
      return AsyncResult.success(undefined);
    });
    expect(errors).toEqual([
      { title: "Failed to archive threads", description: "Archive refused" },
    ]);
    expect(removeFromSelection).toHaveBeenCalledWith(["one"]);
    expect(onAllArchived).not.toHaveBeenCalled();
  });

  it("stays quiet about an interrupted archive", async () => {
    const { errors, removeFromSelection } = await run(async () =>
      AsyncResult.failure(Cause.interrupt()),
    );
    expect(errors).toEqual([]);
    expect(removeFromSelection).toHaveBeenCalledWith([]);
  });

  it("reports a navigation failure after an archive but carries on", async () => {
    const { errors, onAllArchived } = await run(async (entry, onArchived) => {
      onArchived();
      return entry.threadKey === "two"
        ? AsyncResult.failure(Cause.fail(new Error("Navigation broke")))
        : AsyncResult.success(undefined);
    });
    expect(errors).toEqual([
      { title: "Thread archived, but navigation failed", description: "Navigation broke" },
    ]);
    expect(onAllArchived).toHaveBeenCalledTimes(1);
  });
});

describe("buildBulkArchiveContextMenuItem", () => {
  const thread = (
    archivedAt: string | null,
    runtimeStatus: "idle" | "running" | "queued" = "idle",
  ) => ({
    archivedAt,
    runtime: {
      status: runtimeStatus,
      activeRunId: runtimeStatus === "idle" ? null : RunId.make("run-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  });

  it("archives only the threads the single-row action could archive", () => {
    const archivable = thread(null);
    const { item, targets } = buildBulkArchiveContextMenuItem({
      threads: [archivable, thread(null, "running"), thread("2026-10-01T00:00:00.000Z")],
    });
    expect(item).toEqual({ id: "archive", label: "Archive (1)", disabled: false });
    expect(targets).toEqual([archivable]);
  });

  it("stays visible but disabled when nothing selected can be archived", () => {
    const { item, targets } = buildBulkArchiveContextMenuItem({
      threads: [thread(null, "running"), thread(null, "queued")],
    });
    expect(item).toEqual({ id: "archive", label: "Archive (0)", disabled: true });
    expect(targets).toEqual([]);
  });
});

describe("resolveBulkArchiveCompletion", () => {
  it("clears the selection when nothing was skipped", () => {
    expect(
      resolveBulkArchiveCompletion({ archivedThreadKeys: ["one", "two"], skippedCount: 0 }),
    ).toEqual({ selection: "clear" });
  });

  it("deselects only the archived threads and counts the skipped ones", () => {
    expect(
      resolveBulkArchiveCompletion({ archivedThreadKeys: ["one", "two"], skippedCount: 1 }),
    ).toEqual({
      selection: "keep-skipped",
      notice: {
        title: "Archived 2 threads",
        description: "1 was skipped because it started running or was already archived.",
      },
    });
  });

  it("keeps the selection and says so when nothing was left to archive", () => {
    expect(resolveBulkArchiveCompletion({ archivedThreadKeys: [], skippedCount: 3 })).toEqual({
      selection: "keep-skipped",
      notice: {
        title: "Nothing archived",
        description: "The selected threads started running or were already archived.",
      },
    });
  });
});

describe("refreshBulkArchiveTargets", () => {
  const thread = (id: string, archivedAt: string | null, runtimeStatus: "idle" | "running") => ({
    id,
    archivedAt,
    runtime: {
      status: runtimeStatus,
      activeRunId: runtimeStatus === "idle" ? null : RunId.make("run-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  });

  it("skips targets that started running, were archived, or vanished since the menu opened", () => {
    const stillIdle = thread("idle", null, "idle");
    const current = new Map([
      ["idle", stillIdle],
      ["now-running", thread("now-running", null, "running")],
      ["now-archived", thread("now-archived", "2026-10-02T00:00:00.000Z", "idle")],
    ]);
    const targets = ["idle", "now-running", "now-archived", "gone"].map((id) =>
      thread(id, null, "idle"),
    );

    expect(refreshBulkArchiveTargets(targets, (target) => current.get(target.id))).toEqual([
      stillIdle,
    ]);
  });
});
