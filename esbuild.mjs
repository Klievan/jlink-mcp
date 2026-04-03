import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** Shared options */
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  sourcemap: true,
  format: "cjs",
  minify: false,
};

// 1. VSCode extension entry point — exclude vscode (provided by host)
const extensionBuild = esbuild.build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  external: ["vscode"],
});

// 2. Standalone MCP server — bundle everything (no external deps at runtime)
const standaloneBuild = esbuild.build({
  ...common,
  entryPoints: ["src/mcp/standalone.ts"],
  outfile: "out/mcp/standalone.js",
  external: [], // bundle all deps including MCP SDK and zod
});

await Promise.all([extensionBuild, standaloneBuild]);
console.log("Build complete");
