import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { devServerScript } from "./devServer";

function script(overrides: Partial<ProjectScript> & Pick<ProjectScript, "id" | "name">) {
  return {
    command: "pnpm run something",
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  } satisfies ProjectScript;
}

describe("devServerScript", () => {
  it("picks the action that has a preview URL", () => {
    const scripts = [
      script({ id: "test", name: "Test" }),
      script({ id: "web", name: "Web", previewUrl: "http://localhost:5173" }),
      script({ id: "dev", name: "Dev" }),
    ];
    expect(devServerScript(scripts)?.id).toBe("web");
  });

  it("falls back to an action named dev", () => {
    const scripts = [
      script({ id: "lint", name: "Lint" }),
      script({ id: "start-web", name: "Start dev server" }),
    ];
    expect(devServerScript(scripts)?.id).toBe("start-web");
  });

  it("never picks a worktree setup action", () => {
    const scripts = [
      script({
        id: "setup",
        name: "Setup dev env",
        runOnWorktreeCreate: true,
        previewUrl: "http://localhost:3000",
      }),
      script({ id: "devtools", name: "Devtools" }),
    ];
    expect(devServerScript(scripts)).toBeNull();
  });
});
