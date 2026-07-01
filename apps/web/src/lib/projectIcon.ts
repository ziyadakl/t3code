import { iconNames, type IconName } from "lucide-react/dynamic";

/**
 * Membership set of every valid lucide icon name, built once at module load.
 * `iconNames` is a ~1600-entry array, so an `.includes` scan on every render is
 * wasteful — a `Set` gives O(1) lookups instead.
 */
const iconNameSet: ReadonlySet<string> = new Set(iconNames);

/**
 * Validate a stored icon-override name against the live lucide icon list.
 *
 * Returns the name typed as `IconName` when it is a real lucide icon, or `null`
 * for anything absent/unknown (empty, stale, or removed by version drift) so
 * callers fall back to their favicon/folder default instead of rendering a
 * broken icon. Shared by `ProjectFavicon` and `ProjectIconPicker` so both guard
 * the override identically.
 */
export function resolveValidIconName(name: string | null | undefined): IconName | null {
  return name && iconNameSet.has(name) ? (name as IconName) : null;
}
