/**
 * Groups a cookie store into the sites the user picks from before importing.
 *
 * Built from plaintext metadata only (host, flags, expiry, last access), so
 * listing never needs a keychain prompt or a decrypted value.
 *
 * @module Sites
 */
import type { BrowserImportSite } from "@t3tools/contracts";
import { getDomain } from "tldts";

import { bareHost, type CookieMetadata } from "./CookieDatabase.ts";
import { sensitiveKind } from "./SensitiveSites.ts";

/**
 * The registrable domain a cookie host belongs to: `.mail.google.com` and
 * `google.com` are both `google.com`. Hosts with no public suffix (localhost,
 * an IP address) stand for themselves. Listing and the import's domain filter
 * both use this, so a ticked site imports exactly the cookies it counted.
 */
export const siteDomain = (host: string): string => {
  const bare = bareHost(host);
  return getDomain(bare, { allowPrivateDomains: true }) ?? bare;
};

/** The registrable domain of an http(s) page, or undefined for anything else. */
const pageDomain = (url: string | undefined): string | undefined => {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return siteDomain(parsed.hostname);
};

interface SiteGroup {
  cookieCount: number;
  signedIn: boolean;
  lastAccessedAt: number | undefined;
}

export const groupSites = (
  cookies: ReadonlyArray<CookieMetadata>,
  options: { readonly now: number; readonly currentUrl?: string | undefined },
): ReadonlyArray<BrowserImportSite> => {
  const nowSeconds = options.now / 1000;
  const currentDomain = pageDomain(options.currentUrl);
  const groups = new Map<string, SiteGroup>();
  for (const cookie of cookies) {
    // An expired cookie would never be sent, so it is not something to import
    // and does not make a site look in use.
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= nowSeconds) continue;
    const domain = siteDomain(cookie.host);
    const group = groups.get(domain) ?? {
      cookieCount: 0,
      signedIn: false,
      lastAccessedAt: undefined,
    };
    group.cookieCount += 1;
    // A login session cookie: script can't read it, it only travels over
    // TLS, and it outlives the browser window.
    if (cookie.httpOnly && cookie.secure && cookie.expiresAt !== undefined) group.signedIn = true;
    if (
      cookie.lastAccessedAt !== undefined &&
      (group.lastAccessedAt === undefined || cookie.lastAccessedAt > group.lastAccessedAt)
    ) {
      group.lastAccessedAt = cookie.lastAccessedAt;
    }
    groups.set(domain, group);
  }
  return [...groups]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([domain, group]) => {
      const sensitive = sensitiveKind(domain);
      return {
        domain,
        cookieCount: group.cookieCount,
        signedIn: group.signedIn,
        current: domain === currentDomain,
        ...(sensitive === undefined ? {} : { sensitive }),
        ...(group.lastAccessedAt === undefined ? {} : { lastAccessedAt: group.lastAccessedAt }),
      };
    });
};
