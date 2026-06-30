import { derivePhysicalProjectKeyFromPath } from "../logicalProject";
import { useSettings } from "./useSettings";

/**
 * Per-project sidebar tint color (a CSS hex string), keyed by the physical
 * project key `${environmentId}:${normalizedCwd}` (see
 * `derivePhysicalProjectKeyFromPath`). Centralises the `projectColorOverrides`
 * selector so the favicon icon, the project title, and the icon picker all read
 * the color the same way.
 */
export function useProjectColorOverride(
  environmentId: string,
  cwd: string,
): string | undefined {
  const key = derivePhysicalProjectKeyFromPath(environmentId, cwd);
  return useSettings((settings) => settings.projectColorOverrides?.[key]);
}

/** Inline `style` applying a tint color, or `undefined` when no color is set. */
export function colorOverrideStyle(
  color: string | undefined,
): { color: string } | undefined {
  return color ? { color } : undefined;
}
