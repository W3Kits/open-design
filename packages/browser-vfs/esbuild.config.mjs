import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["./src/index.ts"],
  format: "esm",
  outfile: "./dist/index.mjs",
  packages: "external",
  platform: "browser",
  target: "es2022",
});
