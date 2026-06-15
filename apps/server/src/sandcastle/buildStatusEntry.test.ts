import { describe, it, expect } from "vite-plus/test";
import { buildStatusEntry } from "./buildStatusEntry.ts";

const VALID = JSON.stringify({
  schemaVersion: 1,
  state: "running",
  run: {
    branch: "b",
    repo: "r",
    startedAt: "2026-06-04T12:00:00.000Z",
    iterations: { current: 1, total: 10 },
    maxConcurrent: 1,
  },
  totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
  issues: [],
  updatedAt: "2026-06-04T12:00:00.000Z",
});

describe("buildStatusEntry", () => {
  it("returns disabled entry when .sandcastle dir is absent", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: false, rawJson: null });
    expect(e.hasSandcastleDir).toBe(false);
    expect(e.snapshot).toBeNull();
    expect(e.schemaOutdated).toBe(false);
    expect(e.readError).toBeNull();
  });

  it("returns enabled-but-no-run when dir exists but status.json is missing", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: null });
    expect(e.hasSandcastleDir).toBe(true);
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeNull();
  });

  it("parses a valid status.json", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: VALID });
    expect(e.snapshot?.state).toBe("running");
    expect(e.schemaOutdated).toBe(false);
    expect(e.readError).toBeNull();
  });

  it("flags schemaOutdated when version differs and does not throw", () => {
    const future = JSON.stringify({ ...JSON.parse(VALID), schemaVersion: 2 });
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: future });
    expect(e.schemaOutdated).toBe(true);
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeNull();
  });

  it("records a readError on malformed JSON", () => {
    const e = buildStatusEntry({ cwd: "/p", hasSandcastleDir: true, rawJson: "{not json" });
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeTruthy();
  });

  it("records a readError when JSON is valid but shape is wrong", () => {
    const e = buildStatusEntry({
      cwd: "/p",
      hasSandcastleDir: true,
      rawJson: JSON.stringify({ schemaVersion: 1, state: "nope" }),
    });
    expect(e.snapshot).toBeNull();
    expect(e.readError).toBeTruthy();
  });
});
