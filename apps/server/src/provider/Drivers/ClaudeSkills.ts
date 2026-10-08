/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The user root wins on name collisions,
 * matching the CLI. `.agents/skills` is a Codex location: verified against the
 * CLI, a skill that lives only there is answered with `Unknown command`, so it
 * is not scanned here. Enabled plugins add their skills and commands as
 * `plugin:name`, and `commands/*.md` in both roots add custom commands, which
 * run exactly like skills; see {@link discoverClaudeSkills}.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project" | "plugin";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Claude Code accepts plain scalars containing `: `. Repair only those,
    // leaving comments and YAML structure for the full-document parser.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

// Decoded apart from `skillOverrides`, so a bad entry in one map never costs
// the other. Values other than booleans are ignored.
const EnabledPluginsSettings = fromLenientJson(
  Schema.Struct({
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeEnabledPluginsSettings = Schema.decodeUnknownEffect(EnabledPluginsSettings);

interface ClaudeSkillSettings {
  readonly skillOverrides: ReadonlyMap<string, SkillOverride>;
  /** `enabledPlugins`, keyed `plugin@marketplace`; later files win. */
  readonly enabledPlugins: ReadonlyMap<string, boolean>;
}

const readClaudeSkillSettings = Effect.fn("readClaudeSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  repositoryRoot: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeSkillSettings, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }

    const plugins = yield* decodeEnabledPluginsSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [key, value] of Object.entries(plugins?.enabledPlugins ?? {})) {
      if (typeof value === "boolean") {
        enabledPlugins.set(key, value);
      }
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins };
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/** A file that may publish one slash command, before its frontmatter is read. */
interface SkillCandidate {
  readonly name: string;
  readonly path: string;
  readonly scope: ClaudeSkillScope;
  /** Inline body of a manifest-declared command; otherwise `path` is read. */
  readonly contents?: string;
  readonly description?: string;
}

const listDirectory = Effect.fn("listDirectory")(function* (
  directory: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return [...entries].sort();
});

/** `<directory>/<name>/SKILL.md` folders, named `<prefix><name>`. */
const skillFolderCandidates = Effect.fn("skillFolderCandidates")(function* (
  directory: string,
  scope: ClaudeSkillScope,
  prefix = "",
): Effect.fn.Return<ReadonlyArray<SkillCandidate>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return (yield* listDirectory(directory)).map((entry) => ({
    name: `${prefix}${entry.trim()}`,
    path: path.join(directory, entry, "SKILL.md"),
    scope,
  }));
});

/**
 * Top-level `<directory>/<name>.md` command files. Subfolders are skipped:
 * how Claude Code names a nested command is not settled here, and offering a
 * guessed name would dispatch a command the CLI does not know.
 */
const commandFileCandidates = Effect.fn("commandFileCandidates")(function* (
  directory: string,
  scope: ClaudeSkillScope,
  prefix = "",
): Effect.fn.Return<ReadonlyArray<SkillCandidate>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return (yield* listDirectory(directory))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => ({
      name: `${prefix}${entry.slice(0, -".md".length).trim()}`,
      path: path.join(directory, entry),
      scope,
    }));
});

const InstalledPlugins = fromLenientJson(
  Schema.Struct({
    plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
  }),
);
const decodeInstalledPlugins = Schema.decodeUnknownEffect(InstalledPlugins);
const PluginInstall = Schema.Struct({
  scope: Schema.optional(Schema.String),
  projectPath: Schema.optional(Schema.String),
  installPath: Schema.String,
});
const decodePluginInstall = Schema.decodeUnknownOption(PluginInstall);

const PluginManifest = fromLenientJson(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    defaultEnabled: Schema.optional(Schema.Boolean),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    commands: Schema.optional(Schema.Unknown),
  }),
);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);

