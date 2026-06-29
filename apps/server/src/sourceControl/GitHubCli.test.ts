import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listOpenIssuesByLabel: decodes ready rows and maps label objects to names", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const readyJson = JSON.stringify([
        {
          number: 493,
          body: "Blocked by: #2",
          labels: [{ name: "ready-for-agent" }, { name: "type:feature" }],
        },
        { number: 501, body: "", labels: [{ name: "ready-for-agent" }] },
        // GitHub can return a null body — it must normalize to "" rather than fail the decode.
        { number: 502, body: null, labels: [{ name: "ready-for-agent" }] },
      ]);
      mockRun.mockReturnValue(Effect.succeed(processOutput(readyJson)));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenIssuesByLabel({
        cwd: "/repo",
        label: "ready-for-agent",
      });

      assert.deepStrictEqual(result, [
        { number: 493, body: "Blocked by: #2", labels: ["ready-for-agent", "type:feature"] },
        { number: 501, body: "", labels: ["ready-for-agent"] },
        { number: 502, body: "", labels: ["ready-for-agent"] },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "issue",
          "list",
          "--label",
          "ready-for-agent",
          "--state",
          "open",
          "--json",
          "number,body,labels",
          "--limit",
          "100",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listOpenIssuesByLabel: returns [] when gh returns nothing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenIssuesByLabel({ cwd: "/repo", label: "ready-for-agent" });

      assert.deepStrictEqual(result, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listOpenIssueNumbers: decodes the open-issue number set", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const openJson = JSON.stringify([{ number: 2 }, { number: 493 }, { number: 501 }]);
      mockRun.mockReturnValue(Effect.succeed(processOutput(openJson)));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenIssueNumbers({ cwd: "/repo" });

      assert.deepStrictEqual(result, [2, 493, 501]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["issue", "list", "--state", "open", "--json", "number", "--limit", "200"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listOpenIssueNumbers: returns [] when gh returns nothing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenIssueNumbers({ cwd: "/repo" });

      assert.deepStrictEqual(result, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listOpenIssuesByLabel: maps an unauthenticated gh failure to a friendly error", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh issue list",
            cwd: "/repo",
            exitCode: 1,
            detail: "You are not logged in. Run gh auth login to authenticate.",
          }),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .listOpenIssuesByLabel({ cwd: "/repo", label: "ready-for-agent" })
        .pipe(Effect.flip);

      assert.equal(error.detail.includes("not authenticated"), true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh pr view",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
          }),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }).pipe(Effect.provide(layer)),
  );

  describe("classifies the failure reason", () => {
    it.effect("missing — gh not on PATH", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh issue list",
              cwd: "/repo",
              exitCode: 1,
              detail: "spawn gh ENOENT",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh
          .listOpenIssuesByLabel({ cwd: "/repo", label: "ready-for-agent" })
          .pipe(Effect.flip);

        assert.equal(error.reason, "missing");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("unauthed — gh not logged in", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh issue list",
              cwd: "/repo",
              exitCode: 1,
              detail: "You are not logged in. Run gh auth login to authenticate.",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh
          .listOpenIssuesByLabel({ cwd: "/repo", label: "ready-for-agent" })
          .pipe(Effect.flip);

        assert.equal(error.reason, "unauthed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("not-found — pull request does not exist", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh pr view",
              cwd: "/repo",
              exitCode: 1,
              detail:
                "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh
          .getPullRequest({ cwd: "/repo", reference: "4888" })
          .pipe(Effect.flip);

        assert.equal(error.reason, "not-found");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("other — a generic query failure", () =>
      Effect.gen(function* () {
        mockRun.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessExitError({
              operation: "GitHubCli.execute",
              command: "gh issue list",
              cwd: "/repo",
              exitCode: 1,
              detail: "HTTP 500: something went wrong on github's side",
            }),
          ),
        );

        const gh = yield* GitHubCli.GitHubCli;
        const error = yield* gh.listOpenIssueNumbers({ cwd: "/repo" }).pipe(Effect.flip);

        assert.equal(error.reason, "other");
      }).pipe(Effect.provide(layer)),
    );
  });
});
