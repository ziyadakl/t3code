import { describe, expect, it } from "vitest";

import { resolveDesktopCloudAuthOAuthOptions } from "./desktopAuth";

describe("resolveDesktopCloudAuthOAuthOptions", () => {
  it("ignores absent social provider settings", () => {
    expect(
      resolveDesktopCloudAuthOAuthOptions({
        environment: {
          userSettings: {
            social: {
              github: null,
              google: {
                strategy: "oauth_google",
                enabled: true,
                authenticatable: true,
              },
            },
          },
        },
      }),
    ).toEqual([{ strategy: "oauth_google", label: "Google" }]);
  });
});
