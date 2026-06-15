import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireProjectArchived,
  requireProjectNotArchived,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it.effect("requires existing thread", () =>
    Effect.gen(function* () {
      const thread = yield* requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      });
      expect(thread.id).toBe(ThreadId.make("thread-1"));

      const error = yield* Effect.flip(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );

  it.effect("requires missing thread for create flows", () =>
    Effect.gen(function* () {
      yield* requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      });

      const error = yield* Effect.flip(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      );
      expect(error.message).toContain("already exists");
    }),
  );

  it.effect("guards project archive state", () =>
    Effect.gen(function* () {
      const archiveReadModel: OrchestrationReadModel = {
        ...readModel,
        projects: readModel.projects.map((project) =>
          project.id === ProjectId.make("project-b")
            ? { ...project, archivedAt: now }
            : project,
        ),
      };

      const archiveCommand: OrchestrationCommand = {
        type: "project.archive",
        commandId: CommandId.make("cmd-project-archive"),
        projectId: ProjectId.make("project-a"),
      };
      const unarchiveCommand: OrchestrationCommand = {
        type: "project.unarchive",
        commandId: CommandId.make("cmd-project-unarchive"),
        projectId: ProjectId.make("project-b"),
      };

      // An active project can be archived; an already-archived one cannot.
      const activeProject = yield* requireProjectNotArchived({
        readModel: archiveReadModel,
        command: archiveCommand,
        projectId: ProjectId.make("project-a"),
      });
      expect(activeProject.id).toBe(ProjectId.make("project-a"));

      const archivedError = yield* Effect.flip(
        requireProjectNotArchived({
          readModel: archiveReadModel,
          command: { ...archiveCommand, projectId: ProjectId.make("project-b") },
          projectId: ProjectId.make("project-b"),
        }),
      );
      expect(archivedError.message).toContain("already archived");

      // An archived project can be unarchived; an active one cannot.
      const archivedProject = yield* requireProjectArchived({
        readModel: archiveReadModel,
        command: unarchiveCommand,
        projectId: ProjectId.make("project-b"),
      });
      expect(archivedProject.id).toBe(ProjectId.make("project-b"));

      const notArchivedError = yield* Effect.flip(
        requireProjectArchived({
          readModel: archiveReadModel,
          command: { ...unarchiveCommand, projectId: ProjectId.make("project-a") },
          projectId: ProjectId.make("project-a"),
        }),
      );
      expect(notArchivedError.message).toContain("is not archived");
    }),
  );

  it.effect("requires non-negative integers", () =>
    Effect.gen(function* () {
      yield* requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      });

      const error = yield* Effect.flip(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      );
      expect(error.message).toContain("greater than or equal to 0");
    }),
  );
});
