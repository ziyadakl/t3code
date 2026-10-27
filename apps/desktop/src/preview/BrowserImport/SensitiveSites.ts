/**
 * Sites whose session is worth more than the site, so the import picker never pre-selects
 * them; keyed by registrable domain (as `siteDomain` returns) plus brand names covering
 * every country domain. Curated, not heuristic: a miss hands a preview tab the user's bank.
 *
 * @module SensitiveSites
 */
import type { BrowserImportSensitiveKind } from "@t3tools/contracts";
import { parse } from "tldts";

const SENSITIVE_SITES: ReadonlyArray<readonly [BrowserImportSensitiveKind, ReadonlyArray<string>]> =
  [
    // Identity providers, SSO and password managers: one session here signs
    // in to every other account. Google and Microsoft also serve mail, but
    // their SSO reach is the larger risk, so they are listed here.
    [
      "signIn",
      [
        "google.com",
        "microsoft.com",
        "microsoftonline.com",
        "apple.com",
        "okta.com",
        "oktapreview.com",
        "auth0.com",
        "onelogin.com",
        "duosecurity.com",
        "pingidentity.com",
        "1password.com",
        "lastpass.com",
        "bitwarden.com",
        "dashlane.com",
        // "Sign in with..." providers other sites trust for login.
        "github.com",
        "facebook.com",
        "x.com",
        "twitter.com",
      ],
    ],
    // Mailboxes: password resets for everything else land here.
    [
      "email",
      [
        "outlook.com",
        "live.com",
        "hotmail.com",
        "yahoo.com",
        "aol.com",
        "proton.me",
        "protonmail.com",
        "icloud.com",
        "fastmail.com",
        "hey.com",
        "zoho.com",
        "mail.ru",
        "gmx.com",
      ],
    ],
    // Banks, payments, brokerages and exchanges.
    [
      "banking",
      [
        "paypal.com",
        "venmo.com",
        "stripe.com",
        "wise.com",
        "revolut.com",
        "chase.com",
        "bankofamerica.com",
        "wellsfargo.com",
        "citi.com",
        "capitalone.com",
        "americanexpress.com",
        "discover.com",
        "usbank.com",
        "schwab.com",
        "fidelity.com",
        "vanguard.com",
        "robinhood.com",
        "coinbase.com",
        "kraken.com",
        "binance.com",
      ],
    ],
  ];

const KIND_BY_DOMAIN = new Map(
  SENSITIVE_SITES.flatMap(([kind, domains]) => domains.map((domain) => [domain, kind] as const)),
);

/**
 * Brands that run the same mailbox or sign-in under many country domains
 * (`google.de`, `yahoo.co.jp`, `live.fr`), matched by the domain's name
 * without its public suffix.
 */
const KIND_BY_BRAND = new Map<string, BrowserImportSensitiveKind>([
  ["google", "signIn"],
  ["microsoft", "signIn"],
  ["yahoo", "email"],
  ["live", "email"],
  ["outlook", "email"],
  ["hotmail", "email"],
  ["aol", "email"],
  ["gmx", "email"],
  ["yandex", "email"],
]);

/** Why a site should not be pre-selected, or undefined for an ordinary one. */
export const sensitiveKind = (domain: string): BrowserImportSensitiveKind | undefined => {
  const listed = KIND_BY_DOMAIN.get(domain);
  if (listed !== undefined) return listed;
  // ICANN suffixes only, and only when the domain is itself the registrable
  // one: `live.blogspot.com` is someone's blog, not Microsoft's mailbox.
  // `live.tv` still reads as the brand; that costs the user one tick.
  const { domain: registrable, domainWithoutSuffix: brand } = parse(domain, {
    allowPrivateDomains: false,
  });
  const branded = registrable === domain && brand !== null ? KIND_BY_BRAND.get(brand) : undefined;
  if (branded !== undefined) return branded;
  // Catches the long tail of banks the list cannot name: tdbank.com,
  // bankofireland.ie, and so on.
  if (domain.split(".")[0]?.includes("bank")) return "banking";
  return undefined;
};
