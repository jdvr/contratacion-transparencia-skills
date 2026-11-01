// esbuild bundler: single-file node executable with shebang banner.
// esbuild handles .mjs natively, but we typecheck build.mjs via tsconfig only loosely; keep it plain.
import { build } from "esbuild";

// Bundles src/cli.ts into dist/cli.js. TypeScript is transpiled directly; no tsc emit needed.
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
