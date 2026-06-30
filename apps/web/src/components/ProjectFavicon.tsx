import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { colorOverrideStyle, useProjectColorOverride } from "../hooks/useProjectColorOverride";
import { useSettings } from "../hooks/useSettings";
import { derivePhysicalProjectKeyFromPath } from "../logicalProject";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
}) {
  const src = (() => {
    try {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: { cwd: input.cwd },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );
  const physicalKey = derivePhysicalProjectKeyFromPath(input.environmentId, input.cwd);
  // A user-chosen icon overrides the favicon scan entirely. Validate the stored
  // name against the live lucide icon list so a stale/removed name (version
  // drift) falls back to the favicon/folder default instead of a broken icon.
  const iconOverride = useSettings((s) => s.projectIconOverrides?.[physicalKey]);
  const validIconName =
    iconOverride && (iconNames as readonly string[]).includes(iconOverride)
      ? (iconOverride as IconName)
      : null;
  // Optional per-project tint. lucide icons render with currentColor, so a
  // `style={{ color }}` flows through. The favicon <img> is left untinted.
  const colorOverride = useProjectColorOverride(input.environmentId, input.cwd);
  const colorStyle = colorOverrideStyle(colorOverride);

  if (validIconName) {
    return (
      <DynamicIcon
        name={validIconName}
        className={`size-3.5 shrink-0 ${input.className ?? ""}`}
        style={colorStyle}
      />
    );
  }

  if (!src) {
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        style={colorStyle}
      />
    );
  }

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
          style={colorStyle}
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
