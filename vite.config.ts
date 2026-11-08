import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const PUBLIC = "public";
// produced by `npm run dict:build`
const DICT = JSON.parse(readFileSync("out/dict.json", "utf8")) as { file: string; version: string; size: number };
const clientOnly = (env: { name: string }) => env.name === "client";

/** Ships the dictionary as a static file. The app stores it in IndexedDB, so the SW doesn't precache it. */
function dictionary(): Plugin {
  return {
    name: "ptwords-dict",
    apply: "build",
    applyToEnvironment: clientOnly,
    generateBundle() {
      this.emitFile({ type: "asset", fileName: `dict/${DICT.file}`, source: readFileSync(`out/${DICT.file}`) });
    },
  };
}

/** Emits sw.js with the full list of build outputs to precache, versioned by content hash. */
function serviceWorker(): Plugin {
  return {
    name: "ptwords-sw",
    apply: "build",
    applyToEnvironment: clientOnly,
    generateBundle(_, bundle) {
      const hash = createHash("sha256");
      const files: string[] = [];
      for (const [name, out] of Object.entries(bundle)) {
        if (name.endsWith(".map") || name.startsWith("dict/") || name.startsWith(".")) continue;
        hash.update(name).update(out.type === "chunk" ? out.code : out.source);
        if (name !== "index.html") files.push("/" + name);
      }
      for (const name of readdirSync(PUBLIC)) {
        if (name.startsWith("_")) continue;
        hash.update(name).update(readFileSync(`${PUBLIC}/${name}`));
        files.push("/" + name);
      }
      const source = readFileSync("client/sw.js", "utf8")
        .replace("__VERSION__", "ptw-" + hash.digest("hex").slice(0, 12))
        .replace("__ASSETS__", JSON.stringify(["/", ...files.sort()]));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  define: { __DICT__: JSON.stringify({ file: DICT.file, version: DICT.version, size: DICT.size }) },
  plugins: [cloudflare(), dictionary(), serviceWorker()],
});
