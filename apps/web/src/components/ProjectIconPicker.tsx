import { useMemo, useState } from "react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { BanIcon, CheckIcon, FolderIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { useSettings, useUpdateSettings, getClientSettings } from "../hooks/useSettings";
import { useProjectColorOverride } from "../hooks/useProjectColorOverride";
import { resolveValidIconName } from "../lib/projectIcon";
import { derivePhysicalProjectKeyFromPath } from "../logicalProject";

/** Cap how many icons we mount at once — each DynamicIcon lazy-imports its own
 *  chunk, so rendering the full ~1600-name list would be wasteful. */
const MAX_RESULTS = 60;

/** Curated tint palette (Tailwind 500-ish hues). Stored as a CSS hex string in
 *  `projectColorOverrides`; applied to the lucide icon + project title. */
const COLOR_SWATCHES = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
] as const;

/**
 * Per-project sidebar icon chooser. Reads/writes the `projectIconOverrides`
 * client setting keyed by the project's physical key, so it never touches the
 * orchestration project aggregate. Selecting an icon applies immediately
 * (optimistic, like the sidebar grouping overrides); the chosen lucide icon
 * then overrides the favicon scan in ProjectFavicon.
 */
export function ProjectIconPicker({
  environmentId,
  cwd,
}: {
  environmentId: string;
  cwd: string;
}) {
  const key = derivePhysicalProjectKeyFromPath(environmentId, cwd);
  const current = useSettings((s) => s.projectIconOverrides?.[key]);
  // Guard the stored name against the live lucide list: a stale/removed name
  // falls back to the folder default rather than rendering a broken icon.
  const currentIcon = resolveValidIconName(current);
  const currentColor = useProjectColorOverride(environmentId, cwd);
  const { updateSettings } = useUpdateSettings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const names = q ? iconNames.filter((name) => name.includes(q)) : iconNames;
    return names.slice(0, MAX_RESULTS);
  }, [query]);

  const setIcon = (name: IconName | null) => {
    const overrides = { ...getClientSettings().projectIconOverrides };
    if (name) {
      overrides[key] = name;
    } else {
      delete overrides[key];
    }
    updateSettings({ projectIconOverrides: overrides });
    setOpen(false);
  };

  // Color is independent of the icon: leave the popover open so a user can set
  // both in one pass. Mirrors the icon merge-write, keyed by the same key.
  const setColor = (color: string | null) => {
    const overrides = { ...getClientSettings().projectColorOverrides };
    if (color) {
      overrides[key] = color;
    } else {
      delete overrides[key];
    }
    updateSettings({ projectColorOverrides: overrides });
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="size-9 shrink-0"
            aria-label="Choose project icon"
          />
        }
      >
        {currentIcon ? (
          <DynamicIcon name={currentIcon} className="size-4.5" />
        ) : (
          <FolderIcon className="size-4.5 text-muted-foreground/70" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            placeholder="Search icons…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5 text-xs hover:bg-accent/60"
            onClick={() => setIcon(null)}
          >
            <FolderIcon className="size-4 text-muted-foreground/70" />
            <span>Default (favicon)</span>
          </button>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLOR_SWATCHES.map((swatch) => {
              const isActive = currentColor?.toLowerCase() === swatch.value;
              return (
                <button
                  key={swatch.value}
                  type="button"
                  title={swatch.name}
                  aria-label={`${swatch.name} project color`}
                  aria-pressed={isActive}
                  onClick={() => setColor(swatch.value)}
                  className={`flex size-6 items-center justify-center rounded-full ring-offset-1 ring-offset-background ${
                    isActive ? "ring-2 ring-foreground/60" : "ring-0"
                  }`}
                  style={{ backgroundColor: swatch.value }}
                >
                  {isActive ? <CheckIcon className="size-3.5 text-white" /> : null}
                </button>
              );
            })}
            <button
              type="button"
              title="No color"
              aria-label="No project color"
              aria-pressed={!currentColor}
              onClick={() => setColor(null)}
              className={`flex size-6 items-center justify-center rounded-full border border-border/70 text-muted-foreground/70 hover:bg-accent/60 ${
                !currentColor ? "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background" : ""
              }`}
            >
              <BanIcon className="size-3.5" />
            </button>
          </div>
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto">
            {results.map((name) => {
              const isSelected = name === current;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  className={`flex items-center justify-center rounded-md border p-1.5 ${
                    isSelected
                      ? "border-primary/70 bg-primary/10"
                      : "border-transparent hover:bg-accent/60"
                  }`}
                  onClick={() => setIcon(name)}
                >
                  <DynamicIcon name={name} className="size-4" />
                </button>
              );
            })}
          </div>
          {results.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No icons match “{query}”.</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
