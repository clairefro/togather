const tauri = window.__TAURI__;
const { invoke, Channel } = tauri.core;
const { PhysicalPosition, PhysicalSize } = tauri.dpi;
const { resourceDir, join } = tauri.path;
const { getCurrentWindow } = tauri.window;

class LocalEventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, listener) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return this;
  }

  emit(name, payload) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(payload);
    }
  }
}

class BareWorkerCommand extends LocalEventEmitter {
  constructor(program, args = [], options = {}) {
    super();
    this.program = program;
    this.args = args;
    this.options = options;
    this.stdout = new LocalEventEmitter();
    this.stderr = new LocalEventEmitter();
  }

  static create(program, args = [], options = {}) {
    return new BareWorkerCommand(program, args, options);
  }

  async spawn() {
    const onEvent = new Channel();

    onEvent.onmessage = (event) => {
      if (event.event === "Error") this.emit("error", event.payload);
      else if (event.event === "Terminated") this.emit("close", event.payload);
      else if (event.event === "Stdout")
        this.stdout.emit("data", event.payload);
      else if (event.event === "Stderr")
        this.stderr.emit("data", event.payload);
    };

    const pid = await invoke("plugin:shell|spawn", {
      program: this.program,
      args: this.args,
      options: this.options,
      onEvent,
    });

    return {
      write(data) {
        const bytes =
          typeof data === "string"
            ? Array.from(new TextEncoder().encode(data))
            : data;

        return invoke("plugin:shell|stdin_write", {
          pid,
          buffer: bytes,
        });
      },
      kill() {
        return invoke("plugin:shell|kill", { pid });
      },
    };
  }
}

const appWindow = getCurrentWindow();
const app = document.querySelector("#app");
const WINDOW_SIZE_KEY = "togather.window-size.v1";
const WINDOW_POSITION_KEY = "togather.window-position.v1";
const LAST_ROOM_CODE_KEY = "togather.last-room-code.v1";
const DISPLAY_NAME_KEY = "togather.display-name.v1";
const ZOOM_LEVEL_KEY = "togather.zoom-level.v1";
const ONBOARDING_WINDOW_WIDTH = 300;
const ONBOARDING_WINDOW_HEIGHT = 620;
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.1;
const JOIN_WAIT_TIMEOUT_MS = 20000;
const IDLE_AFTER_MS = 3 * 60 * 1000;
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_WATCHDOG_MS = 1000;
const ACTIVITY_PRESENCE_THROTTLE_MS = 750;
const SYSTEM_IDLE_POLL_MS = 1000;
const state = {
  connected: false,
  selfPeerId: "",
  peers: new Map(),
  connectedPeers: new Set(),
  localPresence: "present",
  displayName: "",
  lastActivityAt: Date.now(),
  lastPresenceSentAt: 0,
  inviteCode: "",
  creatingRoom: false,
  joiningRoom: false,
  messages: [],
  chatDraft: "",
  unreadChatCount: 0,
  clickThrough: false,
  menuOpen: false,
  chatOpen: false,
  zoomLevel: 1,
  typingPeers: new Map(),
  child: null,
  buffer: "",
  listeners: new Set(),
  idleTimer: null,
  presenceHeartbeatTimer: null,
  presenceWatchdogTimer: null,
  systemIdlePollTimer: null,
  systemIdlePollInFlight: false,
  systemIdleSupported: true,
  systemIdleMs: 0,
  joinWaitTimer: null,
  startingPromise: null,
};

function ioPayloadToString(payload) {
  if (typeof payload === "string") return payload;
  return new TextDecoder().decode(Uint8Array.from(payload));
}

function normalizeError(input) {
  if (typeof input === "string") return input.trim() || "Unknown error.";

  if (input && typeof input.message === "string") {
    return input.message.trim() || "Unknown error.";
  }

  const serialized = JSON.stringify(input);
  if (!serialized || serialized === "{}" || serialized === "null") {
    return "Unknown error. Open DevTools for details.";
  }

  return serialized;
}

async function workerPathCandidates() {
  const resourcePath = await resourceDir();

  return Promise.all([
    join(resourcePath, "workers", "main.js"),
    join(resourcePath, "..", "..", "..", "workers", "main.js"),
    join(resourcePath, "..", "..", "workers", "main.js"),
  ]);
}

const bridge = {
  async start() {
    if (state.child) return;
    const candidates = await workerPathCandidates();
    let lastError = null;

    for (const candidatePath of candidates) {
      try {
        state.buffer = "";
        let sawReady = false;
        let settleReady;

        const readyPromise = new Promise((resolve, reject) => {
          settleReady = { resolve, reject };
        });

        const readyTimeout = setTimeout(() => {
          if (!sawReady) {
            settleReady.reject(
              new Error(
                `Worker did not become ready at path: ${candidatePath}`,
              ),
            );
          }
        }, 2500);

        const command = BareWorkerCommand.create(
          "binaries/bare-worker",
          [candidatePath],
          { sidecar: true },
        );
        command.stdout.on("data", (chunk) => {
          state.buffer += ioPayloadToString(chunk);
          const lines = state.buffer.split("\n");
          state.buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              if (event?.type === "ready" && !sawReady) {
                sawReady = true;
                clearTimeout(readyTimeout);
                settleReady.resolve();
              }

              state.listeners.forEach((listener) => listener(event));
            } catch {
              showError("The peer worker sent an unreadable message.");
            }
          }
        });
        command.stderr.on("data", (message) => {
          const text = ioPayloadToString(message).trim();
          if (text) showError(`Worker: ${text}`);
        });
        command.on("error", (message) => {
          const errorText = normalizeError(message);
          if (!sawReady) {
            clearTimeout(readyTimeout);
            settleReady.reject(new Error(errorText));
          }
        });
        command.on("close", () => {
          clearTimeout(readyTimeout);
          state.child = null;
          if (state.connected) setConnection(false);
          if (!sawReady) {
            settleReady.reject(
              new Error(`Worker exited before ready at path: ${candidatePath}`),
            );
          }
        });

        state.child = await command.spawn();
        await readyPromise;
        return;
      } catch (error) {
        if (state.child) {
          try {
            await state.child.kill();
          } catch {
            // Continue trying other worker paths.
          }
          state.child = null;
        }

        lastError = error;
      }
    }

    throw lastError ?? new Error("Failed to start worker process.");
  },
  async send(object) {
    if (!state.child) {
      state.startingPromise ??= bridge.start().finally(() => {
        state.startingPromise = null;
      });
      await state.startingPromise;
    }

    if (!state.child) throw new Error("Could not start the peer worker.");
    await state.child.write(`${JSON.stringify(object)}\n`);
  },
  onEvent(callback) {
    state.listeners.add(callback);
    return () => state.listeners.delete(callback);
  },
  setClickThrough(enabled) {
    return appWindow.setIgnoreCursorEvents(enabled);
  },
};
window.bridge = bridge;

