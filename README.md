
# togather

small P2P telepresence app. Tauri app with a Bare sidecar worker using Hyperswarm for P2P


<img width="300"  alt="image" src="https://github.com/user-attachments/assets/a7f9233b-8f0c-42ac-b16e-a1cbdc839ca6" />

<img width="600"  alt="image" src="https://github.com/user-attachments/assets/742081d8-ba08-4b28-8f52-aed03b7e3ef0" />
<img width="600"  alt="image" src="https://github.com/user-attachments/assets/03e174cd-4d5b-4d4a-add4-828a4a48839e" />
<img width="324" height="298" alt="image" src="https://github.com/user-attachments/assets/2a316f32-2dc8-4e87-809e-ce000e1fe79a" />
<img width="312" height="319" alt="image" src="https://github.com/user-attachments/assets/fdf99103-6216-4a3f-a451-75e8dda2fb74" />
<img width="600"  alt="image" src="https://github.com/user-attachments/assets/2b4d1aa8-5664-488f-b608-0a675a973809" />



## Download the latest release

Get the newest build from the [latest GitHub release](https://github.com/clairefro/togather/releases/latest).

### macOS

1. Open the [latest release page](https://github.com/clairefro/togather/releases/latest).
2. Download the macOS `.dmg` asset.
3. Open the `.dmg` and drag `togather` into Applications.
4. Launch from Applications. If macOS says the app is damaged or cannot be
   opened, open Terminal and run:

```bash
xattr -cr /Applications/togather.app
```

5. Launch `togather` from Applications again.

Only use this workaround for a copy downloaded directly from this project's
GitHub release page. The app is currently distributed without Apple Developer
ID signing or notarization, so macOS may quarantine downloaded copies.

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

### Chromebooks

Chromebooks are not an officially supported target. The Linux build may work on
an Intel Chromebook with **Linux development environment** enabled, but the
current Linux release is x86_64/amd64 only and will not run on ARM Chromebooks.
ChromeOS may also restrict always-on-top, transparent, or click-through window
behavior.

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

1. Run the local release automation script with the next version (example: `0.1.5`):

```bash
npm run release -- 0.1.5
```

This will:

- root `package.json` (`version` field)
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

- commit the changes
- create the matching tag (`v0.1.5`)
- push `main` and the tag to `origin`

2. Open the Actions tab and confirm the `Release` workflow succeeds.
3. Open GitHub Releases, review the draft release notes and uploaded assets,
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

## App sequence

```mermaid
sequenceDiagram
    autonumber
    participant UI as Renderer UI
    participant Bridge as Tauri Bridge
    participant Worker as bare-worker
    participant DHT as Hyperswarm / DHT
    participant Peer as Remote Peer Worker

    Note over UI,Worker: App startup
    UI->>Bridge: start worker sidecar
    Bridge->>Worker: spawn bare-worker + workers/main.js
    Worker-->>Bridge: { type: "ready", publicKey }
    Bridge-->>UI: worker ready

    alt Create pairing
        UI->>Bridge: send { type: "create-pairing" }
        Bridge->>Worker: stdin JSON command
        Worker->>Worker: create room code
        Worker->>Worker: topic = hash(roomCode)
        Worker->>DHT: swarm.join(topic, client=true, server=true)
        DHT-->>Worker: discovery flushed
        Worker-->>Bridge: { type: "topic-joined" }
        Worker-->>Bridge: { type: "invite", code }
        Bridge-->>UI: show invite code
    else Join pairing
        UI->>Bridge: send { type: "join-pairing", code }
        Bridge->>Worker: stdin JSON command
        Worker-->>Bridge: { type: "joined" }
        Worker->>Worker: topic = hash(roomCode)
        Worker->>DHT: swarm.join(topic, client=true, server=true)
        DHT-->>Worker: discovery flushed
        Worker-->>Bridge: { type: "topic-joined" }
    end

    Note over Worker,Peer: Discovery / rendezvous
    DHT-->>Worker: peer announced for topic
    DHT-->>Peer: peer announced for topic
    Worker->>Peer: attempt encrypted P2P connection
    Peer-->>Worker: accept connection
    Worker->>Worker: attachPeer(socket, publicKey)
    Worker-->>Bridge: { type: "peer-status", connected: true, peer }
    Bridge-->>UI: render connected peer

    Note over Worker,Peer: Initial state sync
    Worker->>Peer: { type: "presence", state }
    Worker->>Peer: { type: "profile", displayName, avatar, statusEmoji, statusText }
    Peer->>Worker: { type: "presence", state }
    Peer->>Worker: { type: "profile", ... }
    Worker-->>Bridge: { type: "presence", peer, state }
    Worker-->>Bridge: { type: "profile", peer, ... }
    Bridge-->>UI: update widget state

    loop While connected
        UI->>Bridge: send presence / typing / chat / profile updates
        Bridge->>Worker: stdin JSON command
        Worker->>Peer: newline-delimited JSON messages
        Peer->>Worker: peer messages
        Worker-->>Bridge: peer events
        Bridge-->>UI: rerender relevant UI
    end

    alt Disconnect
        Peer--xWorker: socket closes
        Worker-->>Bridge: { type: "peer-status", connected: false, peer }
        Bridge-->>UI: show disconnected state
    end
```

## Attributions

Notification sound from https://mixkit.co/
