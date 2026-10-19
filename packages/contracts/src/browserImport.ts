import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "safari",
] as const;

export const BrowserImportSourceId = Schema.Literals(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = typeof BrowserImportSourceId.Type;

export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  "keychainUnavailable",
  "unknownSource",
  "unknownSourceProfile",
  "sessionUnavailable",
  "profileNotSaved",
  "profileLimitReached",
  "readFailed",
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

export const BrowserImportSourceProfile = Schema.Struct({
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  cookieCount: Schema.optional(Schema.Int),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  unavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

/**
 * Why a site is never pre-selected for import: a session there reaches money,
 * mail, or every other account the user signs in to with it.
 */
export const BrowserImportSensitiveKind = Schema.Literals(["banking", "email", "signIn"]);
export type BrowserImportSensitiveKind = typeof BrowserImportSensitiveKind.Type;

/**
 * One site a source profile holds cookies for, grouped by registrable domain
 * (`mail.google.com` and `.google.com` are both `google.com`). Built from the
 * cookie store's plaintext columns only, so listing never needs the keychain.
 */
export const BrowserImportSite = Schema.Struct({
  /** Registrable domain, e.g. `github.com` or `bbc.co.uk`. */
  domain: TrimmedNonEmptyString,
  cookieCount: Schema.Int,
  /**
   * Holds a cookie shaped like a login session: HttpOnly, Secure, and
   * persistent (not a session cookie, not expired).
   */
  signedIn: Schema.Boolean,
  /** Absent for ordinary sites. */
  sensitive: Schema.optional(BrowserImportSensitiveKind),
  /** The site the requesting preview tab is showing. */
  current: Schema.Boolean,
  /** Most recent cookie access, epoch milliseconds; absent when the store has none. */
  lastAccessedAt: Schema.optional(Schema.Number),
});
export type BrowserImportSite = typeof BrowserImportSite.Type;

/** Which profile of which source browser a request reads from. */
const SourceProfileFields = {
  sourceId: BrowserImportSourceId,
  /** As listed by `BrowserImportSourceProfile.directory`. */
  sourceProfileDirectory: TrimmedNonEmptyString,
};

export const BrowserImportSitesInput = Schema.Struct({
  ...SourceProfileFields,
  /** URL of the preview tab asking, so its site can be marked `current`. */
  currentUrl: Schema.optional(Schema.String),
});
export type BrowserImportSitesInput = typeof BrowserImportSitesInput.Type;

export const BrowserImportInput = Schema.Struct({
  ...SourceProfileFields,
  /** T3 Code profile the cookies are written into. */
  targetProfileId: BrowserProfileId,
  /**
   * Registrable domains to import, as listed by `BrowserImportSite.domain`.
   * Only cookies whose host belongs to one of these domains are imported, so
   * an empty list imports nothing.
   */
  domains: Schema.Array(TrimmedNonEmptyString),
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  ...SourceProfileFields,
  targetProfileId: BrowserProfileId,
  domains: Schema.Array(TrimmedNonEmptyString),
});

export const BrowserImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  skippedDomains: Schema.Array(Schema.String),
});
export type BrowserImportResult = typeof BrowserImportResult.Type;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain — sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give T3 Code Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
};

export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
};