function showError(message) {
  const readable = normalizeError(message);

  const error = document.querySelector("[data-error]");
  if (error) {
    error.textContent = readable;
    error.title = readable;
    error.hidden = false;
  }
}
function clearError() {
  const error = document.querySelector("[data-error]");
  if (error) error.hidden = true;
}
function escapeHtml(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

function readLastRoomCode() {
  try {
    const value = localStorage.getItem(LAST_ROOM_CODE_KEY);
    if (typeof value === "string") {
      const code = value.trim();
      if (code) return code;
    }
  } catch {
    // Ignore localStorage read failures.
  }

  return "";
}

function saveLastRoomCode(code) {
  const normalized = typeof code === "string" ? code.trim() : "";
  if (!normalized) return;

  try {
    localStorage.setItem(LAST_ROOM_CODE_KEY, normalized);
  } catch {
    // Ignore localStorage write failures.
  }
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 40);
}

function readDisplayName() {
  try {
    const value = localStorage.getItem(DISPLAY_NAME_KEY);
    return normalizeDisplayName(value ?? "");
  } catch {
    return "";
  }
}

function saveDisplayName(name) {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, normalizeDisplayName(name));
  } catch {
    // Ignore localStorage write failures.
  }
}

function ensurePeer(peerId) {
  const existing = state.peers.get(peerId);
  if (existing) return existing;

  const created = { presence: "away", displayName: "", lastSeenAt: Date.now() };
  state.peers.set(peerId, created);
  return created;
}

function peerShortId(peerId) {
  return typeof peerId === "string" ? peerId.slice(0, 8) : "peer";
}

function activePeerIds() {
  return [...state.connectedPeers].filter(
    (peerId) => peerId !== state.selfPeerId,
  );
}

function activePeerCount() {
  return activePeerIds().length;
}

function aggregatePeerPresence() {
  if (!activePeerCount()) return "away";

  let hasIdle = false;
  for (const peerId of activePeerIds()) {
    const presence = state.peers.get(peerId)?.presence ?? "away";
    if (presence === "present") return "present";
    if (presence === "idle") hasIdle = true;
  }

  return hasIdle ? "idle" : "away";
}

function bindDragHandle() {
  const dragBar = app.querySelector(".drag-bar");
  const widget = app.querySelector(".widget");
  if (!dragBar || !widget) return;

  const startDrag = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, textarea, a")) return;

    appWindow
      .startDragging()
      .catch((error) =>
        showError(`Window drag failed: ${normalizeError(error)}`),
      );
  };

  dragBar.addEventListener("mousedown", startDrag);

  widget.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, textarea, a")) return;

    const rect = widget.getBoundingClientRect();
    const topZoneHeight = 40;
    if (event.clientY - rect.top > topZoneHeight) return;

    appWindow
      .startDragging()
      .catch((error) =>
        showError(`Window drag failed: ${normalizeError(error)}`),
      );
  });
}

function bindResizeHandle() {
  const resizeGrip = app.querySelector('[data-action="resize"]');
  if (!resizeGrip) return;

  let resizeSession = null;
  const minWidth = 200;
  const minHeight = 200;

  resizeGrip.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    try {
      resizeGrip.setPointerCapture(event.pointerId);
    } catch {
      // Fallback still works without pointer capture.
    }

    const initialSize = await appWindow.outerSize();
    resizeSession = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      startWidth: initialSize.width,
      startHeight: initialSize.height,
    };
  });

  resizeGrip.addEventListener("pointermove", (event) => {
    if (!resizeSession || event.pointerId !== resizeSession.pointerId) return;

    const width = Math.max(
      minWidth,
      resizeSession.startWidth + (event.screenX - resizeSession.startX),
    );
    const height = Math.max(
      minHeight,
      resizeSession.startHeight + (event.screenY - resizeSession.startY),
    );

    appWindow
      .setSize(new PhysicalSize(width, height))
      .catch((error) =>
        showError(`Window resize failed: ${normalizeError(error)}`),
      );
  });

  const endResize = (event) => {
    if (!resizeSession || event.pointerId !== resizeSession.pointerId) return;

    try {
      resizeGrip.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if capture was not active.
    }

    resizeSession = null;
  };

  resizeGrip.addEventListener("pointerup", endResize);
  resizeGrip.addEventListener("pointercancel", endResize);
}

