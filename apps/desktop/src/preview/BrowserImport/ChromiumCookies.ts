// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt primitives Chromium uses; Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";

import {
  ChromiumKeyError,
  ChromiumKeyFailure,
  readWindowsKey,
  resolveChromiumKeys,
  type ChromiumKeyMaterial,
} from "./ChromiumKeys.ts";
import {
  bareHost,
  cookieScope,
  snapshotCookieDatabase,
  type CookieMetadata,
  type CookieReadResult,
  type ImportedCookie,
} from "./CookieDatabase.ts";

/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;

export const ChromiumCookieReadReason = Schema.Literals([
  ...ChromiumKeyFailure.literals,
  "browserRunning",
]);
export type ChromiumCookieReadReason = typeof ChromiumCookieReadReason.Type;

export class ChromiumCookieReadError extends Schema.TaggedError<ChromiumCookieReadError>()(
  "ChromiumCookieReadError",
  {
    reason: ChromiumCookieReadReason,
    cookieDatabasePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read Chromium cookies at ${this.cookieDatabasePath}: ${this.reason}.`;
  }
}

const CookieRow = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  path: Schema.String,
  expires_seconds: Schema.Number,
  is_secure: Schema.Number,
  is_httponly: Schema.Number,
  samesite: Schema.Number,
  partitioned: Schema.Number,
});
const decodeCookieRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow));
const COOKIE_COLUMNS = `host_key, name, value, encrypted_value, path,
  expires_utc / 1000000 as expires_seconds, is_secure, is_httponly, samesite`;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SchemaVersion = Schema.Union([
  NonNegativeInt,
  Schema.FiniteFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
]);
const decodeSchemaVersion = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ value: SchemaVersion })]),
);

/** Preserve unspecified SameSite; guessing no_restriction would widen cookie scope. */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
};

/** Convert microseconds in SQL: node:sqlite refuses integers beyond JavaScript's safe range. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => {
  if (webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
};

// Chromium 127+ prefixes plaintext with the host-key SHA-256 to bind its domain.
const stripDomainBinding = (
  plaintext: Buffer,
  domain: string,
  schemaVersion: number,
): Buffer | null => {
  if (schemaVersion < 24) return plaintext;
  const domainHash = NodeCrypto.createHash("sha256").update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)
    ? plaintext.subarray(32)
    : null;
};

const decryptCbc = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

const decryptGcm = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  if (payload.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) return null;
  try {
    const nonce = payload.subarray(0, AES_GCM_NONCE_LENGTH);
    const ciphertext = payload.subarray(AES_GCM_NONCE_LENGTH, -AES_GCM_TAG_LENGTH);
    const tag = payload.subarray(-AES_GCM_TAG_LENGTH);
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23,
  platform: NodeJS.Platform = "linux",
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows v10 uses AES-256-GCM; app-bound v20 records have no key here.
  if (platform === "win32") {
    return prefix === "v10" && keys.gcmV10
      ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
      : null;
  }

  // Retry the empty-passphrase key used by some Linux clients (crbug.com/1195256).
  if (prefix === "v10") {
    if (!keys.cbcV10) return null;
    return (
      decryptCbc(payload, keys.cbcV10, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (prefix === "v11") {
    if (!keys.cbcV11) return null;
    return (
      decryptCbc(payload, keys.cbcV11, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (platform === "darwin" || platform === "linux") {
    return stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null;
  }
  return null;
}

/** Chromium 115's schema 15 added `top_frame_site_key`, the CHIPS partition. */
const PARTITIONED_COOKIES_SCHEMA = 15;

/**
 * Snapshots a Chromium cookie database and selects `columns` from every row, plus
 * `partitioned`. Listing and import both read through here. Partitioned (CHIPS) rows belong
 * to one top-level site, which an Electron partition cannot express, so both skip them.
 */
const queryChromiumCookies = Effect.fn("ChromiumCookies.queryChromiumCookies")(function* <
  Row extends { readonly partitioned: number },
>(
  cookieDatabasePath: string,
  columns: string,
  decode: (raw: unknown) => Effect.Effect<ReadonlyArray<Row>, Schema.SchemaError>,
) {
  const readFailed = (cause: unknown) =>
    new ChromiumCookieReadError({ reason: "readFailed", cookieDatabasePath, cause });
  const snapshotPath = yield* snapshotCookieDatabase(cookieDatabasePath).pipe(
    Effect.mapError(readFailed),
  );
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schemaVersion = yield* sql`select value from meta where key = 'version' limit 1`.pipe(
      Effect.flatMap(decodeSchemaVersion),
      Effect.map(([row]) => row.value),
    );
    const partitioned =
      schemaVersion >= PARTITIONED_COOKIES_SCHEMA ? "top_frame_site_key <> ''" : "0";
    const rows = yield* decode(
      yield* sql`select ${sql.literal(columns)}, ${sql.literal(partitioned)} as partitioned
          from cookies`,
    );
    return { rows, schemaVersion };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })),
    Effect.mapError(readFailed),
  );
});

/**
 * Reads and decrypts one Chromium cookie database. `includeHost` narrows the
 * read to chosen sites; rows it rejects are dropped before any decryption and
 * are not reported as skipped.
 */
export const readChromiumCookieDatabase = Effect.fn("ChromiumCookies.readChromiumCookieDatabase")(
  function* (
    cookieDatabasePath: string,
    keys: ChromiumKeyMaterial,
    platform: NodeJS.Platform,
    includeHost: (host: string) => boolean,
  ) {
    const { rows: allRows, schemaVersion } = yield* queryChromiumCookies(
      cookieDatabasePath,
      COOKIE_COLUMNS,
      decodeCookieRows,
    );
    const rows = allRows.filter((row) => includeHost(row.host_key));

    const cookies: ImportedCookie[] = [];
    let undecryptable = 0;
    const undecryptableHosts = new Set<string>();
    for (const row of rows) {
      if (row.partitioned === 1) {
        undecryptable += 1;
        undecryptableHosts.add(bareHost(row.host_key));
        continue;
      }
      const value =
        row.encrypted_value.length === 0
          ? row.value
          : decryptChromiumValue(row.encrypted_value, keys, row.host_key, schemaVersion, platform);
      if (value === null) {
        undecryptable += 1;
        undecryptableHosts.add(bareHost(row.host_key));
        continue;
      }
      const secure = row.is_secure === 1;
      const scope = cookieScope(row.host_key, row.path, secure);
      cookies.push({
        url: scope.url,
        name: row.name,
        value,
        domain: scope.domain,
        path: row.path,
        secure,
        httpOnly: row.is_httponly === 1,
        expirationDate: toUnixSeconds(row.expires_seconds),
        sameSite: sameSiteFromColumn(row.samesite),
      });
    }
    if (
      cookies.length === 0 &&
      keys.cbcV11Error !== undefined &&
      rows.some(
        (row) =>
          row.partitioned === 0 &&
          Buffer.from(row.encrypted_value.subarray(0, 3)).toString("latin1") === "v11",
      )
    ) {
      return yield* new ChromiumCookieReadError({
        reason: keys.cbcV11Error.reason,
        cookieDatabasePath,
        cause: keys.cbcV11Error,
      });
    }
    return {
      cookies,
      undecryptable,
      undecryptableHosts: [...undecryptableHosts],
    } satisfies CookieReadResult;
  },
);

const MetadataRow = Schema.Struct({
  host_key: Schema.String,
  expires_seconds: Schema.Number,
  is_secure: Schema.Number,
  is_httponly: Schema.Number,
  last_access_ms: Schema.Number,
  partitioned: Schema.Number,
});
const decodeMetadataRows = Schema.decodeUnknownEffect(Schema.Array(MetadataRow));
// Divided in SQL: the microsecond values overflow a safe JS integer.
const METADATA_COLUMNS = `host_key, expires_utc / 1000000 as expires_seconds, is_secure,
  is_httponly, last_access_utc / 1000 as last_access_ms`;

/** Chromium's 1601 epoch in milliseconds before the UNIX one. */
const WEBKIT_EPOCH_OFFSET_MILLISECONDS = WEBKIT_EPOCH_OFFSET_SECONDS * 1000;

/**
 * The plaintext columns of a Chromium cookie database, for listing its sites.
 * Never selects a value, so it needs no key and raises no keychain prompt.
 * Partitioned (CHIPS) cookies are left out, as the import skips them too.
 */
export const readChromiumCookieMetadata = Effect.fn("ChromiumCookies.readChromiumCookieMetadata")(
  function* (cookieDatabasePath: string) {
    const { rows } = yield* queryChromiumCookies(
      cookieDatabasePath,
      METADATA_COLUMNS,
      decodeMetadataRows,
    );
    return rows
      .filter((row) => row.partitioned === 0)
      .map((row): CookieMetadata => ({
        host: row.host_key,
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        expiresAt: toUnixSeconds(row.expires_seconds),
        lastAccessedAt:
          row.last_access_ms > 0
            ? row.last_access_ms - WEBKIT_EPOCH_OFFSET_MILLISECONDS
            : undefined,
      }));
  },
);

export interface ChromiumCookieSource {
  readonly cookieDatabasePath: string;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
  readonly windowsLocalStatePath?: string;
  readonly platform: NodeJS.Platform;
  /** Narrows the read to chosen sites before anything is decrypted. */
  readonly includeHost: (host: string) => boolean;
}

export const readChromiumCookies = Effect.fn("ChromiumCookies.readChromiumCookies")(function* (
  source: ChromiumCookieSource,
): Effect.fn.Return<
  CookieReadResult,
  ChromiumCookieReadError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const keys = yield* (
    source.platform === "win32" && source.windowsLocalStatePath
      ? readWindowsKey(source.windowsLocalStatePath).pipe(Effect.map((gcmV10) => ({ gcmV10 })))
      : resolveChromiumKeys({
          platform: source.platform,
          keychainService: source.keychainService,
          keychainAccount: source.keychainAccount,
          linuxSecretApplication: source.linuxSecretApplication,
        })
  ).pipe(
    Effect.mapError(
      (cause: ChromiumKeyError) =>
        new ChromiumCookieReadError({
          reason: cause.reason,
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );

  return yield* readChromiumCookieDatabase(
    source.cookieDatabasePath,
    keys,
    source.platform,
    source.includeHost,
  );
});
