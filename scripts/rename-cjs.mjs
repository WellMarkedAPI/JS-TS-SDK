// Rename .js → .cjs in dist/cjs/ so Node uses CommonJS regardless of the
// outer package.json's "type": "module". Runs after `tsc --module commonjs`.
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "dist/cjs");

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

async function rewriteRequires(file) {
  let src = await fs.readFile(file, "utf8");
  // Rewrite require("./foo") or require("./foo.js") → require("./foo.cjs")
  // for relative paths only.
  src = src.replace(
    /require\(("|')(\.{1,2}\/[^"']+?)\1\)/g,
    (_match, quote, target) => {
      if (target.endsWith(".cjs") || target.endsWith(".json")) {
        return `require(${quote}${target}${quote})`;
      }
      const stripped = target.endsWith(".js") ? target.slice(0, -3) : target;
      return `require(${quote}${stripped}.cjs${quote})`;
    },
  );
  await fs.writeFile(file, src, "utf8");
}

for await (const file of walk(root)) {
  if (file.endsWith(".js")) {
    await rewriteRequires(file);
    const cjs = file.replace(/\.js$/, ".cjs");
    await fs.rename(file, cjs);
  } else if (file.endsWith(".js.map")) {
    const cjsMap = file.replace(/\.js\.map$/, ".cjs.map");
    await fs.rename(file, cjsMap);
  }
}

// Drop a package.json with "type": "commonjs" so Node resolves the .cjs
// files unambiguously even if a tool ignores the extension.
await fs.writeFile(
  path.join(root, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
  "utf8",
);