/**
 * Skills and commands of every enabled plugin, named `<plugin>:<name>` after
 * the manifest `name` (the install key's plugin part when there is no
 * manifest). A plugin counts when `installed_plugins.json` records it for the
 * user, or for this project, and `enabledPlugins` does not switch it off; an
 * unlisted plugin follows its manifest's `defaultEnabled`, which defaults on.
 * `skills` paths add to the default `skills/` folder, each either a folder of
 * skills or one skill; `commands` paths or a name map replace `commands/`.
 * Paths that escape the plugin root are ignored, as Claude Code ignores them.
 */
const pluginCandidates = Effect.fn("pluginCandidates")(function* (
  configDirPath: string,
  projectPaths: ReadonlyArray<string>,
  enabledPlugins: ReadonlyMap<string, boolean>,
): Effect.fn.Return<
  {
    readonly skills: ReadonlyArray<SkillCandidate>;
    readonly commands: ReadonlyArray<SkillCandidate>;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: Array<SkillCandidate> = [];
  const commands: Array<SkillCandidate> = [];

  const installed = yield* fileSystem
    .readFileString(path.join(configDirPath, "plugins", "installed_plugins.json"))
    .pipe(
      Effect.flatMap(decodeInstalledPlugins),
      Effect.orElseSucceed(() => undefined),
    );

  for (const [key, rawInstalls] of Object.entries(installed?.plugins ?? {})) {
    if (enabledPlugins.get(key) === false) {
      continue;
    }
    const installs = rawInstalls.flatMap((raw) => {
      const decoded = decodePluginInstall(raw);
      return decoded._tag === "Some" ? [decoded.value] : [];
    });
    const install =
      installs.find(
        (entry) =>
          entry.scope !== "user" &&
          entry.projectPath !== undefined &&
          projectPaths.includes(path.resolve(entry.projectPath)),
      ) ?? installs.find((entry) => entry.scope === "user");
    if (!install) {
      continue;
    }

    const root = path.resolve(install.installPath);
    const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
    const manifest = yield* fileSystem.readFileString(manifestPath).pipe(
      Effect.flatMap(decodePluginManifest),
      Effect.orElseSucceed(() => undefined),
    );
    if (!enabledPlugins.has(key) && manifest?.defaultEnabled === false) {
      continue;
    }
    const pluginName = manifest?.name?.trim() || key.split("@")[0]?.trim();
    if (!pluginName) {
      continue;
    }
    const prefix = `${pluginName}:`;
    const inside = (relativePath: string) => {
      const resolved = path.resolve(root, relativePath);
      const relative = path.relative(root, resolved);
      return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : resolved;
    };

    const skillPaths = [manifest?.skills ?? []].flat();
    for (const directory of [
      path.join(root, "skills"),
      ...skillPaths.flatMap((entry) => inside(entry) ?? []),
    ]) {
      const skillFile = path.join(directory, "SKILL.md");
      const isSingleSkill = yield* fileSystem
        .exists(skillFile)
        .pipe(Effect.orElseSucceed(() => false));
      if (isSingleSkill) {
        skills.push({
          name: `${prefix}${path.basename(directory)}`,
          path: skillFile,
          scope: "plugin",
        });
      } else {
        skills.push(...(yield* skillFolderCandidates(directory, "plugin", prefix)));
      }
    }

    const declared = manifest?.commands;
    if (declared === undefined) {
      commands.push(
        ...(yield* commandFileCandidates(path.join(root, "commands"), "plugin", prefix)),
      );
    } else if (typeof declared === "string" || Array.isArray(declared)) {
      for (const entry of [declared].flat()) {
        const resolved = typeof entry === "string" ? inside(entry) : undefined;
        if (resolved === undefined) {
          continue;
        }
        if (resolved.endsWith(".md")) {
          commands.push({
            name: `${prefix}${path.basename(resolved, ".md")}`,
            path: resolved,
            scope: "plugin",
          });
        } else {
          commands.push(...(yield* commandFileCandidates(resolved, "plugin", prefix)));
        }
      }
    } else if (typeof declared === "object" && declared !== null) {
      for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) {
          continue;
        }
        const entry = value as Record<string, unknown>;
        const source = typeof entry.source === "string" ? inside(entry.source) : undefined;
        const content = typeof entry.content === "string" ? entry.content : undefined;
        if (source === undefined && content === undefined) {
          continue;
        }
        const description = typeof entry.description === "string" ? entry.description.trim() : "";
        commands.push({
          name: `${prefix}${name.trim()}`,
          path: source ?? manifestPath,
          scope: "plugin",
          ...(source === undefined && content !== undefined ? { contents: content } : {}),
          ...(description ? { description } : {}),
        });
      }
    }
  }

  return { skills, commands };
});

