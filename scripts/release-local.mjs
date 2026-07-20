#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

function parseVersionArg(argv) {
  const candidate = argv[2];
  if (!candidate || candidate === "--help" || candidate === "-h") {
    return null;
  }

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate)) {
    throw new Error(
      `Invalid version '${candidate}'. Expected semver like 0.1.1 or 1.2.3-beta.1`,
    );
  }

  return candidate;
}

function run(command, args) {
  execFileSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

function main() {
  const nextVersion = parseVersionArg(process.argv);

  if (!nextVersion) {
    console.log("Usage: npm run release:local -- <version>");
    console.log("Example: npm run release:local -- 0.1.5");
    process.exit(0);
  }

  const tagName = `v${nextVersion}`;

  run("node", ["scripts/bump-version.mjs", nextVersion]);
  run("git", [
    "add",
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
  ]);
  run("git", ["commit", "-m", `release: ${tagName}`]);
  run("git", ["tag", tagName]);
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", tagName]);

  console.log(`Release prep complete for ${tagName}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
