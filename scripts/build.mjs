import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  platform: "browser",
  target: "es2020",
  format: "iife",
});

const uiBundle = await build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2020",
  format: "iife",
});

const template = await readFile("src/ui.html", "utf8");
const script = uiBundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile("dist/ui.html", template.replace("/*__UI_BUNDLE__*/", script));