function renderOnboarding(mode = "choose") {
  state.inviteCode = "";
  if (mode === "choose") {
    state.joiningRoom = false;
    clearTimeout(state.joinWaitTimer);
    state.joinWaitTimer = null;
  }
  document.body.classList.remove("joined-transparent");
  const creatingLabel = state.creatingRoom
    ? "Creating room..."
    : "Create a room";
  const joiningLabel = state.joiningRoom ? "Joining room..." : "Connect";
  const inlineNameValue = state.displayName;
  const inlineNamePlaceholder = nameEditorPlaceholder();
  const inlineNameEditor = `<div class="onboarding-name-form"><label for="onboarding-display-name-input">Display name</label><input id="onboarding-display-name-input" class="onboarding-name-input" maxlength="40" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="${escapeAttribute(inlineNamePlaceholder)}" value="${escapeAttribute(inlineNameValue)}"></div>`;
  const enterCodeButton = state.creatingRoom
    ? ""
    : '<button class="quiet" data-action="enter-code">I have a code</button>';
  const cancelCreateButton = state.creatingRoom
    ? '<button class="quiet" data-action="cancel-create">Back</button>'
    : "";
  const chooseContent = `${inlineNameEditor}<button class="primary" data-action="create" ${state.creatingRoom ? "disabled" : ""}>${creatingLabel}</button>${enterCodeButton}${cancelCreateButton}${state.creatingRoom ? '<p class="booting" aria-live="polite"><span></span> Booting room...</p>' : ""}`;
  const joinContent = `<label class="field-label" for="invite-code">Room code</label><div class="code-input-wrap"><input id="invite-code" class="code-input" autocomplete="off" spellcheck="false" maxlength="80" placeholder="Paste room code"><button type="button" class="clear-code" data-action="clear-code" aria-label="Clear room code" hidden>×</button></div><button class="primary" data-action="join" ${state.joiningRoom ? "disabled" : ""}>${joiningLabel}</button><button class="quiet" data-action="back">Back</button>`;
  app.innerHTML = `<section class="widget onboarding"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button" data-action="menu" aria-label="Menu">...</button><button class="icon-button" data-action="minimize" aria-label="Minimize">−</button><button class="icon-button" data-action="exit" aria-label="Exit">×</button></header><div class="onboarding-body"><div class="character away"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="32"/><circle class="eye" cx="34" cy="42" r="4"/><circle class="eye" cx="56" cy="42" r="4"/><path d="M31 57 Q45 65 59 57"/></svg></div><h1>Let's get togather</h1><p class="muted">Connect directly with peers</p><p class="error" data-error hidden></p>${mode === "choose" ? chooseContent : joinContent}</div><aside class="menu-popover" ${state.menuOpen ? "" : "hidden"}><div class="menu-header"><button type="button" class="icon-button menu-close" data-action="cancel-name" aria-label="Close menu">×</button></div>${state.connected ? `<div class="menu-section"><label class="menu-label" for="room-code-input">Room</label><div class="room-code-row"><input id="room-code-input" class="room-code-field" value="${escapeAttribute(currentRoomCode())}" readonly aria-label="Room code"><button type="button" class="icon-button copy-room-button" data-action="copy-room" aria-label="Copy room code" title="Copy room code">⎘</button></div><p class="menu-meta">${activePeerCount()} ${activePeerCount() === 1 ? "peer" : "peers"} present</p></div>` : ""}<form class="name-form"><label for="display-name-input">Display name</label><div class="name-input-row"><input id="display-name-input" maxlength="40" placeholder="${escapeHtml(nameEditorPlaceholder())}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(state.displayName)}"><button type="submit" class="checkmark-button" data-action="save-name" hidden aria-label="Save display name">✓</button></div></form></aside><button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;
  app
    .querySelector('[data-action="create"]')
    ?.addEventListener("click", createPairing);
  app
    .querySelector('[data-action="enter-code"]')
    ?.addEventListener("click", () => renderOnboarding("join"));
  app
    .querySelector('[data-action="cancel-create"]')
    ?.addEventListener("click", cancelCreatePairing);
  app
    .querySelector('[data-action="back"]')
    ?.addEventListener("click", () => renderOnboarding());
  const onboardingNameInput = app.querySelector(
    "#onboarding-display-name-input",
  );
  if (onboardingNameInput) {
    const commitOnboardingName = async () => {
      const nextName = normalizeDisplayName(onboardingNameInput.value);
      const changed = nextName !== state.displayName;
      state.displayName = nextName;
      saveDisplayName(state.displayName);
      onboardingNameInput.value = state.displayName;

      if (!changed) return;

      try {
        await bridge.send({
          type: "set-profile",
          displayName: state.displayName,
        });
      } catch {
        // Ignore if worker is not running yet.
      }
    };

    onboardingNameInput.addEventListener("change", () => {
      void commitOnboardingName();
    });
    onboardingNameInput.addEventListener("blur", () => {
      void commitOnboardingName();
    });
    onboardingNameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      onboardingNameInput.blur();
    });
  }
  app
    .querySelector('[data-action="join"]')
    ?.addEventListener("click", joinPairing);
  app
    .querySelector('[data-action="clear-code"]')
    ?.addEventListener("click", () => {
      const input = app.querySelector("#invite-code");
      const clearButton = app.querySelector('[data-action="clear-code"]');
      if (!input) return;

      input.value = "";
      input.focus();
      if (clearButton) clearButton.hidden = true;
      clearError();
    });
  app
    .querySelector('[data-action="minimize"]')
    ?.addEventListener("click", minimizeApp);
  app.querySelector('[data-action="exit"]')?.addEventListener("click", exitApp);
  app.querySelector("#invite-code")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinPairing();
  });
  app.querySelector("#invite-code")?.addEventListener("input", () => {
    const input = app.querySelector("#invite-code");
    const clearButton = app.querySelector('[data-action="clear-code"]');
    if (input && clearButton) clearButton.hidden = !input.value;
  });

  if (mode === "join") {
    const lastRoomCode = readLastRoomCode();
    const input = app.querySelector("#invite-code");
    const clearButton = app.querySelector('[data-action="clear-code"]');
    if (input && lastRoomCode) {
      input.value = lastRoomCode;
      input.setSelectionRange(lastRoomCode.length, lastRoomCode.length);
    }

    if (input && clearButton) clearButton.hidden = !input.value;
  }

  bindNameMenu();

  bindDragHandle();
  bindResizeHandle();
}

function renderInvite() {
  state.creatingRoom = false;
  document.body.classList.remove("joined-transparent");
  app.innerHTML = `<section class="widget onboarding"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button" data-action="minimize" aria-label="Minimize">−</button><button class="icon-button" data-action="exit" aria-label="Exit">×</button></header><div class="onboarding-body invite-screen"><div class="pulse-ring"><span>♡</span></div><h1>Share this code</h1><p class="muted">Send it through a channel you already trust.</p><div class="invite-code">${state.inviteCode}</div><button class="primary" data-action="copy">Copy code</button><button class="quiet" data-action="reset">Back</button><p class="waiting"><i></i> Waiting for visitors...</p><p class="error" data-error hidden></p></div><button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;
  app
    .querySelector('[data-action="copy"]')
    .addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.inviteCode);
      app.querySelector('[data-action="copy"]').textContent = "Copied";
    });
  app
    .querySelector('[data-action="reset"]')
    ?.addEventListener("click", resetPairing);
  app
    .querySelector('[data-action="minimize"]')
    ?.addEventListener("click", minimizeApp);
  app.querySelector('[data-action="exit"]')?.addEventListener("click", exitApp);

  bindDragHandle();
  bindResizeHandle();
}

function label() {
  if (!state.connected) return "Waiting to connect";

  return {
    present: "Present",
    idle: "Idle",
    away: "Away",
  }[aggregatePeerPresence()];
}

function currentRoomCode() {
  return state.inviteCode || readLastRoomCode() || "Unknown room";
}

function peerDisplayName(peerId) {
  const peer = state.peers.get(peerId);
  if (peer?.displayName) return peer.displayName;
  return `Peer ${peerShortId(peerId)}`;
}

function hashToHue(value) {
  const input = typeof value === "string" ? value : "";
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return hash % 360;
}

function chatNameColor(key) {
  return `hsl(${hashToHue(key)}, 72%, 68%)`;
}

