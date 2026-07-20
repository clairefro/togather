#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const platformTargets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

async function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const target = platformTargets[platformKey];

  if (!target) {
    throw new Error(`Unsupported Bare sidecar platform: ${platformKey}`);
  }

  const executableName = process.platform === "win32" ? "bare.exe" : "bare";
  const source = path.join(
    "workers",
    "node_modules",
    `bare-runtime-${platformKey}`,
    "bin",
    executableName,
  );
  const destinationDir = path.join("src-tauri", "binaries");
  const destination = path.join(
    destinationDir,
    `bare-worker-${target}${process.platform === "win32" ? ".exe" : ""}`,
  );

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o755);

  console.log(`Prepared Bare sidecar: ${destination}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
