# togather

A small, serverless desktop telepresence widget for two or more people. The native
shell is Tauri v2, the peer worker runs under Bare, and discovery/connections
use Hyperswarm.

## Download the latest release

Get the newest build from the [latest GitHub release](https://github.com/clairefro/togather/releases/latest).

### macOS

1. Open the [latest release page](https://github.com/clairefro/togather/releases/latest).
2. Download the macOS `.dmg` asset.
3. Open the `.dmg` and drag `togather` into Applications.
4. Launch from Applications.

### Windows

1. Open the [latest release page](https://github.com/clairefro/togather/releases/latest).
2. Download the Windows installer (`.msi` or `.exe`).
3. Run the installer and complete setup.
4. Launch `togather` from Start Menu.

### Linux

1. Open the [latest release page](https://github.com/clairefro/togather/releases/latest).
2. Download the Linux asset for your distro (`.AppImage` / `.deb` / other).
3. Install or run according to your distro conventions.
4. Launch `togather`.

If your OS is not listed in release assets yet, check back later or build locally.

## Project shape

- `renderer/` — plain HTML, CSS, and browser JavaScript. It owns the Tauri
  shell bridge, onboarding, presence UI, chat popover, and window APIs.
- `workers/` — an ESM Bare program with one Hyperswarm instance, exposing the
  specified newline-delimited JSON protocol over stdin/stdout.
- `src-tauri/` — minimal Rust bootstrap plus Tauri v2 window configuration and
  a capability scope that permits only the `bare-worker` command (`bare` with
  the packaged `workers/main.js` entry point).

## Tooling

- Node.js is used only for package installation and the Tauri CLI.
- Install the Bare runtime globally before running the app: `npm install -g bare`.
- Install root dependencies with `npm install`, then worker dependencies with
  `npm install --prefix workers`.
- Run the desktop app with `npm run dev`.

## Release builds

- A GitHub Actions workflow is configured at
  `.github/workflows/release.yml`.
- Pushing a tag like `v0.1.1` triggers cross-platform Tauri builds
  (macOS, Windows, Linux).
- The workflow creates a **draft GitHub Release** and uploads generated
  artifacts automatically.

### Create a release

1. Pick the next version (example: `0.1.1`) and run the version bump script (`scripts/bump-version.mjs`):

```bash
npm run bump:version -- 0.1.1
```

This updates:

- root `package.json` (`version` field)
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

2. Build locally once before tagging:

```bash
npm run build
```

3. Commit, push, and create a matching tag (`v0.1.1` must match version `0.1.1`):

```bash
git add .
git commit -m "release: v0.1.1"
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

4. Open the Actions tab and confirm the `Release` workflow succeeds.
5. Open GitHub Releases, review the draft release notes and uploaded assets,
   then publish it.

### Updating after first release

- Repeat the same flow with a new version and tag (`v0.1.2`, `v0.1.3`, etc).
- This project currently uses **manual app updates** for users:
  download and install the latest release artifact from GitHub Releases.

## Platform behavior

- **macOS:** the app enables Tauri's `macOSPrivateApi` for transparent windows
  and asks to appear on all Spaces, including full-screen Spaces.
- **Windows:** the native always-on-top and cursor-ignore APIs are used. Windows
  cannot draw over an application using exclusive full-screen mode.
- **Linux:** the same APIs are requested. X11 compositors normally support the
  overlay; Wayland compositors may deny always-on-top or click-through by their
  security policy, in which case the UI reports the failed action instead of
  silently blocking input.
- When click-through is enabled, press **Escape** to make the widget interactive
  again.

## TODO

- [ ] display name validation (alphanumeric - \_)

- [ ] custom avatar base64
