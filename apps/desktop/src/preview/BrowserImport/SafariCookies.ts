import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { cookieScope, type CookieMetadata, type ImportedCookie } from "./CookieDatabase.ts";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

const COOKIE_PAGE_HEADER_SIZE = 12;
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export const SafariCookieReadFailure = Schema.Literals(["needsFullDiskAccess", "readFailed"]);
export type SafariCookieReadFailure = typeof SafariCookieReadFailure.Type;

export class SafariCookieReadError extends Schema.TaggedError<SafariCookieReadError>()(
  "SafariCookieReadError",
  {
    reason: SafariCookieReadFailure,
    cookieDatabasePath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.cookieDatabasePath === undefined
      ? `Could not read Safari cookies: ${this.reason}.`
      : `Could not read Safari cookies at ${this.cookieDatabasePath}: ${this.reason}.`;
  }
}

const isSafariCookieReadError = Schema.is(SafariCookieReadError);

function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

/** One jar record as stored, before it is shaped for Electron or for listing. */
interface BinaryCookieRecord {
  /** As stored, leading dot and all. */
  readonly host: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expiresAt: number | undefined;
}

function parseBinaryCookieRecords(buffer: Buffer): ReadonlyArray<BinaryCookieRecord> {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  const pageCount = buffer.readUInt32BE(4);
  // Buffer.subarray silently clamps invalid bounds, so reject truncated pages and overlapping records.
  if (8 + pageCount * 4 > buffer.length) {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: BinaryCookieRecord[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw new SafariCookieReadError({ reason: "readFailed" });
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) {
      throw new SafariCookieReadError({ reason: "readFailed" });
    }
    // Reject offsets into the header, table, or earlier records to avoid fabricated cookies.
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE ||
        cookieEnd > page.length ||
        accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length,
        )
      ) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset);
      const value = readCString(cookie, valueOffset);
      if (domain === "" || name === "") continue;

      cookies.push({
        host: domain,
        name,
        path: path || "/",
        value,
        secure: (flags & FLAG_SECURE) !== 0,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expiresAt: expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined,
      });
    }
  }

  // Pages end with an 8-byte checksum and an optional length-prefixed plist.
  const trailer = buffer.length - pageStart;
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  return cookies;
}

/** `includeHost` narrows the result to the sites the user chose. */
export function parseBinaryCookies(
  buffer: Buffer,
  includeHost: (host: string) => boolean,
): ReadonlyArray<ImportedCookie> {
  return parseBinaryCookieRecords(buffer)
    .filter((record) => includeHost(record.host))
    .map((record) => ({
      // Safari marks domain cookies with a leading dot like the other
      // engines, so the shared scope rule applies: host-only cookies keep
      // `domain` undefined, or Electron widens them to every subdomain.
      ...cookieScope(record.host, record.path, record.secure),
      name: record.name,
      value: record.value,
      path: record.path,
      secure: record.secure,
      httpOnly: record.httpOnly,
      expirationDate: record.expiresAt,
      // Bits 3–5 of the flags carry something SameSite-shaped, but no public
      // description of them agrees and real jars do not match any of them
      // cleanly. Lax is the modern browser default; claiming "none" would
      // widen every imported cookie's scope.
      sameSite: "lax",
    }));
}

/**
 * Whether a filesystem error is the OS refusing access. A TCC denial arrives as EPERM,
 * which Effect tags `Unknown` rather than `PermissionDenied` (EACCES), so the errno is
 * checked too; otherwise a Full Disk Access refusal reads as a generic failure.
 */
export const isPermissionDenied = (error: PlatformError.PlatformError): boolean => {
  // TCC returns EPERM (Effect Unknown); EACCES is a POSIX denial that Full Disk Access cannot fix.
  const code = (error.reason as { cause?: { code?: unknown } }).cause?.code;
  return code === "EPERM";
};

/** stat succeeds without Full Disk Access, so presence alone does not prove readable cookies. */
export const safariAccessDenied = Effect.fnUntraced(function* (cookiePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(cookiePath, { flag: "r" }).pipe(
    Effect.as(false),
    Effect.catch((cause) => Effect.succeed(isPermissionDenied(cause))),
    Effect.scoped,
  );
});

export const safariAccessGranted = Effect.fnUntraced(function* (cookiePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(cookiePath, { flag: "r" }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
    Effect.scoped,
  );
});

/**
 * Reads the jar and parses it, turning a TCC refusal into the Full Disk Access
 * prompt and a malformed jar into a typed failure rather than a defect.
 */
const readJar = Effect.fn("SafariCookies.readJar")(function* <A>(
  cookiePath: string,
  parse: (contents: Buffer) => A,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFile(cookiePath).pipe(
    Effect.mapError((cause) => {
      // TCC denies the read though the file exists: a permission the user grants in System
      // Settings, not a missing browser. macOS never prompts for Full Disk Access; the read
      // fails with EPERM, which Effect surfaces as an `Unknown` system error rather than
      // `PermissionDenied` (EACCES).
      return new SafariCookieReadError({
        reason: isPermissionDenied(cause) ? "needsFullDiskAccess" : "readFailed",
        cookieDatabasePath: cookiePath,
        cause,
      });
    }),
  );
  return yield* Effect.try({
    try: () => parse(Buffer.from(contents)),
    catch: (cause) =>
      new SafariCookieReadError({
        reason: isSafariCookieReadError(cause) ? cause.reason : "readFailed",
        cookieDatabasePath: cookiePath,
        cause,
      }),
  });
});

/** `includeHost` narrows the read to the sites the user chose. */
export const readSafariCookies = Effect.fn("SafariCookies.readSafariCookies")(function* (
  cookiePath: string,
  includeHost: (host: string) => boolean,
) {
  return yield* readJar(cookiePath, (contents) => parseBinaryCookies(contents, includeHost));
});

/** The jar's flags and expiries, for listing its sites. */
export const readSafariCookieMetadata = Effect.fn("SafariCookies.readSafariCookieMetadata")(
  function* (cookiePath: string) {
    return yield* readJar(cookiePath, (contents) =>
      parseBinaryCookieRecords(contents).map((record): CookieMetadata => ({
        host: record.host,
        secure: record.secure,
        httpOnly: record.httpOnly,
        expiresAt: record.expiresAt,
        // Safari records no last access time.
        lastAccessedAt: undefined,
      })),
    );
  },
);
