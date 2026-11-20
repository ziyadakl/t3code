import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { createContext, type MouseEvent } from "react";

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  /** The selected provider's skills, for the `/` list in a quote's note. */
  noteSkills?: { provider: ProviderDriverKind; skills: ReadonlyArray<ServerProviderSkill> };
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  openMention: () => {},
  openPullRequest: () => {},
});
