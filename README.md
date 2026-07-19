# togather

A small, serverless desktop telepresence widget for two people. The native
shell is Tauri v2, the peer worker runs under Bare, and discovery/connections
use Hyperswarm.

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
