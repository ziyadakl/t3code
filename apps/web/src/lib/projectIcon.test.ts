import { describe, expect, it } from "vite-plus/test";
import { iconNames } from "lucide-react/dynamic";

import { resolveValidIconName } from "./projectIcon";

describe("resolveValidIconName", () => {
  it("returns a real lucide icon name unchanged", () => {
    const known = iconNames[0];
    expect(resolveValidIconName(known)).toBe(known);
    // A stable, well-known lucide name should also resolve.
    expect(resolveValidIconName("folder")).toBe("folder");
  });

  it("returns null for an unknown name", () => {
    expect(resolveValidIconName("definitely-not-a-lucide-icon")).toBeNull();
    expect(resolveValidIconName("")).toBeNull();
  });

  it("returns null for null or undefined", () => {
    expect(resolveValidIconName(null)).toBeNull();
    expect(resolveValidIconName(undefined)).toBeNull();
  });
});
