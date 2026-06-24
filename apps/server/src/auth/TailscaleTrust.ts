import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
const TAILSCALE_NAME_HEADER = "tailscale-user-name";
const TAILSCALE_PROFILE_PIC_HEADER = "tailscale-user-profile-pic";

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface TailscaleIdentity {
  readonly login: string; // from Tailscale-User-Login (required, non-empty)
  readonly name?: string; // from Tailscale-User-Name
  readonly profilePic?: string; // from Tailscale-User-Profile-Pic
}

/**
 * Read the Tailscale Serve identity headers off a request. Returns undefined
 * unless a non-empty login header is present.
 *
 * Tailscale Serve injects these identity headers into proxied HTTP requests.
 * Header keys arrive lowercased on the Effect HttpServerRequest.
 */
export const readTailscaleIdentity = (
  request: HttpServerRequest.HttpServerRequest,
): TailscaleIdentity | undefined => {
  const login = normalizeNonEmptyString(request.headers[TAILSCALE_LOGIN_HEADER]);
  if (!login) {
    return undefined;
  }

  const name = normalizeNonEmptyString(request.headers[TAILSCALE_NAME_HEADER]);
  const profilePic = normalizeNonEmptyString(request.headers[TAILSCALE_PROFILE_PIC_HEADER]);

  return {
    login,
    ...(name ? { name } : {}),
    ...(profilePic ? { profilePic } : {}),
  };
};

/**
 * True when the login is allowed: no allowlist (undefined/empty) => any tailnet
 * identity is allowed; otherwise the login must be in the allowlist
 * (case-insensitive).
 */
export const isAllowedTailscaleLogin = (
  login: string,
  allowlist?: ReadonlyArray<string>,
): boolean => {
  const normalizedLogin = normalizeNonEmptyString(login);
  if (!normalizedLogin) {
    return false;
  }

  const entries = (allowlist ?? [])
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);

  if (entries.length === 0) {
    return true;
  }

  const target = normalizedLogin.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === target);
};