function chatDisplayName(message) {
  if (message.from === "self") {
    return state.displayName || peerShortId(state.selfPeerId) || "you";
  }

  return message.displayName || `Peer ${peerShortId(message.peer)}`;
}

function formatChatTime(timestamp) {
  const date = new Date(
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp
      : Date.now(),
  );
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function pushChatNotice(text) {
  pushUnreadChatEntry({ kind: "notice", text, ts: Date.now() }, false);
}

function pushUnreadChatEntry(entry, countUnread = true) {
  state.messages.push(entry);
  if (countUnread && !state.chatOpen) {
    state.unreadChatCount += 1;
  }
}

function pushPeerNotice(action, peerId, countUnread = false) {
  pushUnreadChatEntry(
    { kind: "notice", action, peerId, ts: Date.now() },
    countUnread,
  );
}

function defaultDisplayName() {
  if (state.displayName) return state.displayName;
  if (typeof state.selfPeerId === "string")
    return peerShortId(state.selfPeerId);
  return "";
}

function nameEditorPlaceholder() {
  return "Use random name";
}

function syncNameEditorControls() {
  const input = app.querySelector("#display-name-input");
  const saveButton = app.querySelector('[data-action="save-name"]');
  if (!input || !saveButton) return;

  const isDirty = normalizeDisplayName(input.value) !== state.displayName;
  saveButton.hidden = !isDirty;
  saveButton.disabled = !isDirty;
}

function bindNameMenu() {
  app.querySelector('[data-action="menu"]')?.addEventListener("click", () => {
    const popover = app.querySelector(".menu-popover");
    const input = app.querySelector("#display-name-input");
    if (!popover || !input) return;

    state.menuOpen = !state.menuOpen;
    popover.hidden = !state.menuOpen;
    if (state.menuOpen) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  app
    .querySelector('[data-action="cancel-name"]')
    ?.addEventListener("click", () => {
      const popover = app.querySelector(".menu-popover");
      const input = app.querySelector("#display-name-input");
      if (!popover || !input) return;

      input.value = state.displayName;
      state.menuOpen = false;
      popover.hidden = true;
    });

  app
    .querySelector('[data-action="copy-room"]')
    ?.addEventListener("click", async () => {
      const roomInput = app.querySelector("#room-code-input");
      const code = roomInput?.value?.trim() || currentRoomCode();
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code);
        const button = app.querySelector('[data-action="copy-room"]');
        if (!button) return;

        const original = button.textContent;
        button.textContent = "✓";
        setTimeout(() => {
          button.textContent = original;
        }, 900);
      } catch {
        showError("Could not copy room code.");
      }
    });

  app.querySelector(".name-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const popover = app.querySelector(".menu-popover");
    const input = app.querySelector("#display-name-input");
    if (!popover || !input) return;

    state.displayName = normalizeDisplayName(input.value);
    saveDisplayName(state.displayName);

    try {
      await bridge.send({
        type: "set-profile",
        displayName: state.displayName,
      });
      state.menuOpen = false;
      popover.hidden = true;
      if (
        app.querySelector(".main-widget") ||
        app.querySelector(".onboarding")
      ) {
        renderWidget();
      }
    } catch (error) {
      showError(error);
    }
  });

  app
    .querySelector("#display-name-input")
    ?.addEventListener("input", syncNameEditorControls);
  syncNameEditorControls();
}

function closeAllPopups() {
  state.menuOpen = false;
  state.chatOpen = false;
  const menuPopover = app.querySelector(".menu-popover");
  const chatPopover = app.querySelector(".chat-popover");
  if (menuPopover) menuPopover.hidden = true;
  if (chatPopover) chatPopover.hidden = true;
}

function enableEscapeKeyHandler() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const menuOpen = state.menuOpen;
      const chatOpen = state.chatOpen;
      if (menuOpen || chatOpen) {
        event.preventDefault();
        closeAllPopups();
        renderWidget();
      }
    }
  });
}

function readSavedZoomLevel() {
  try {
    const raw = localStorage.getItem(ZOOM_LEVEL_KEY);
    if (!raw) return 1;

    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_ZOOM && parsed <= MAX_ZOOM) {
      return parsed;
    }
  } catch {
    // Ignore localStorage read failures.
  }

  return 1;
}

function saveZoomLevel(zoom) {
  try {
    localStorage.setItem(ZOOM_LEVEL_KEY, String(zoom));
  } catch {
    // Ignore localStorage write failures.
  }
}

async function sendTypingEvent() {
  try {
    console.log("[TYPING] Sending typing event");
    await bridge.send({ type: "typing" });
  } catch (error) {
    console.error("Failed to send typing event:", error);
  }
}

async function sendStoppedTypingEvent() {
  try {
    console.log("[TYPING] Sending stopped-typing event");
    await bridge.send({ type: "stopped-typing" });
  } catch (error) {
    console.error("Failed to send stopped-typing event:", error);
  }
}

let typingTimeout = null;
let typingDebounceHandler = null;
let typingKeydownHandler = null;

function setupChatInputTypingListener() {
  const input = app.querySelector(".chat-form input");
  if (!input) return;

  // Remove old listeners if they exist
  if (typingDebounceHandler)
    input.removeEventListener("input", typingDebounceHandler);
  if (typingKeydownHandler)
    input.removeEventListener("keydown", typingKeydownHandler);

  // Create new listeners
  typingDebounceHandler = () => {
    sendTypingEvent();
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      sendStoppedTypingEvent();
      typingTimeout = null;
    }, 1000);
  };

  typingKeydownHandler = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (typingTimeout) clearTimeout(typingTimeout);
      sendStoppedTypingEvent();
      typingTimeout = null;
    }
  };

  // Attach new listeners
  input.addEventListener("input", typingDebounceHandler);
  input.addEventListener("keydown", typingKeydownHandler);
}

function applyZoomLevel(zoom) {
  const app = document.getElementById("app");
  if (app) {
    app.style.transform = `scale(${zoom})`;
    app.style.transformOrigin = "top center";
  }
  if (zoom > 1) {
    document.body.style.overflow = "auto";
    document.body.style.width = "100%";
    document.body.style.height = "auto";
  } else {
    document.body.style.overflow = "hidden";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
  }
}

