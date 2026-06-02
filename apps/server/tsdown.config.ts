import { defineConfig } from "tsdown";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const internalPackagePrefixes = ["@t3tools/", "effect-acp", "effect-codex-app-server"];
const repoEnv = loadRepoEnv();

export default defineConfig({
  entry: ["src/bin.ts"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => internalPackagePrefixes.some((prefix) => id.startsWith(prefix)),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  define: {
    __T3CODE_BUILD_T3_RELAY_URL__: JSON.stringify(repoEnv.T3_RELAY_URL?.trim() ?? ""),
  },
});
