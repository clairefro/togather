#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");

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

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateCargoTomlVersion(cargoToml, nextVersion) {
  const packageSectionMatch = cargoToml.match(
    /(\[package\][\s\S]*?)(\n\[[^\]]+\]|$)/,
  );
  if (!packageSectionMatch) {
    throw new Error("Could not find [package] section in src-tauri/Cargo.toml");
  }

  const packageSection = packageSectionMatch[1];
  if (!/\nversion\s*=\s*"[^"]+"/.test(packageSection)) {
    throw new Error("Could not find package version in src-tauri/Cargo.toml");
  }

  const updatedPackageSection = packageSection.replace(
    /\nversion\s*=\s*"[^"]+"/,
    `\nversion = "${nextVersion}"`,
  );

  return cargoToml.replace(packageSection, updatedPackageSection);
}

async function main() {
  const nextVersion = parseVersionArg(process.argv);

  if (!nextVersion) {
    console.log("Usage: npm run bump:version -- <version>");
    console.log("Example: npm run bump:version -- 0.1.1");
    process.exit(0);
  }

  const [packageJson, tauriConfig, cargoTomlRaw] = await Promise.all([
    readJson(packageJsonPath),
    readJson(tauriConfigPath),
    fs.readFile(cargoTomlPath, "utf8"),
  ]);

  const previous = {
    packageJson: packageJson.version,
    tauriConfig: tauriConfig.version,
    cargoToml:
      cargoTomlRaw.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1] ||
      "(unknown)",
  };

  packageJson.version = nextVersion;
  tauriConfig.version = nextVersion;
  const nextCargoToml = updateCargoTomlVersion(cargoTomlRaw, nextVersion);

  await Promise.all([
    writeJson(packageJsonPath, packageJson),
    writeJson(tauriConfigPath, tauriConfig),
    fs.writeFile(cargoTomlPath, nextCargoToml, "utf8"),
  ]);

  console.log("Updated versions:");
  console.log(`- package.json: ${previous.packageJson} -> ${nextVersion}`);
  console.log(`- src-tauri/tauri.conf.json: ${previous.tauriConfig} -> ${nextVersion}`);
  console.log(`- src-tauri/Cargo.toml: ${previous.cargoToml} -> ${nextVersion}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