function enableZoomKeyHandler() {
  window.addEventListener(
    "keydown",
    (event) => {
      const isMeta = event.metaKey || event.ctrlKey;
      const isZoomKey =
        event.code === "Equal" ||
        event.code === "Minus" ||
        event.key === "+" ||
        event.key === "-" ||
        event.key === "=";

      if (isMeta && isZoomKey) {
        event.preventDefault();
        if (event.code === "Equal" || event.key === "+" || event.key === "=") {
          state.zoomLevel = Math.min(MAX_ZOOM, state.zoomLevel + ZOOM_STEP);
        } else if (event.code === "Minus" || event.key === "-") {
          state.zoomLevel = Math.max(MIN_ZOOM, state.zoomLevel - ZOOM_STEP);
        }
        applyZoomLevel(state.zoomLevel);
        saveZoomLevel(state.zoomLevel);
      }
    },
    true,
  );
}

function noticeText(message) {
  if (message.peerId === state.selfPeerId) {
    if (message.action === "joined") {
      return "you joined the room";
    }

    if (message.action === "left") {
      return "you left the room";
    }
  }

  if (message.action === "joined") {
    return `${peerDisplayName(message.peerId)} joined the room`;
  }

  if (message.action === "left") {
    return `${peerDisplayName(message.peerId)} left the room`;
  }

  return message.text || "";
}

