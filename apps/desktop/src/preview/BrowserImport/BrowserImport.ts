import type {
  BrowserImportInput,
  BrowserImportResult,
  BrowserImportSite,
  BrowserImportSitesInput,
  BrowserImportSource,
  BrowserImportUnavailableReason,
} from "@t3tools/contracts";
import { BrowserImportFailureReason } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as BrowserSession from "../BrowserSession.ts";
import {
  ChromiumCookieReadError,
  readChromiumCookieMetadata,
  readChromiumCookies,
} from "./ChromiumCookies.ts";
import type { CookieMetadata, CookieReadResult, ImportedCookie } from "./CookieDatabase.ts";
import {
  FirefoxCookieReadError,
  readFirefoxCookieMetadata,
  readFirefoxCookies,
} from "./FirefoxCookies.ts";
import {
  readSafariCookieMetadata,
  readSafariCookies,
  safariAccessDenied,
  SafariCookieReadError,
} from "./SafariCookies.ts";
import { groupSites, siteDomain } from "./Sites.ts";
import {
  BROWSER_IMPORT_SOURCES,
  resolveCookieDatabase,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePathContext,
  type BrowserImportEngine,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "./Sources.ts";

export class BrowserImportFailedError extends Schema.TaggedError<BrowserImportFailedError>()(
  "BrowserImportFailedError",
  {
    sourceId: Schema.String,
    reason: BrowserImportFailureReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The reason token is part of the message on purpose: IPC flattens the error
  // to its message, and the renderer maps that token back to user-facing copy.
  override get message(): string {
    return `Importing cookies from ${this.sourceId} failed: ${this.reason}.`;
  }
}

export class BrowserCookieWriteError extends Schema.TaggedError<BrowserCookieWriteError>()(
  "BrowserCookieWriteError",
  {
    url: Schema.String,
    name: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not write imported cookie ${this.name} for ${this.url}.`;
  }
}

export class BrowserImport extends Context.Service<
  BrowserImport,
  {
    readonly listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>>;
    /**
     * The sites a source profile holds cookies for, read from plaintext
     * metadata only: it never asks the keychain or decrypts a value.
     */
    readonly listSites: (
      input: BrowserImportSitesInput,
    ) => Effect.Effect<ReadonlyArray<BrowserImportSite>, BrowserImportFailedError>;
    readonly importCookies: (input: {
      readonly input: BrowserImportInput;
      readonly scope: string;
      readonly persistent: boolean;
      readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
    }) => Effect.Effect<BrowserImportResult, BrowserImportFailedError>;
  }
>()("@t3tools/desktop/preview/BrowserImport/BrowserImport") {}

const unavailableReason = Effect.fn("BrowserImport.unavailableReason")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<
  BrowserImportUnavailableReason | undefined,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  if (!definition.platforms.includes(context.platform)) return "unsupportedPlatform";
  if (!(yield* isSourceInstalled(definition, context))) return "notInstalled";
  if (yield* isSourceRunning(definition, context)) return "browserRunning";
  // Safari's jar is found by `stat`, which TCC permits without Full Disk Access
  // — so a Safari that lists as ready may still refuse the read.
  if (definition.engine === "safari") {
    const jar = yield* resolveCookieDatabase(definition, context, ".");
    if (jar !== undefined && (yield* safariAccessDenied(jar))) return "needsFullDiskAccess";
  }
  return undefined;
});

type CookieStoreReadError =
  | ChromiumCookieReadError
  | FirefoxCookieReadError
  | SafariCookieReadError;
type CookieStoreServices =
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner;

/** A plaintext engine's cookies, in the shape the Chromium read reports. */
const plaintextRead = (cookies: ReadonlyArray<ImportedCookie>): CookieReadResult => ({
  cookies,
  undecryptable: 0,
  undecryptableHosts: [],
});

/** The host a constructed cookie URL points at, for naming what was skipped. */
const cookieHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export const writeCookies = Effect.fn("BrowserImport.writeCookies")(function* (
  session: { readonly cookies: Pick<Session["cookies"], "set" | "flushStore"> },
  read: CookieReadResult,
) {
  let imported = 0;
  let skipped = read.undecryptable;
  const skippedDomains = new Set(read.undecryptableHosts);
  for (const cookie of read.cookies) {
    const written = yield* Effect.tryPromise({
      try: () =>
        session.cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          // Omitted for host-only cookies: Electron reads any `domain` as a
          // domain cookie and re-adds the leading dot, widening its scope.
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        }),
      catch: (cause) => new BrowserCookieWriteError({ url: cookie.url, name: cookie.name, cause }),
    }).pipe(
      Effect.as(true),
      Effect.tapError((error) => Effect.logDebug(error.message, { cause: error.cause })),
      Effect.catchTags({ BrowserCookieWriteError: () => Effect.succeed(false) }),
    );
    if (written) {
      imported += 1;
    } else {
      skipped += 1;
      skippedDomains.add(cookieHost(cookie.url));
    }
  }
  // `set` resolves once the cookie is in memory; Chromium writes the store to
  // disk on its own schedule. Flush before reporting "Done", so a crash right
  // after does not lose what the user was just told was imported.
  if (imported > 0) {
    yield* Effect.tryPromise(() => session.cookies.flushStore()).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Imported cookies could not be flushed to disk", { cause: error.cause }),
      ),
      Effect.ignore,
    );
  }
  return { imported, skipped, skippedDomains: [...skippedDomains].slice(0, 20) };
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* BrowserImportMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const platform = yield* HostProcess.Platform;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platformServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const pathContext = yield* sourcePathContext;

  const listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>> = Effect.forEach(
    BROWSER_IMPORT_SOURCES,
    Effect.fnUntraced(function* (definition) {
      const unavailable = yield* unavailableReason(definition, pathContext);
      return {
        id: definition.id,
        name: definition.name,
        profiles:
          unavailable === undefined ? yield* listSourceProfiles(definition, pathContext) : [],
        ...(unavailable === undefined ? {} : { unavailable }),
      } satisfies BrowserImportSource;
    }),
  ).pipe(Effect.provide(platformServices));

  /**
   * The checks both listing and importing make before touching a cookie
   * store: the source exists, is usable right now, and reported this profile.
   */
  const resolveSourceDatabase = Effect.fn("BrowserImport.resolveSourceDatabase")(function* (
    sourceId: string,
    sourceProfileDirectory: string,
  ) {
    const definition = BROWSER_IMPORT_SOURCES.find((candidate) => candidate.id === sourceId);
    if (!definition) {
      return yield* new BrowserImportFailedError({ sourceId, reason: "unknownSource" });
    }

    const blocked = yield* unavailableReason(definition, pathContext).pipe(
      Effect.provide(platformServices),
    );
    if (blocked !== undefined) {
      return yield* new BrowserImportFailedError({ sourceId: definition.id, reason: blocked });
    }

    // The profile directory arrives over IPC, so it is only honoured when the
    // source itself reported it. Forwarding it unchecked would let `..`
    // segments walk out of the browser's user-data directory and read any
    // cookie database reachable on disk.
    const sourceProfiles = yield* listSourceProfiles(definition, pathContext).pipe(
      Effect.provide(platformServices),
    );
    const requestedProfile = sourceProfiles.find(
      (profile) => profile.directory === sourceProfileDirectory,
    );
    if (requestedProfile === undefined) {
      return yield* new BrowserImportFailedError({
        sourceId: definition.id,
        reason: "unknownSourceProfile",
      });
    }

    // The profile was listed against a database moments ago; resolve it again
    // rather than assume a path, since a Chromium jar may sit under `Network/`.
    const databasePath = yield* resolveCookieDatabase(
      definition,
      pathContext,
      requestedProfile.directory,
    ).pipe(Effect.provide(platformServices));
    if (databasePath === undefined) {
      return yield* new BrowserImportFailedError({ sourceId: definition.id, reason: "readFailed" });
    }
    return { definition, databasePath };
  });

  /**
   * How each engine reads a profile's store: its plaintext metadata for
   * listing, and its cookies for import. Firefox and Safari store plaintext,
   * so nothing there is ever undecryptable.
   */
  const engines: Record<
    BrowserImportEngine,
    {
      readonly readMetadata: (
        databasePath: string,
      ) => Effect.Effect<ReadonlyArray<CookieMetadata>, CookieStoreReadError, CookieStoreServices>;
      readonly readCookies: (
        definition: BrowserImportSourceDefinition,
        databasePath: string,
        includeHost: (host: string) => boolean,
      ) => Effect.Effect<CookieReadResult, CookieStoreReadError, CookieStoreServices>;
    }
  > = {
    chromium: {
      readMetadata: readChromiumCookieMetadata,
      readCookies: (definition, databasePath, includeHost) => {
        const userDataDirectory = definition.userDataDirectory(pathContext);
        return readChromiumCookies({
          cookieDatabasePath: databasePath,
          keychainService: definition.keychainService,
          keychainAccount: definition.keychainAccount,
          linuxSecretApplication: definition.linuxSecretApplication,
          ...(platform === "win32" && userDataDirectory !== undefined
            ? { windowsLocalStatePath: pathContext.path.join(userDataDirectory, "Local State") }
            : {}),
          platform,
          includeHost,
        });
      },
    },
    firefox: {
      readMetadata: readFirefoxCookieMetadata,
      readCookies: (_definition, databasePath, includeHost) =>
        readFirefoxCookies(databasePath, includeHost).pipe(Effect.map(plaintextRead)),
    },
    safari: {
      readMetadata: readSafariCookieMetadata,
      readCookies: (_definition, databasePath, includeHost) =>
        readSafariCookies(databasePath, includeHost).pipe(Effect.map(plaintextRead)),
    },
  };

  /** Runs a read against the source's store and maps each engine's failure. */
  const readStore = <A>(
    definition: BrowserImportSourceDefinition,
    read: Effect.Effect<A, CookieStoreReadError, CookieStoreServices>,
  ) =>
    read.pipe(
      Effect.scoped,
      Effect.provide(platformServices),
      Effect.catchTags({
        ChromiumCookieReadError: (cause) =>
          Effect.fail(
            new BrowserImportFailedError({ sourceId: definition.id, reason: cause.reason, cause }),
          ),
        FirefoxCookieReadError: (cause) =>
          Effect.fail(
            new BrowserImportFailedError({ sourceId: definition.id, reason: "readFailed", cause }),
          ),
        SafariCookieReadError: (cause) =>
          Effect.fail(
            new BrowserImportFailedError({ sourceId: definition.id, reason: cause.reason, cause }),
          ),
      }),
    );

  const listSites = Effect.fn("BrowserImport.listSites")(function* (
    input: BrowserImportSitesInput,
  ) {
    const { definition, databasePath } = yield* resolveSourceDatabase(
      input.sourceId,
      input.sourceProfileDirectory,
    );
    const metadata = yield* readStore(
      definition,
      engines[definition.engine].readMetadata(databasePath),
    );
    return groupSites(metadata, {
      now: yield* Clock.currentTimeMillis,
      currentUrl: input.currentUrl,
    });
  });

  const importCookies = Effect.fn("BrowserImport.importCookies")(function* (input: {
    readonly input: BrowserImportInput;
    readonly scope: string;
    readonly persistent: boolean;
    readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
  }) {
    const { definition, databasePath } = yield* resolveSourceDatabase(
      input.input.sourceId,
      input.input.sourceProfileDirectory,
    );

    if (platform === "darwin" && definition.engine === "chromium") {
      // macOS attributes the Keychain prompt and the resulting ACL grant to the
      // executable that asks, so record which one that was — in a packaged build
      // it is the signed app, in dev whatever binary hosts the main process.
      yield* Effect.logInfo("Reading browser cookie key from the keychain", {
        sourceId: definition.id,
        executablePath,
      });
    }

    // Chosen sites are matched on the same registrable domain the listing
    // grouped by, and applied by each reader before anything is decrypted.
    const chosen = new Set(input.input.domains);
    const includeHost = (host: string) => chosen.has(siteDomain(host));

    const result = yield* readStore(
      definition,
      engines[definition.engine].readCookies(definition, databasePath, includeHost),
    );

    const session = yield* browserSession
      .getSession(input.scope, input.persistent, input.namespace)
      .pipe(
        Effect.mapError(
          (cause) =>
            new BrowserImportFailedError({
              sourceId: definition.id,
              reason: "sessionUnavailable",
              cause,
            }),
        ),
      );

    // Written one at a time rather than in parallel: Chromium's cookie store
    // serialises writes anyway, and a rejected cookie should only cost itself.
    return yield* writeCookies(session, result);
  });

  return BrowserImport.of({ listSources, listSites, importCookies });
});

export const layer = Layer.effect(BrowserImport, make);