/**
 * Enumerate the slash commands Claude Code publishes from files: skills in the
 * user config dir and the workspace `.claude/skills`, then those of enabled
 * plugins, then custom commands (`commands/*.md` in both places, and each
 * plugin's). Claude Code treats a command file as a skill with the same
 * frontmatter, so commands join the same list; a skill wins over a command of
 * the same name, as it does in the CLI. Discovery is best-effort: unreadable
 * roots and malformed entries are skipped so a broken skill never degrades
 * the provider snapshot. Sources are listed highest precedence first and the
 * first hit for a name wins, matching Claude Code: verified against the CLI
 * with the same skill name in both scopes, the user copy is the one that
 * runs. Reporting the project copy instead would attach its invocation
 * metadata to a command Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);
  const { skillOverrides, enabledPlugins } = yield* readClaudeSkillSettings(
    configDirPath,
    cwd,
    repositoryRoot,
    environment ?? process.env,
  );
  const projectClaudeDir = cwd ? path.join(cwd, ".claude") : undefined;
  const plugins = yield* pluginCandidates(
    configDirPath,
    [cwd, repositoryRoot].flatMap((directory) => (directory ? [path.resolve(directory)] : [])),
    enabledPlugins,
  );

  const candidates: ReadonlyArray<SkillCandidate> = [
    ...(yield* skillFolderCandidates(path.join(configDirPath, "skills"), "user")),
    ...(projectClaudeDir
      ? yield* skillFolderCandidates(path.join(projectClaudeDir, "skills"), "project")
      : []),
    ...plugins.skills,
    ...(yield* commandFileCandidates(path.join(configDirPath, "commands"), "user")),
    ...(projectClaudeDir
      ? yield* commandFileCandidates(path.join(projectClaudeDir, "commands"), "project")
      : []),
    ...plugins.commands,
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const candidate of candidates) {
    // Claude Code identifies a skill by its directory (a command by its file
    // name), not by the frontmatter `name`: verified against the CLI, a skill
    // in `probe-alias/` declaring `name: probe-alias-frontmatter` is published
    // as `probe-alias`, and only `skillOverrides["probe-alias"]` switches it
    // off. Keying off the frontmatter name would report a command that does
    // not exist and miss the override that disables it.
    const name = candidate.name;
    // First source wins, so a later one never displaces a higher-precedence
    // skill of the same name.
    if (!name || name.endsWith(":") || skillsByName.has(name)) {
      continue;
    }

    const contents =
      candidate.contents ??
      (yield* fileSystem
        .readFileString(candidate.path)
        .pipe(Effect.orElseSucceed(() => undefined)));
    if (contents === undefined) {
      continue;
    }

    const frontmatter = parseSkillFrontmatter(contents);
    // Malformed frontmatter means the skill won't load in Claude Code
    // either — skip it rather than surfacing a broken entry under its
    // directory name.
    if (frontmatter.kind === "malformed") {
      continue;
    }

    const override = skillOverrides.get(name);
    const userInvocationOnly =
      (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
      override?.userInvocationOnly === true;
    const description =
      candidate.description ??
      (frontmatter.kind === "parsed" ? frontmatter.description : undefined);
    skillsByName.set(name, {
      name,
      path: candidate.path,
      enabled: override?.enabled ?? true,
      scope: candidate.scope,
      ...(description ? { description } : {}),
      ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
      ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
        ? { userInvocable: false }
        : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