function renderWidget() {
  const currentChatInput = app.querySelector(".chat-form input");
  if (currentChatInput) state.chatDraft = currentChatInput.value;

  const shouldRefocusChatInput =
    state.chatOpen && document.activeElement?.matches(".chat-form input");

  const aggregate = aggregatePeerPresence();
  const peerItems = activePeerIds()
    .sort((a, b) => peerDisplayName(a).localeCompare(peerDisplayName(b)))
    .map((peerId) => {
      const peer = state.peers.get(peerId);
      const presence = peer?.presence ?? "away";
      const caption = peer?.displayName || peerShortId(peerId);
      const characterColor = chatNameColor(peerId);

      const isTyping = state.typingPeers.has(peerId);
      return `<div class="peer-card ${presence}"><div class="peer-caption"><span class="status-dot"></span><span class="peer-caption-text">${escapeHtml(caption)}</span></div><div class="character ${presence}" style="--character-color:${characterColor}"><svg viewBox="0 0 90 90"><circle class="orb" cx="45" cy="45" r="31"/><circle class="eye" cx="34" cy="42" r="4"/><circle class="eye" cx="56" cy="42" r="4"/><path class="smile" d="M31 57 Q45 65 59 57"/></svg>${isTyping ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : ""}</div></div>`;
    })
    .join("");

  if (state.connected) document.body.classList.add("joined-transparent");
  const peerCount = activePeerCount();
  const exitButtonText = state.connected ? "←" : "×";
  const exitButtonLabel = state.connected ? "Leave room" : "Exit";
  const chatButtonLabel = "Chat";
  const menuButtonLabel = "Menu";
  const minimizeButtonLabel = "Minimize";

  app.innerHTML = `<section class="widget main-widget ${aggregate}"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button chat-bubble ${state.unreadChatCount ? "has-unread" : ""}" data-action="chat" aria-label="${chatButtonLabel}" title="${chatButtonLabel}"><svg class="chat-icon" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M437.333 32H74.667C33.493 32 0 65.493 0 106.667V320c0 41.173 33.493 74.667 74.667 74.667h25.387L65.11 464.555c-2.091 4.203-1.195 9.301 2.219 12.523C69.355 478.997 72 480 74.667 480c1.813 0 3.627-.448 5.291-1.408l146.88-83.925h210.496C478.507 394.667 512 361.173 512 320V106.667C512 65.493 478.507 32 437.333 32zM490.645 319.979c0 29.397-23.936 53.333-53.333 53.333H223.979c-1.856 0-3.669.491-5.291 1.408L99.947 442.581l26.923-53.824c1.664-3.285 1.472-7.232-.469-10.368s-5.376-5.056-9.067-5.056H74.667c-29.397 0-53.333-23.936-53.333-53.333V106.667c0-29.397 23.936-53.333 53.333-53.333v-.021h362.645c29.397 0 53.333 23.936 53.333 53.333V319.979z"/></svg>${state.unreadChatCount ? `<span class="chat-badge">${state.unreadChatCount}</span>` : ""}</button><button class="icon-button" data-action="menu" aria-label="${menuButtonLabel}" title="${menuButtonLabel}">...</button><button class="icon-button" data-action="minimize" aria-label="${minimizeButtonLabel}" title="${minimizeButtonLabel}">−</button><button class="icon-button" data-action="exit" aria-label="${exitButtonLabel}" title="${exitButtonLabel}">${exitButtonText}</button></header><div class="presence-body"><div class="peer-strip">${peerItems || '<p class="peer-empty">No peers connected yet.</p>'}</div></div><aside class="menu-popover" ${state.menuOpen ? "" : "hidden"}><div class="menu-header"><button type="button" class="icon-button menu-close" data-action="cancel-name" aria-label="Close menu">×</button></div><div class="menu-section"><label class="menu-label" for="room-code-input">Room</label><div class="room-code-row"><input id="room-code-input" class="room-code-field" value="${escapeAttribute(currentRoomCode())}" readonly aria-label="Room code"><button type="button" class="icon-button copy-room-button" data-action="copy-room" aria-label="Copy room code" title="Copy room code">⎘</button></div><p class="menu-meta">${peerCount} ${peerCount === 1 ? "peer" : "peers"} present</p></div><form class="name-form"><label for="display-name-input">Display name</label><div class="name-input-row"><input id="display-name-input" maxlength="40" placeholder="${escapeHtml(nameEditorPlaceholder())}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(defaultDisplayName())}"><button type="submit" class="checkmark-button" data-action="save-name" hidden aria-label="Save display name">✓</button></div></form></aside><aside class="chat-popover" ${state.chatOpen ? "" : "hidden"}><div class="chat-header"><span>Chat</span><button class="icon-button" data-action="close-chat">×</button></div><div class="message-log"></div><form class="chat-form"><input aria-label="Message" maxlength="2000" placeholder="Say something…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button aria-label="Send" type="submit">↑</button></form></aside><button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;
  app
    .querySelector('[data-action="chat"]')
    .addEventListener("click", toggleChat);
  app
    .querySelector('[data-action="close-chat"]')
    .addEventListener("click", toggleChat);
  app
    .querySelector('[data-action="minimize"]')
    ?.addEventListener("click", minimizeApp);
  app.querySelector('[data-action="exit"]')?.addEventListener("click", () => {
    if (state.connected) {
      leaveRoom();
    } else {
      exitApp();
    }
  });

  bindNameMenu();

  if (state.chatOpen) {
    renderMessages();
    setupChatInputTypingListener();
  }
  if (shouldRefocusChatInput) {
    app.querySelector(".chat-form input")?.focus();
  }

  bindDragHandle();
  bindResizeHandle();
}

async function leaveRoom() {
  try {
    clearIdleTimer();
    stopPresenceHeartbeat();
    stopPresenceWatchdog();
    stopSystemIdlePolling();
    await sendAwayIfConnected();
    await bridge.send({ type: "leave" });
  } catch {
    // Ignore if worker is not running
  }

  state.connected = false;
  state.menuOpen = false;
  state.chatOpen = false;
  state.messages = [];
  state.chatDraft = "";
  state.typingPeers.clear();
  state.unreadChatCount = 0;
  state.connectedPeers.clear();
  state.peers.clear();
  renderOnboarding("choose");
}

async function resetPairing() {
  clearError();
  clearTimeout(state.joinWaitTimer);
  state.joinWaitTimer = null;
  clearIdleTimer();
  stopPresenceHeartbeat();
  stopPresenceWatchdog();
  stopSystemIdlePolling();
  await sendAwayIfConnected();
  try {
    await bridge.send({ type: "leave" });
  } catch {
    // Ignore if worker is not running; reset the UI either way.
  }

  state.connected = false;
  state.localPresence = "present";
  state.menuOpen = false;
  state.chatOpen = false;
  state.unreadChatCount = 0;
  state.connectedPeers.clear();
  state.peers.clear();
  state.inviteCode = "";
  state.creatingRoom = false;
  state.messages = [];
  state.chatDraft = "";
  renderOnboarding("choose");
}

async function exitApp() {
  try {
    clearIdleTimer();
    stopPresenceHeartbeat();
    stopPresenceWatchdog();
    stopSystemIdlePolling();
    await sendAwayIfConnected();
  } catch {
    // Ignore away signaling failures during shutdown.
  }

  try {
    await bridge.send({ type: "leave" });
  } catch {
    // Ignore if worker is already gone.
  }

  try {
    if (state.child) await state.child.kill();
  } catch {
    // If kill fails, still close the window below.
  }

  await appWindow.close();
}

async function minimizeApp() {
  try {
    await appWindow.minimize();
  } catch (error) {
    showError(`Minimize failed: ${normalizeError(error)}`);
  }
}

async function createPairing() {
  if (state.creatingRoom) return;

  clearError();
  state.creatingRoom = true;
  renderOnboarding("choose");

  try {
    await bridge.send({ type: "create-pairing" });
  } catch (error) {
    state.creatingRoom = false;
    renderOnboarding("choose");
    showError(error);
  }
}

async function cancelCreatePairing() {
  clearError();
  state.creatingRoom = false;
  state.inviteCode = "";
  renderOnboarding("choose");

  try {
    await bridge.send({ type: "leave" });
  } catch {
    // Ignore if worker is not running.
  }
}

async function joinPairing() {
  if (state.joiningRoom) return;
  clearError();
  const code = app.querySelector("#invite-code").value.trim();
  if (!code) return showError("Enter a room code.");
  state.inviteCode = code;
  saveLastRoomCode(code);

  state.joiningRoom = true;
  clearTimeout(state.joinWaitTimer);
  state.joinWaitTimer = null;
  const joinButton = app.querySelector('[data-action="join"]');
  if (joinButton) {
    joinButton.disabled = true;
    joinButton.textContent = "Joining room...";
  }

  try {
    await bridge.send({ type: "join-pairing", code });

    state.joinWaitTimer = setTimeout(() => {
      if (state.connected) return;

      state.joiningRoom = false;
      const currentJoinButton = app.querySelector('[data-action="join"]');
      if (currentJoinButton) {
        currentJoinButton.disabled = false;
        currentJoinButton.textContent = "Connect";
      }

      showError("Join timed out - room may not exist. Try again");
    }, JOIN_WAIT_TIMEOUT_MS);
  } catch (error) {
    state.joiningRoom = false;
    clearTimeout(state.joinWaitTimer);
    state.joinWaitTimer = null;
    if (joinButton) {
      joinButton.disabled = false;
      joinButton.textContent = "Connect";
    }
    showError(error);
  }
}
function setConnection(connected) {
  if (state.connected === connected) return;

  state.connected = connected;
  document.body.classList.toggle("joined-transparent", connected);
  if (connected) {
    applySavedWindowPlacementForJoined();
    clearTimeout(state.joinWaitTimer);
    state.joinWaitTimer = null;
    state.joiningRoom = false;
    if (state.selfPeerId) {
      pushPeerNotice("joined", state.selfPeerId, false);
    }
    renderWidget();
    markUserActive();
    startPresenceHeartbeat();
    startPresenceWatchdog();
    startSystemIdlePolling();
    bridge
      .send({ type: "set-profile", displayName: state.displayName })
      .catch(showError);
  } else if (app.querySelector(".main-widget")) {
    clearIdleTimer();
    stopPresenceHeartbeat();
    stopPresenceWatchdog();
    stopSystemIdlePolling();
    state.menuOpen = false;
    state.chatOpen = false;
    state.connectedPeers.clear();
    renderWidget();
  }
}
function toggleChat() {
  state.chatOpen = !state.chatOpen;
  if (state.chatOpen) {
    state.unreadChatCount = 0;
  }
  renderWidget();
  if (state.chatOpen) {
    app.querySelector(".chat-popover")?.querySelector("input")?.focus();
  }
}
function renderMessages() {
  const log = app.querySelector(".message-log");
  if (!log) return;
  log.innerHTML = state.messages.length
    ? state.messages
        .map((message) => {
          const when = formatChatTime(message.ts);
          const title = escapeAttribute(when);

          if (message.kind === "notice") {
            return `<p class="message notice" title="${title}">${escapeHtml(noticeText(message))}</p>`;
          }

          const name = chatDisplayName(message);
          const colorKey =
            message.from === "self"
              ? state.selfPeerId || `self:${name}`
              : message.peer || name;

          return `<p class="message chat-line" title="${title}"><span class="chat-bracket">&lt;</span><span class="sender" style="color:${chatNameColor(colorKey)}">${escapeHtml(name)}</span><span class="chat-sep">:</span> ${escapeHtml(message.text)} <span class="chat-bracket">&gt;</span></p>`;
        })
        .join("")
    : '<p class="empty-chat">A little hello goes a long way.</p>';
  log.scrollTop = log.scrollHeight;
  const form = app.querySelector(".chat-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const input = form.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    try {
      await bridge.send({ type: "send-chat", text });
      state.messages.push({
        text,
        from: "self",
        displayName: state.displayName,
        ts: Date.now(),
      });
      input.value = "";
      state.chatDraft = "";
      renderMessages();
      app.querySelector(".chat-form input")?.focus();
      markUserActive();
    } catch (error) {
      showError(error);
    }
  };
  const input = form.querySelector("input");
  input.value = state.chatDraft;
  input.onkeydown = (event) => {
    if (event.key === "Escape" && state.chatOpen) {
      event.preventDefault();
      state.chatOpen = false;
      renderWidget();
    }
  };
  input.oninput = (event) => {
    state.chatDraft = event.target.value;
    markUserActive();
  };
}
async function toggleClickThrough() {
  state.clickThrough = !state.clickThrough;
  try {
    await bridge.setClickThrough(state.clickThrough);
    renderWidget();
  } catch (error) {
    state.clickThrough = false;
    showError(`Click-through is unavailable here: ${normalizeError(error)}`);
  }
}
function clearIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function stopPresenceHeartbeat() {
  clearInterval(state.presenceHeartbeatTimer);
  state.presenceHeartbeatTimer = null;
}

function stopPresenceWatchdog() {
  clearInterval(state.presenceWatchdogTimer);
  state.presenceWatchdogTimer = null;
}

function stopSystemIdlePolling() {
  clearInterval(state.systemIdlePollTimer);
  state.systemIdlePollTimer = null;
  state.systemIdlePollInFlight = false;
}

async function pollSystemIdleOnce() {
  if (!state.connected || !state.systemIdleSupported) return;
  if (state.systemIdlePollInFlight) return;

  state.systemIdlePollInFlight = true;
  try {
    const seconds = await invoke("get_system_idle_seconds");

    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      state.systemIdleMs = Math.max(0, seconds * 1000);
      state.lastActivityAt = Date.now() - state.systemIdleMs;
    } else {
      state.systemIdleSupported = false;
    }
  } catch {
    state.systemIdleSupported = false;
  } finally {
    state.systemIdlePollInFlight = false;
  }
}

function startSystemIdlePolling() {
  stopSystemIdlePolling();
  if (!state.connected || !state.systemIdleSupported) return;

  pollSystemIdleOnce().then(evaluatePresence);
  state.systemIdlePollTimer = setInterval(() => {
    pollSystemIdleOnce().then(evaluatePresence);
  }, SYSTEM_IDLE_POLL_MS);
}

function evaluatePresence() {
  if (!state.connected) return;

  const idleForMs = state.systemIdleSupported
    ? state.systemIdleMs
    : Date.now() - state.lastActivityAt;
  setLocalPresence(idleForMs >= IDLE_AFTER_MS ? "idle" : "present");
}

function startPresenceWatchdog() {
  stopPresenceWatchdog();
  if (!state.connected) return;

  evaluatePresence();
  state.presenceWatchdogTimer = setInterval(() => {
    evaluatePresence();
  }, PRESENCE_WATCHDOG_MS);
}

function sendCurrentPresence() {
  if (!state.connected) return;
  state.lastPresenceSentAt = Date.now();
  bridge
    .send({ type: "send-presence", state: state.localPresence })
    .catch(showError);
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  if (!state.connected) return;

  sendCurrentPresence();

  state.presenceHeartbeatTimer = setInterval(() => {
    sendCurrentPresence();
  }, PRESENCE_HEARTBEAT_MS);
}

function setLocalPresence(presence) {
  if (state.localPresence === presence) return;
  state.localPresence = presence;
  sendCurrentPresence();
}

function armIdleTimer() {
  clearIdleTimer();
  if (!state.connected) return;

  state.idleTimer = setTimeout(() => {
    evaluatePresence();
    if (state.localPresence !== "idle") armIdleTimer();
  }, IDLE_AFTER_MS);
}

function markUserActive() {
  state.lastActivityAt = Date.now();
  if (state.systemIdleSupported) state.systemIdleMs = 0;

  if (state.localPresence !== "present") {
    setLocalPresence("present");
  } else if (
    state.connected &&
    Date.now() - state.lastPresenceSentAt >= ACTIVITY_PRESENCE_THROTTLE_MS
  ) {
    // Re-send current presence on sustained activity if prior packet was missed.
    sendCurrentPresence();
  }

  armIdleTimer();
}

async function sendAwayIfConnected() {
  if (!state.connected) return;

  try {
    await bridge.send({ type: "send-presence", state: "away" });
  } catch {
    // Ignore best-effort away signal failures.
  }

  state.localPresence = "away";
}

function enablePresenceTracking() {
  const activityEvents = [
    "pointermove",
    "pointerdown",
    "pointerup",
    "mousemove",
    "mousedown",
    "mouseup",
    "keydown",
    "keyup",
    "touchstart",
    "wheel",
  ];

  for (const eventName of activityEvents) {
    document.addEventListener(eventName, markUserActive, {
      passive: true,
      capture: true,
    });
  }

  window.addEventListener("focus", markUserActive);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markUserActive();
  });
}

function readSavedWindowSize() {
  try {
    const raw = localStorage.getItem(WINDOW_SIZE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height)
    ) {
      return {
        width: Math.round(parsed.width),
        height: Math.round(parsed.height),
      };
    }
  } catch {
    // Ignore corrupt localStorage values.
  }

  return null;
}

function readSavedWindowPosition() {
  try {
    const raw = localStorage.getItem(WINDOW_POSITION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return {
        x: Math.round(parsed.x),
        y: Math.round(parsed.y),
      };
    }
  } catch {
    // Ignore corrupt localStorage values.
  }

  return null;
}

function saveWindowSize(size) {
  try {
    localStorage.setItem(
      WINDOW_SIZE_KEY,
      JSON.stringify({ width: size.width, height: size.height }),
    );
  } catch {
    // Ignore persistence failures.
  }
}

function saveWindowPosition(position) {
  try {
    localStorage.setItem(
      WINDOW_POSITION_KEY,
      JSON.stringify({ x: position.x, y: position.y }),
    );
  } catch {
    // Ignore persistence failures.
  }
}

function applySavedWindowPlacementForJoined() {
  const savedSize = readSavedWindowSize();
  const savedPosition = readSavedWindowPosition();

  if (savedSize) {
    appWindow
      .setSize(new PhysicalSize(savedSize.width, savedSize.height))
      .catch(() => {});
  }

  if (savedPosition) {
    appWindow
      .setPosition(new PhysicalPosition(savedPosition.x, savedPosition.y))
      .catch(() => {});
  }
}

function enableWindowPositionPersistence() {
  appWindow
    .onResized(({ payload: size }) => {
      if (!state.connected) return;
      saveWindowSize(size);
    })
    .catch(() => {});

  appWindow
    .onMoved(({ payload: position }) => {
      if (!state.connected) return;
      saveWindowPosition(position);
    })
    .catch(() => {});
}

function centerWindowOnLaunch() {
  appWindow
    .currentMonitor()
    .then(async (monitor) => {
      await appWindow.setSize(
        new PhysicalSize(ONBOARDING_WINDOW_WIDTH, ONBOARDING_WINDOW_HEIGHT),
      );

      if (!monitor) return;

      const size = await appWindow.outerSize();
      await appWindow.setPosition(
        new PhysicalPosition(
          Math.round(
            monitor.position.x + (monitor.size.width - size.width) / 2,
          ),
          Math.round(
            monitor.position.y + (monitor.size.height - size.height) / 2,
          ),
        ),
      );

      await appWindow.setAlwaysOnTop(true);
      if (navigator.userAgent.includes("Macintosh"))
        await appWindow.setVisibleOnAllWorkspaces(true);
    })
    .catch(() => {});
}

function triggerPrimaryAction() {
  const primaryButton = app.querySelector(
    '.primary:not([disabled]):not([aria-disabled="true"])',
  );

  if (primaryButton) primaryButton.click();
}

bridge.onEvent((event) => {
  if (event.type === "ready" && typeof event.publicKey === "string") {
    state.selfPeerId = event.publicKey;
    // Migrate older installs that persisted the generic fallback label.
    if (state.displayName === "peer") {
      state.displayName = "";
      saveDisplayName(state.displayName);
    }
  } else if (event.type === "invite") {
    if (!state.creatingRoom) {
      bridge.send({ type: "leave" }).catch(() => {});
      return;
    }

    state.inviteCode = event.code;
    saveLastRoomCode(event.code);
    renderInvite();
  } else if (event.type === "peer-status" && typeof event.peer === "string") {
    const peer = ensurePeer(event.peer);

    if (event.connected) {
      peer.lastSeenAt = Date.now();
      if (event.peer !== state.selfPeerId) state.connectedPeers.add(event.peer);
      if (event.peer !== state.selfPeerId) {
        pushPeerNotice("joined", event.peer);
      }
    } else {
      peer.presence = "away";
      peer.lastSeenAt = Date.now();
      state.connectedPeers.delete(event.peer);
      if (event.peer !== state.selfPeerId) {
        pushPeerNotice("left", event.peer);
      }
    }

    setConnection(activePeerCount() > 0);
    if (app.querySelector(".main-widget")) renderWidget();
    renderMessages();
  } else if (event.type === "presence") {
    if (typeof event.peer !== "string") return;
    const peer = ensurePeer(event.peer);
    peer.presence = event.state;
    peer.lastSeenAt = Date.now();
    if (event.peer !== state.selfPeerId) state.connectedPeers.add(event.peer);

    setConnection(activePeerCount() > 0);

    if (app.querySelector(".main-widget")) renderWidget();
  } else if (event.type === "chat") {
    if (typeof event.peer === "string") {
      const peer = ensurePeer(event.peer);
      peer.lastSeenAt = Date.now();
      event.displayName = peer.displayName || "";
      state.typingPeers.delete(event.peer);
    }

    pushUnreadChatEntry(event, true);
    if (!state.chatOpen && app.querySelector(".main-widget")) renderWidget();
    renderMessages();
  } else if (event.type === "typing") {
    if (typeof event.peer === "string") {
      console.log("[TYPING] Received typing event from peer:", event.peer);
      const peer = ensurePeer(event.peer);
      peer.lastSeenAt = Date.now();
      state.typingPeers.set(event.peer, Date.now());
      console.log(
        "[TYPING] Current typing peers:",
        Array.from(state.typingPeers.keys()),
      );
      if (app.querySelector(".main-widget")) renderWidget();
    }
  } else if (event.type === "stopped-typing") {
    if (typeof event.peer === "string") {
      console.log(
        "[TYPING] Received stopped-typing event from peer:",
        event.peer,
      );
      state.typingPeers.delete(event.peer);
      if (app.querySelector(".main-widget")) renderWidget();
    }
  } else if (event.type === "profile" && typeof event.peer === "string") {
    const peer = ensurePeer(event.peer);
    peer.displayName = normalizeDisplayName(event.displayName ?? "");
    peer.lastSeenAt = Date.now();

    if (app.querySelector(".main-widget")) renderWidget();
  } else if (event.type === "error") {
    clearTimeout(state.joinWaitTimer);
    state.joinWaitTimer = null;
    state.joiningRoom = false;
    const joinButton = app.querySelector('[data-action="join"]');
    if (joinButton) {
      joinButton.disabled = false;
      joinButton.textContent = "Connect";
    }

    showError(event.message);
  }
});
window.addEventListener("keydown", (event) => {
  const namePopover = app.querySelector(".menu-popover");
  const nameInput = app.querySelector("#display-name-input");
  const nameForm = app.querySelector(".name-form");
  const isNameEditorOpen = Boolean(namePopover && !namePopover.hidden);

  if (isNameEditorOpen && event.key === "Escape") {
    event.preventDefault();
    if (nameInput) nameInput.value = state.displayName;
    if (namePopover) {
      state.menuOpen = false;
      namePopover.hidden = true;
    }
    return;
  }

  if (
    isNameEditorOpen &&
    event.key === "Enter" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    nameForm?.requestSubmit();
    return;
  }

  if (event.key === "Escape" && state.clickThrough) {
    state.clickThrough = false;
    bridge.setClickThrough(false).then(renderWidget).catch(showError);
    return;
  }

  if (event.key !== "Enter") return;
  if (event.defaultPrevented || event.repeat) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"]')
  ) {
    return;
  }

  event.preventDefault();
  triggerPrimaryAction();
});
state.displayName = readDisplayName();
renderOnboarding();
centerWindowOnLaunch();
enableWindowPositionPersistence();
enablePresenceTracking();
enableEscapeKeyHandler();
state.zoomLevel = readSavedZoomLevel();
applyZoomLevel(state.zoomLevel);
enableZoomKeyHandler();
bridge
  .start()
  .catch((error) =>
    showError(`Could not launch Bare: ${normalizeError(error)}`),
  );
