// @effect-diagnostics nodeBuiltinImport:off - Builds a Firefox-shaped
// `cookies.sqlite` fixture with the same native bindings Firefox itself uses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type { Session } from "electron";
import * as NodeSqlite from "node:sqlite";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

const cookie = {
  url: "https://rejected.example/path",
  name: "session",
  value: "value",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "lax" as const,
};

const layerRejectedBeforeSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.die("getPartition must not be reached"),
    isPartition: () => false,
    getSession: () => Effect.die("getSession must not be reached"),
    clearCookies: () => Effect.die("clearCookies must not be reached"),
    clearCache: () => Effect.die("clearCache must not be reached"),
  }),
);

/**
 * Builds the service against a scratch home containing an installed, closed
 * copy of the source browser.
 */
const withImporter = Effect.fnUntraced(function* (
  sessionLayer: Layer.Layer<BrowserSession.BrowserSession> = layerRejectedBeforeSession,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
  const layerEnvironment = Layer.succeed(HostProcess.Environment, { HOME: home });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
  yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(sessionLayer),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

/** "Now" for the listing test; the fixture's expiries sit a day either side. */
const FIXTURE_NOW_SECONDS = 1_800_000_000;

/**
 * Seeds a closed Firefox profile — Firefox needs no keychain, so the whole
 * list-then-import path runs without touching the machine's credentials.
 */
const seedFirefox = Effect.fnUntraced(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = `${home}/Library/Application Support/Firefox`;
  yield* fileSystem.makeDirectory(`${root}/Profiles/main`, { recursive: true });
  yield* fileSystem.writeFileString(
    `${root}/profiles.ini`,
    "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/main\n",
  );
  const database = new NodeSqlite.DatabaseSync(`${root}/Profiles/main/cookies.sqlite`);
  database.exec("pragma user_version = 15");
  database.exec(`create table moz_cookies (
    id integer primary key, host text, name text, value text, path text, expiry integer,
    isSecure integer, isHttpOnly integer, sameSite integer, lastAccessed integer,
    originAttributes text not null default ''
  )`);
  const insert = database.prepare(
    "insert into moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, lastAccessed) values (?, ?, 'v', '/', ?, ?, ?, 0, ?)",
  );
  const live = FIXTURE_NOW_SECONDS + 86_400;
  const expired = FIXTURE_NOW_SECONDS - 86_400;
  insert.run(".github.com", "user_session", live, 1, 1, 1_750_000_000_000_000);
  insert.run("gist.github.com", "prefs", 0, 0, 0, 1_760_000_000_000_000);
  insert.run("news.example.com", "seen", live, 0, 0, 0);
  insert.run("old.example.org", "gone", expired, 1, 1, 0);
  database.close();
  return "Profiles/main";
});

/** A target session that records what was written into it. */
const recordingSession = (written: Array<string>) =>
  Layer.succeed(
    BrowserSession.BrowserSession,
    BrowserSession.BrowserSession.of({
      getPartition: () => Effect.die("unused"),
      isPartition: () => false,
      getSession: () =>
        Effect.succeed({
          cookies: {
            set: (cookie: { url: string; name: string }) => {
              written.push(`${cookie.url} ${cookie.name}`);
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        } as unknown as Session),
      clearCookies: () => Effect.die("unused"),
      clearCache: () => Effect.die("unused"),
    }),
  );

describe("BrowserImport.listSites", () => {
  it.effect("lists a profile's live sites without opening a session", () =>
    Effect.gen(function* () {
      const { importer, home } = yield* withImporter();
      const directory = yield* seedFirefox(home);
      yield* TestClock.setTime(FIXTURE_NOW_SECONDS * 1000);

      const sites = yield* importer.listSites({
        sourceId: "firefox",
        sourceProfileDirectory: directory,
        currentUrl: "https://github.com/pulls",
      });

      assert.deepEqual(sites, [
        {
          domain: "example.com",
          cookieCount: 1,
          signedIn: false,
          current: false,
        },
        {
          domain: "github.com",
          cookieCount: 2,
          signedIn: true,
          current: true,
          sensitive: "signIn",
          lastAccessedAt: 1_760_000_000_000,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const { importer, home } = yield* withImporter();
      yield* seedFirefox(home);

      const error = yield* importer
        .listSites({ sourceId: "firefox", sourceProfileDirectory: "../../elsewhere" })
        .pipe(Effect.flip);

      assert.equal(error.reason, "unknownSourceProfile");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.importCookies", () => {
  it.effect("imports only the chosen sites", () =>
    Effect.gen(function* () {
      const written: Array<string> = [];
      const { importer, home } = yield* withImporter(recordingSession(written));
      const directory = yield* seedFirefox(home);

      const result = yield* importer.importCookies({
        input: {
          sourceId: "firefox",
          sourceProfileDirectory: directory,
          targetProfileId: "default",
          domains: ["github.com"],
        },
        scope: "persist:t3code-preview-test",
        persistent: true,
      });

      assert.deepEqual(written, [
        "https://github.com/ user_session",
        "http://gist.github.com/ prefs",
      ]);
      assert.deepEqual(result, { imported: 2, skipped: 0, skippedDomains: [] });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("imports nothing when no site is chosen", () =>
    Effect.gen(function* () {
      const written: Array<string> = [];
      const { importer, home } = yield* withImporter(recordingSession(written));
      const directory = yield* seedFirefox(home);

      const result = yield* importer.importCookies({
        input: {
          sourceId: "firefox",
          sourceProfileDirectory: directory,
          targetProfileId: "default",
          domains: [],
        },
        scope: "persist:t3code-preview-test",
        persistent: true,
      });

      assert.deepEqual(written, []);
      assert.deepEqual(result, { imported: 0, skipped: 0, skippedDomains: [] });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, home } = yield* withImporter();

      yield* fileSystem.makeDirectory(`${home}/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/secrets/Cookies`, "not-a-db");

      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "helium",
            sourceProfileDirectory: "../../../../secrets",
            targetProfileId: "default",
            domains: [],
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
      assert.equal(error.reason, "unknownSourceProfile");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses to import while the source browser holds its profile",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { importer, root } = yield* withImporter();
        yield* fileSystem.symlink("host-that-does-not-exist-1234", `${root}/SingletonLock`);

        const error = yield* importer
          .importCookies({
            input: {
              sourceId: "helium",
              sourceProfileDirectory: "Default",
              targetProfileId: "default",
              domains: [],
            },
            scope: "persist:t3code-preview-test",
            persistent: true,
          })
          .pipe(Effect.flip);

        assert.equal(error.reason, "browserRunning");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.writeCookies", () => {
  it.effect("flushes the store after writing, and reports success if the flush fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => {
              events.push("set");
              return Promise.resolve();
            },
            flushStore: () => {
              events.push("flush");
              return Promise.reject(new Error("fixture flush failure"));
            },
          },
        },
        { cookies: [cookie, cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(events, ["set", "set", "flush"]);
      assert.deepEqual(result, { imported: 2, skipped: 0, skippedDomains: [] });
    }),
  );
});
