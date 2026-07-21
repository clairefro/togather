// Keep the window visible during startup; we switch back to transparent after first render.
document.body.style.background = "#161a20";

function renderBootError(message) {
  const root = document.querySelector("#app");
  if (!root) return;
  root.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;padding:18px;color:#e6f0eb;font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;background:#161a20;">Startup error: ${String(message)}</div>`;
}

window.addEventListener("error", (event) => {
  renderBootError(event?.error?.message || event?.message || "Unknown error");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  const message =
    typeof reason === "string"
      ? reason
      : reason && typeof reason.message === "string"
        ? reason.message
        : "Promise rejected during startup";
  renderBootError(message);
});

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
const LAST_ROOM_CODE_KEY = "togather.last-room-code.v1";
const DISPLAY_NAME_KEY = "togather.display-name.v1";
const AVATAR_KEY = "togather.avatar-data-url.v1";
const STATUS_EMOJI_KEY = "togather.status-emoji.v1";
const STATUS_TEXT_KEY = "togather.status-text.v1";
const ZOOM_LEVEL_KEY = "togather.zoom-level.v2";
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.1;
const MAX_AVATAR_WIDTH = 250;
const MAX_AVATAR_HEIGHT = 200;
const MAX_AVATAR_DATA_URL_LENGTH = 400000;
const JOIN_WAIT_TIMEOUT_MS = 20000;
const IDLE_AFTER_MS = 3 * 60 * 1000;
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_WATCHDOG_MS = 1000;
const ACTIVITY_PRESENCE_THROTTLE_MS = 750;
const SYSTEM_IDLE_POLL_MS = 1000;
const STATUS_MAX_TEXT_LENGTH = 80;
const STATUS_EMOJI_MAX_LENGTH = 32;
const PEER_CHIRP_MAX_LENGTH = 120;
const PEER_CHIRP_VISIBLE_MS = 10_000;
const ZOOM_NOTICE_DURATION_MS = 900;
const COLOR_SATURATION_STEPS = [62, 68, 74, 80, 56];
const COLOR_LIGHTNESS_STEPS = [52, 58, 64, 70, 46];
const COLOR_HUE_STEP = 47;
const TOTAL_COLOR_VARIANTS =
  360 * COLOR_SATURATION_STEPS.length * COLOR_LIGHTNESS_STEPS.length;
const state = {
  connected: false,
  selfPeerId: "",
  peers: new Map(),
  connectedPeers: new Set(),
  localPresence: "present",
  displayName: "",
  displayNameDraft: "",
  avatar: "",
  statusEmoji: "",
  statusText: "",
  statusEmojiDraft: "",
  statusTextDraft: "",
  statusEmojiPickerOpen: false,
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
  peerColorIndexes: new Map(),
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
  appVersion: "",
  sendQueue: Promise.resolve(),
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

async function copyText(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Nothing to copy");

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-1000px";
  input.style.left = "-1000px";
  document.body.appendChild(input);
  input.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(input);
  if (!copied) {
    // Last-resort fallback for restricted webview clipboard contexts.
    window.prompt("Copy room code:", text);
  }
}

function menuVersionLabel() {
  return state.appVersion ? `v${state.appVersion}` : "";
}

function applyMenuVersionLabel() {
  const label = menuVersionLabel();
  for (const node of app.querySelectorAll("[data-app-version]")) {
    node.textContent = label;
  }
}

async function loadAppVersion() {
  try {
    const version = await tauri.app?.getVersion?.();
    if (typeof version !== "string") return;

    const normalized = version.trim();
    if (!normalized) return;

    state.appVersion = normalized;
    applyMenuVersionLabel();
  } catch {
    // Version is optional in the menu when unavailable.
  }
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

    const line = `${JSON.stringify(object)}\n`;
    const writeTask = state.sendQueue.then(
      () => state.child?.write(line),
      () => state.child?.write(line),
    );

    state.sendQueue = writeTask.catch(() => {});
    await writeTask;
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

function readAvatar() {
  try {
    const value = localStorage.getItem(AVATAR_KEY);
    if (typeof value !== "string") return "";

    const normalized = value.trim();
    if (!normalized || !normalized.startsWith("data:image/png;base64,")) {
      return "";
    }

    if (normalized.length > MAX_AVATAR_DATA_URL_LENGTH) return "";
    return normalized;
  } catch {
    return "";
  }
}

function saveAvatar(value) {
  try {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized && normalized.startsWith("data:image/png;base64,")) {
      localStorage.setItem(AVATAR_KEY, normalized);
    } else {
      localStorage.removeItem(AVATAR_KEY);
    }
  } catch {
    // Ignore localStorage write failures.
  }
}

function normalizeStatusEmoji(value) {
  if (typeof value !== "string") return "";

  const normalized = value.trim();
  if (!normalized) return "";
  return normalized.slice(0, STATUS_EMOJI_MAX_LENGTH);
}

function normalizeStatusText(value) {
  if (typeof value !== "string") return "";

  return value.trim().slice(0, STATUS_MAX_TEXT_LENGTH);
}

function readStatusEmoji() {
  try {
    return normalizeStatusEmoji(localStorage.getItem(STATUS_EMOJI_KEY) ?? "");
  } catch {
    return "";
  }
}

function readStatusText() {
  try {
    return normalizeStatusText(localStorage.getItem(STATUS_TEXT_KEY) ?? "");
  } catch {
    return "";
  }
}

function saveStatus(statusEmoji, statusText) {
  const normalizedEmoji = normalizeStatusEmoji(statusEmoji);
  const normalizedText = normalizeStatusText(statusText);

  try {
    if (normalizedEmoji) {
      localStorage.setItem(STATUS_EMOJI_KEY, normalizedEmoji);
      if (normalizedText) {
        localStorage.setItem(STATUS_TEXT_KEY, normalizedText);
      } else {
        localStorage.removeItem(STATUS_TEXT_KEY);
      }
    } else {
      localStorage.removeItem(STATUS_EMOJI_KEY);
      localStorage.removeItem(STATUS_TEXT_KEY);
    }
  } catch {
    // Ignore localStorage write failures.
  }
}

function normalizePeerChirpText(value) {
  if (typeof value !== "string") return "";

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.slice(0, PEER_CHIRP_MAX_LENGTH);
}

function avatarAltText(name) {
  const label = normalizeDisplayName(name) || defaultDisplayName() || "avatar";
  return `${label}'s avatar`;
}

function avatarMarkup(avatar, name, className) {
  if (avatar) {
    return `<img class="${className}" src="${escapeAttribute(avatar)}" alt="${escapeAttribute(avatarAltText(name))}">`;
  }

  return `<div class="${className} fallback-avatar" aria-hidden="true"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="32"/><circle class="eye" cx="34" cy="42" r="4"/><circle class="eye" cx="56" cy="42" r="4"/><path d="M31 57 Q45 65 59 57"/></svg></div>`;
}

function statusBadgeMarkup(
  statusEmoji,
  statusText,
  className = "status-badge",
) {
  const emoji = normalizeStatusEmoji(statusEmoji);
  if (!emoji) return "";

  const text = normalizeStatusText(statusText);
  const title = text ? ` title="${escapeAttribute(text)}"` : "";
  const aria = text
    ? ` aria-label="Status: ${escapeAttribute(text)}"`
    : ' aria-hidden="true"';

  if (className === "status-thinking-bubble") {
    return `<span class="${className}"${title}${aria}><svg class="status-thinking-bubble-svg" viewBox="0 0 50 40" aria-hidden="true" focusable="false"><defs><linearGradient id="status-thinking-bubble-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgb(49 55 64 / 72%)"/><stop offset="100%" stop-color="rgb(39 44 51 / 72%)"/></linearGradient></defs><circle class="status-thinking-bubble-tail status-thinking-bubble-tail-large" cx="18" cy="31" r="4.5"/><circle class="status-thinking-bubble-tail status-thinking-bubble-tail-small" cx="12" cy="36" r="2.75"/><rect class="status-thinking-bubble-body" x="11" y="2" width="37" height="26" rx="13" fill="url(#status-thinking-bubble-fill)"/></svg><span class="status-thinking-bubble-emoji">${escapeHtml(emoji)}</span></span>`;
  }

  return `<span class="${className}"${title}${aria}>${escapeHtml(emoji)}</span>`;
}

function buildLocalProfilePayload() {
  return {
    displayName: state.displayName,
    avatar: state.avatar,
    statusEmoji: state.statusEmoji,
    statusText: state.statusText,
  };
}

function clearStatusForNewRoomSession() {
  state.statusEmoji = "";
  state.statusText = "";
  state.statusEmojiDraft = "";
  state.statusTextDraft = "";
  state.statusEmojiPickerOpen = false;
  saveStatus("", "");
}

async function sendLocalProfile() {
  await bridge.send({
    type: "set-profile",
    ...buildLocalProfilePayload(),
  });
}

function isPngAvatarDataUrl(value) {
  return (
    typeof value === "string" &&
    value.startsWith("data:image/png;base64,") &&
    value.length <= MAX_AVATAR_DATA_URL_LENGTH
  );
}

function isPngAvatarFile(file) {
  if (!(file instanceof File)) return false;

  const mimeType = typeof file.type === "string" ? file.type.trim() : "";
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  return mimeType === "image/png" || name.endsWith(".png");
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read the image."));
    };

    image.src = objectUrl;
  });
}

async function resizePngToDataUrl(file) {
  if (!(file instanceof File)) {
    throw new Error("Choose a PNG image.");
  }

  if (!isPngAvatarFile(file)) throw new Error("Avatar must be a PNG image.");

  const image = await loadImageFromFile(file);
  const scale = Math.min(
    MAX_AVATAR_WIDTH / image.width,
    MAX_AVATAR_HEIGHT / image.height,
    1,
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Avatar conversion failed.");

  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/png");
  if (!isPngAvatarDataUrl(dataUrl)) {
    throw new Error("Avatar conversion failed.");
  }

  return dataUrl;
}

async function applyAvatarFromFile(file) {
  const avatar = await resizePngToDataUrl(file);
  state.avatar = avatar;
  saveAvatar(avatar);

  await sendLocalProfile();

  rerenderAfterAvatarUpdate();
}

function rerenderAfterAvatarUpdate() {
  if (app.querySelector(".main-widget")) {
    renderWidget();
    return;
  }

  if (app.querySelector(".onboarding")) {
    renderOnboarding(state.joiningRoom ? "join" : "choose");
  }
}

function askConfirm(message, options = {}) {
  const confirmLabel =
    typeof options.confirmLabel === "string" && options.confirmLabel.trim()
      ? options.confirmLabel.trim()
      : "Confirm";
  const cancelLabel =
    typeof options.cancelLabel === "string" && options.cancelLabel.trim()
      ? options.cancelLabel.trim()
      : "Cancel";

  const existing = document.querySelector(".confirm-backdrop");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";

    backdrop.innerHTML = `<div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirmation"><p class="confirm-message">${escapeHtml(String(message || "Are you sure?"))}</p><div class="confirm-actions"><button type="button" class="quiet confirm-cancel">${escapeHtml(cancelLabel)}</button><button type="button" class="primary confirm-approve">${escapeHtml(confirmLabel)}</button></div></div>`;

    const cancelButton = backdrop.querySelector(".confirm-cancel");
    const approveButton = backdrop.querySelector(".confirm-approve");
    const dialog = backdrop.querySelector(".confirm-dialog");

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      resolve(Boolean(value));
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(false);
    });
    dialog?.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    cancelButton?.addEventListener("click", () => finish(false));
    approveButton?.addEventListener("click", () => finish(true));
    window.addEventListener("keydown", onKeyDown);

    document.body.append(backdrop);
    approveButton?.focus();
  });
}

function confirmAvatarRemoval() {
  return askConfirm("Are you sure you want to remove your avatar?", {
    confirmLabel: "Remove",
    cancelLabel: "Cancel",
  });
}

async function clearAvatar() {
  if (!state.avatar) {
    rerenderAfterAvatarUpdate();
    return;
  }

  state.avatar = "";
  saveAvatar("");

  await sendLocalProfile();

  rerenderAfterAvatarUpdate();
}

function bindAvatarControls(scope = app) {
  for (const zone of scope.querySelectorAll("[data-avatar-select-trigger]")) {
    zone.addEventListener("click", () => {
      zone
        .closest(".avatar-editor")
        ?.querySelector("[data-avatar-file]")
        ?.click();
    });
  }

  for (const input of scope.querySelectorAll("[data-avatar-file]")) {
    input.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;

      const file = target.files?.[0];
      target.value = "";
      if (!file) return;

      if (!isPngAvatarFile(file)) {
        showError("Please select a png file.");
        return;
      }

      try {
        await applyAvatarFromFile(file);
      } catch (error) {
        showError(error);
      }
    });
  }

  for (const button of scope.querySelectorAll("[data-avatar-delete]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const confirmed = await confirmAvatarRemoval();
      if (!confirmed) return;

      try {
        await clearAvatar();
      } catch (error) {
        showError(error);
      }
    });
  }
}

function renderAvatarEditorMarkup(avatarName) {
  const preview = avatarMarkup(
    state.avatar,
    avatarName || state.displayName || "you",
    "avatar-preview",
  );
  const hasAvatar = isPngAvatarDataUrl(state.avatar);
  const uploadButtonLabel = hasAvatar ? "Change avatar" : "Add avatar";

  const deleteButton = hasAvatar
    ? '<button type="button" class="icon-button avatar-delete-button" data-avatar-delete aria-label="Remove avatar" title="Remove avatar">×</button>'
    : "";

  return `<div class="avatar-editor"><div class="avatar-preview-wrap" data-avatar-select-trigger>${preview}${deleteButton}<div class="avatar-overlay"><button type="button" class="quiet avatar-upload-button" data-avatar-upload>${uploadButtonLabel}</button></div></div><input type="file" accept=".png,image/png" hidden data-avatar-file></div>`;
}

function mountAvatarEditor(options = {}) {
  const {
    container,
    avatarName,
    beforeSelector,
    insertPosition = "afterbegin",
  } = options;

  if (!container || container.querySelector("[data-avatar-select-trigger]"))
    return;

  const editorMarkup = renderAvatarEditorMarkup(avatarName);
  const target = beforeSelector
    ? container.querySelector(beforeSelector)
    : null;
  if (target) {
    target.insertAdjacentHTML("beforebegin", editorMarkup);
    return;
  }

  container.insertAdjacentHTML(insertPosition, editorMarkup);
}

function ensurePeer(peerId) {
  const existing = state.peers.get(peerId);
  if (existing) return existing;

  const created = {
    presence: "present",
    displayName: "",
    avatar: "",
    statusEmoji: "",
    statusText: "",
    chirpText: "",
    chirpToken: 0,
    lastSeenAt: Date.now(),
    idleSinceAt: null,
  };
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

function connectedParticipantCount() {
  return state.connected ? activePeerCount() + 1 : 0;
}

function aggregatePeerPresence() {
  if (!activePeerCount()) return "idle";

  let hasIdle = false;
  for (const peerId of activePeerIds()) {
    const presence = state.peers.get(peerId)?.presence ?? "present";
    if (presence === "present") return "present";
    if (presence === "idle") hasIdle = true;
  }

  return hasIdle ? "idle" : "present";
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

function moreMenuIconSvg() {
  return '<svg class="more-menu-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="4" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12" cy="8" r="1.25" fill="currentColor"/></svg>';
}
function copyIconSvg() {
  return '<img class="copy-icon" src="assets/copy.svg" alt="" aria-hidden="true">';
}

function zoomMenuMarkup() {
  return `<div class="menu-section zoom-menu-section"><div class="zoom-menu-row"><label class="menu-label">Zoom</label><div class="zoom-menu-buttons"><button type="button" class="icon-button zoom-step-button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" class="icon-button zoom-step-button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button></div></div><p class="zoom-shortcut-hint">cmd/ctrl +/-</p></div>`;
}

function roomInfoMenuMarkup(peerCount) {
  return `<div class="menu-section"><label class="menu-label" for="room-code-input">Room</label><div class="room-code-row"><input id="room-code-input" class="room-code-field" value="${escapeAttribute(currentRoomCode())}" readonly aria-label="Room code"><button type="button" class="icon-button copy-room-button" data-action="copy-room" aria-label="Copy room code" title="Copy room code">${copyIconSvg()}</button></div><p class="menu-meta">${peerCount} ${peerCount === 1 ? "peer" : "peers"} present</p></div>`;
}

function nameMenuMarkup(menuNameValue) {
  return `<form class="name-form menu-section"><label class="menu-label" for="display-name-input">Display name</label><div class="name-input-row"><input id="display-name-input" maxlength="40" placeholder="${escapeHtml(nameEditorPlaceholder())}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(menuNameValue)}"><button type="submit" class="checkmark-button" data-action="save-name" title="Update" hidden aria-label="Save display name">✓</button></div></form>`;
}

function statusMenuMarkup(menuStatusEmojiValue) {
  const triggerLabel = menuStatusEmojiValue
    ? `${menuStatusEmojiValue} ▾`
    : "Pick ▾";
  return `<section class="status-form menu-section"><div class="status-form-header"><label class="menu-label">Status</label><input id="status-emoji-input" type="hidden" value="${escapeAttribute(menuStatusEmojiValue)}"><button type="button" class="status-emoji-trigger" data-action="toggle-status-picker" aria-expanded="${state.statusEmojiPickerOpen ? "true" : "false"}" aria-label="Open emoji picker">${escapeHtml(triggerLabel)}</button><button type="button" class="icon-button status-clear-button" data-action="clear-status" aria-label="Clear status" title="Clear status">×</button></div></section>`;
}

function statusPickerLayerMarkup() {
  return '<div class="status-picker-layer" data-status-picker-layer hidden><button type="button" class="status-picker-scrim" data-action="close-status-picker" aria-label="Close emoji picker"></button><div class="status-picker-panel" role="dialog" aria-modal="true" aria-label="Choose a status emoji"><div class="status-picker-header"><span>Status emoji</span><button type="button" class="icon-button status-picker-close" data-action="close-status-picker" aria-label="Close emoji picker">×</button></div><emoji-picker class="status-emoji-picker-widget" data-status-emoji-picker data-source="assets/vendor/emoji-picker-element-data/en/data.json"></emoji-picker></div></div>';
}

function menuDividerMarkup() {
  return '<div class="menu-divider" role="separator" aria-hidden="true"></div>';
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
  const previousRoomCode = readLastRoomCode();
  const usePreviousRoomButton = previousRoomCode
    ? '<button type="button" class="use-prev-code-inline" data-action="use-prev-room-id" aria-label="Use previous room code" title="Use previous room code">↺</button>'
    : "";
  const joinContent = `<label class="field-label" for="invite-code">Room code</label><div class="code-input-wrap"><input id="invite-code" class="code-input" autocomplete="off" spellcheck="false" maxlength="80" placeholder="Paste room code">${usePreviousRoomButton}<button type="button" class="clear-code" data-action="clear-code" aria-label="Clear room code">×</button></div><button class="primary" data-action="join" ${state.joiningRoom ? "disabled" : ""}>${joiningLabel}</button><button class="quiet" data-action="back">Back</button>`;
  const menuNameValue =
    state.menuOpen && typeof state.displayNameDraft === "string"
      ? state.displayNameDraft
      : defaultDisplayName();
  const menuStatusEmojiValue =
    state.menuOpen && typeof state.statusEmojiDraft === "string"
      ? state.statusEmojiDraft
      : state.statusEmoji;
  const roomSection = state.connected
    ? roomInfoMenuMarkup(connectedParticipantCount())
    : "";
  app.innerHTML = `<section class="widget onboarding"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button" data-action="menu" aria-label="Menu">${moreMenuIconSvg()}</button><button class="icon-button" data-action="minimize" aria-label="Minimize">−</button><button class="icon-button" data-action="exit" aria-label="Exit">×</button></header><div class="onboarding-body"><div class="onboarding-content"><h1>Let's get togather</h1><p class="muted">Ambient-cowork directly with peers</p><p class="error" data-error hidden></p>${mode === "choose" ? chooseContent : joinContent}</div></div><aside class="menu-popover" ${state.menuOpen ? "" : "hidden"}><div class="menu-header"><span class="menu-version" data-app-version>${escapeHtml(menuVersionLabel())}</span><button type="button" class="icon-button menu-close" data-action="cancel-name" aria-label="Close menu">×</button></div>${roomSection}${nameMenuMarkup(menuNameValue)}${statusMenuMarkup(menuStatusEmojiValue)}${menuDividerMarkup()}${zoomMenuMarkup()}</aside>${statusPickerLayerMarkup()}<button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;
  applyMenuVersionLabel();
  mountAvatarEditor({
    container: app.querySelector(".onboarding-body"),
    avatarName: state.displayName || "you",
    beforeSelector: "[data-error]",
  });
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
  if (mode === "choose") {
    requestAnimationFrame(() => {
      const input = app.querySelector("#onboarding-display-name-input");
      if (!input) return;

      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  if (mode === "join") {
    requestAnimationFrame(() => {
      const input = app.querySelector("#invite-code");
      if (!input) return;

      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
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
          avatar: state.avatar,
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
      if (!input) return;

      input.value = "";
      input.focus();
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
    clearError();
  });

  app
    .querySelector('[data-action="use-prev-room-id"]')
    ?.addEventListener("click", () => {
      const code = readLastRoomCode();
      if (!code) return;

      const input = app.querySelector("#invite-code");
      if (!input) return;

      input.value = code;
      input.focus();
      input.setSelectionRange(code.length, code.length);
    });

  bindAvatarControls(app);
  bindZoomMenuControls();

  bindNameMenu();
  bindStatusMenu();

  bindDragHandle();
  bindResizeHandle();
}

function renderInvite() {
  state.creatingRoom = false;
  document.body.classList.remove("joined-transparent");
  app.innerHTML = `<section class="widget onboarding"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button" data-action="minimize" aria-label="Minimize">−</button><button class="icon-button" data-action="exit" aria-label="Exit">×</button></header><div class="onboarding-body invite-screen"><div class="onboarding-content"><div class="pulse-ring"><span>♡</span></div><h1>Share this code</h1><p class="muted">Send it through a channel you already trust.</p><div class="invite-code-inline"><input class="invite-code-input" value="${escapeAttribute(state.inviteCode)}" readonly aria-label="Room code"><button type="button" class="icon-button invite-code-copy" data-action="copy-invite" aria-label="Copy room code" title="Copy room code">${copyIconSvg()}</button></div><button class="primary" data-action="copy-invite-primary">Copy room id</button><button class="quiet" data-action="reset">Back</button><p class="waiting"><i></i> Waiting for peers...</p><p class="error" data-error hidden></p></div></div><button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;

  const runInviteCopy = async () => {
    try {
      const inviteInput = app.querySelector(".invite-code-input");
      const code = inviteInput?.value?.trim() || state.inviteCode;
      await copyText(code);

      const iconButton = app.querySelector('[data-action="copy-invite"]');
      if (iconButton) {
        const originalIcon = iconButton.innerHTML;
        iconButton.innerHTML = "✓";
        setTimeout(() => {
          iconButton.innerHTML = originalIcon;
        }, 900);
      }

      const primaryButton = app.querySelector(
        '[data-action="copy-invite-primary"]',
      );
      if (primaryButton) {
        const originalPrimary = primaryButton.textContent;
        primaryButton.textContent = "Copied";
        setTimeout(() => {
          primaryButton.textContent = originalPrimary;
        }, 900);
      }
    } catch {
      showError("Could not copy room code.");
    }
  };

  app
    .querySelector('[data-action="copy-invite"]')
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void runInviteCopy();
    });

  app
    .querySelector('[data-action="copy-invite-primary"]')
    ?.addEventListener("click", () => {
      void runInviteCopy();
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

function colorIndexToHsl(index) {
  const normalized = Math.max(0, Math.floor(index));
  const hue = (normalized * COLOR_HUE_STEP) % 360;
  const saturation =
    COLOR_SATURATION_STEPS[
      Math.floor(normalized / 360) % COLOR_SATURATION_STEPS.length
    ];
  const lightness =
    COLOR_LIGHTNESS_STEPS[
      Math.floor(normalized / (360 * COLOR_SATURATION_STEPS.length)) %
        COLOR_LIGHTNESS_STEPS.length
    ];

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function reserveColorIndexForKey(key) {
  const normalizedKey = typeof key === "string" ? key : String(key ?? "");
  const existingIndex = state.peerColorIndexes.get(normalizedKey);
  if (Number.isInteger(existingIndex)) return existingIndex;

  const used = new Set(state.peerColorIndexes.values());
  let candidate = hashToHue(normalizedKey) % TOTAL_COLOR_VARIANTS;

  for (let attempt = 0; attempt < TOTAL_COLOR_VARIANTS; attempt += 1) {
    if (!used.has(candidate)) {
      state.peerColorIndexes.set(normalizedKey, candidate);
      return candidate;
    }

    candidate = (candidate + 1) % TOTAL_COLOR_VARIANTS;
  }

  // Extremely unlikely fallback once all variants are reserved.
  const fallbackIndex = state.peerColorIndexes.size % TOTAL_COLOR_VARIANTS;
  state.peerColorIndexes.set(normalizedKey, fallbackIndex);
  return fallbackIndex;
}

function chatNameColor(key) {
  const index = reserveColorIndexForKey(key);
  return colorIndexToHsl(index);
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

function formatLocalTimestamp(timestamp) {
  const date = new Date(
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp
      : Date.now(),
  );

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
  return "Enter name";
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

    const openingMenu = !state.menuOpen;
    if (openingMenu) {
      state.chatOpen = false;
      const chatPopover = app.querySelector(".chat-popover");
      if (chatPopover) chatPopover.hidden = true;
    }

    state.menuOpen = openingMenu;
    popover.hidden = !state.menuOpen;
    if (state.menuOpen) {
      state.displayNameDraft = input.value || defaultDisplayName();
      state.statusEmojiDraft = state.statusEmoji;
      state.statusTextDraft = state.statusText;
      state.statusEmojiPickerOpen = false;
      requestAnimationFrame(() => {
        if (!state.menuOpen || popover.hidden) return;

        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    } else {
      state.displayNameDraft = defaultDisplayName();
    }
  });

  app
    .querySelector('[data-action="cancel-name"]')
    ?.addEventListener("click", () => {
      const popover = app.querySelector(".menu-popover");
      const input = app.querySelector("#display-name-input");
      if (!popover || !input) return;

      input.value = state.displayName;
      state.displayNameDraft = defaultDisplayName();
      state.statusEmojiDraft = state.statusEmoji;
      state.statusTextDraft = state.statusText;
      state.statusEmojiPickerOpen = false;
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
        await copyText(code);
        const button = app.querySelector('[data-action="copy-room"]');
        if (!button) return;

        const original = button.innerHTML;
        button.innerHTML = "✓";
        setTimeout(() => {
          button.innerHTML = original;
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
    state.displayNameDraft = state.displayName;
    saveDisplayName(state.displayName);

    try {
      await sendLocalProfile();
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
    ?.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) {
        state.displayNameDraft = target.value;
      }
      syncNameEditorControls();
    });
  syncNameEditorControls();
}

function syncStatusEditorControls() {
  const emojiInput = app.querySelector("#status-emoji-input");
  const clearButton = app.querySelector('[data-action="clear-status"]');
  const triggerButton = app.querySelector(
    '[data-action="toggle-status-picker"]',
  );
  if (!emojiInput || !clearButton || !triggerButton) return;

  const selectedEmoji = normalizeStatusEmoji(emojiInput.value);
  emojiInput.value = selectedEmoji;
  triggerButton.textContent = selectedEmoji ? `${selectedEmoji} ▾` : "Pick ▾";

  const hasStatus = selectedEmoji !== "";
  clearButton.disabled = !hasStatus;
  clearButton.setAttribute("aria-disabled", hasStatus ? "false" : "true");
}

function bindStatusMenu() {
  const emojiInput = app.querySelector("#status-emoji-input");
  const clearButton = app.querySelector('[data-action="clear-status"]');
  const togglePickerButton = app.querySelector(
    '[data-action="toggle-status-picker"]',
  );
  const pickerLayer = app.querySelector("[data-status-picker-layer]");
  const pickerWidget = app.querySelector("[data-status-emoji-picker]");
  const pickerScrim = app.querySelector(".status-picker-scrim");
  const pickerCloseButton = app.querySelector(".status-picker-close");
  const closePickerButtons = app.querySelectorAll(
    '[data-action="close-status-picker"]',
  );
  if (!emojiInput || !clearButton) return;

  const commitStatus = async () => {
    const nextEmoji = normalizeStatusEmoji(emojiInput.value);
    const nextText = "";

    state.statusEmoji = nextEmoji;
    state.statusText = nextText;
    state.statusEmojiDraft = nextEmoji;
    state.statusTextDraft = nextText;
    saveStatus(nextEmoji, nextText);

    try {
      await sendLocalProfile();
    } catch (error) {
      showError(error);
    }
  };

  const closePicker = () => {
    state.statusEmojiPickerOpen = false;
    if (pickerLayer) pickerLayer.hidden = true;
    if (togglePickerButton) {
      togglePickerButton.setAttribute("aria-expanded", "false");
    }
  };

  // Always start from a closed picker layer after each render.
  closePicker();

  if (togglePickerButton && pickerLayer) {
    togglePickerButton.addEventListener("click", () => {
      state.statusEmojiPickerOpen = !state.statusEmojiPickerOpen;
      pickerLayer.hidden = !state.statusEmojiPickerOpen;
      togglePickerButton.setAttribute(
        "aria-expanded",
        state.statusEmojiPickerOpen ? "true" : "false",
      );
    });
  }

  for (const button of closePickerButtons) {
    button.addEventListener("click", () => {
      closePicker();
    });
  }
  pickerScrim?.addEventListener("click", closePicker);
  pickerCloseButton?.addEventListener("click", closePicker);

  const applyPickedEmoji = async (detailLike) => {
    let detail;
    try {
      detail = await Promise.resolve(detailLike);
    } catch {
      return;
    }

    const emoji = normalizeStatusEmoji(
      detail?.unicode || detail?.emoji?.emoji || detail?.emoji?.unicode || "",
    );
    if (!emoji) return;

    emojiInput.value = emoji;
    closePicker();
    syncStatusEditorControls();
    await commitStatus();
  };

  pickerWidget?.addEventListener("emoji-click-sync", (event) => {
    void applyPickedEmoji(event?.detail);
  });
  pickerWidget?.addEventListener("emoji-click", (event) => {
    void applyPickedEmoji(event?.detail);
  });

  clearButton.addEventListener("click", () => {
    emojiInput.value = "";
    closePicker();
    syncStatusEditorControls();
    void commitStatus();
  });

  syncStatusEditorControls();
}

function closeAllPopups() {
  state.menuOpen = false;
  state.chatOpen = false;
  state.statusEmojiPickerOpen = false;
  const menuPopover = app.querySelector(".menu-popover");
  const chatPopover = app.querySelector(".chat-popover");
  const statusPickerLayer = app.querySelector("[data-status-picker-layer]");
  if (menuPopover) menuPopover.hidden = true;
  if (chatPopover) chatPopover.hidden = true;
  if (statusPickerLayer) statusPickerLayer.hidden = true;
}

function enableEscapeKeyHandler() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const menuOpen = state.menuOpen;
      const chatOpen = state.chatOpen;
      const statusPickerOpen = state.statusEmojiPickerOpen;
      if (menuOpen || chatOpen || statusPickerOpen) {
        event.preventDefault();
        closeAllPopups();

        // Only re-render the room widget when that UI is active.
        // On onboarding screens, forcing renderWidget() can drop into
        // a disconnected dark "Crickets..." state.
        if (app.querySelector(".main-widget")) {
          renderWidget();
        }
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
let zoomNoticeTimer = null;

function showZoomLevelNotice(zoom) {
  const normalizedZoom = Number.isFinite(zoom)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    : 1;
  const zoomPercent = Math.round(normalizedZoom * 100);

  let notice = document.querySelector(".zoom-level-notice");
  if (!(notice instanceof HTMLDivElement)) {
    notice = document.createElement("div");
    notice.className = "zoom-level-notice";
    notice.setAttribute("aria-live", "polite");
    notice.setAttribute("aria-atomic", "true");
    document.body.append(notice);
  }

  notice.textContent = `${zoomPercent}%`;
  notice.classList.add("is-visible");

  if (zoomNoticeTimer) {
    clearTimeout(zoomNoticeTimer);
  }

  zoomNoticeTimer = setTimeout(() => {
    notice?.classList.remove("is-visible");
  }, ZOOM_NOTICE_DURATION_MS);
}

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
    const normalizedZoom = Number.isFinite(zoom)
      ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
      : 1;

    // Keep the scaled surface within viewport width by shrinking
    // the pre-transform box inversely to the zoom factor.
    const inverseScale = 1 / normalizedZoom;
    app.style.width = `${inverseScale * 100}%`;
    app.style.height = `${inverseScale * 100}%`;
    app.style.transform = `scale(${zoom})`;
    app.style.transformOrigin = "top left";
  }

  document.body.style.overflowX = "hidden";
  if (zoom > 1) {
    document.body.style.overflowY = "auto";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
  } else {
    document.body.style.overflowY = "hidden";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
  }
}

function stepZoom(direction) {
  const normalizedDirection = direction >= 0 ? 1 : -1;
  const previousZoom = state.zoomLevel;

  if (normalizedDirection > 0) {
    state.zoomLevel = Math.min(MAX_ZOOM, state.zoomLevel + ZOOM_STEP);
  } else {
    state.zoomLevel = Math.max(MIN_ZOOM, state.zoomLevel - ZOOM_STEP);
  }

  if (state.zoomLevel === previousZoom) return false;

  applyZoomLevel(state.zoomLevel);
  saveZoomLevel(state.zoomLevel);
  showZoomLevelNotice(state.zoomLevel);
  return true;
}

function bindZoomMenuControls() {
  app
    .querySelector('[data-action="zoom-in"]')
    ?.addEventListener("click", () => {
      stepZoom(1);
    });

  app
    .querySelector('[data-action="zoom-out"]')
    ?.addEventListener("click", () => {
      stepZoom(-1);
    });
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
          stepZoom(1);
        } else if (event.code === "Minus" || event.key === "-") {
          stepZoom(-1);
        }
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

  const currentNameInput = app.querySelector("#display-name-input");
  if (state.menuOpen && currentNameInput) {
    state.displayNameDraft = currentNameInput.value;
  }
  const shouldRefocusNameInput =
    state.menuOpen && document.activeElement === currentNameInput;
  const currentNameSelectionStart = currentNameInput?.selectionStart ?? null;
  const currentNameSelectionEnd = currentNameInput?.selectionEnd ?? null;
  const menuNameValue =
    state.menuOpen && typeof state.displayNameDraft === "string"
      ? state.displayNameDraft
      : defaultDisplayName();

  const shouldRefocusChatInput =
    state.chatOpen && document.activeElement?.matches(".chat-form input");

  const currentStatusEmojiInput = app.querySelector("#status-emoji-input");
  if (state.menuOpen && currentStatusEmojiInput) {
    state.statusEmojiDraft = currentStatusEmojiInput.value;
  }
  const menuStatusEmojiValue =
    state.menuOpen && typeof state.statusEmojiDraft === "string"
      ? state.statusEmojiDraft
      : state.statusEmoji;

  const aggregate = aggregatePeerPresence();
  const peerItems = activePeerIds()
    .sort((a, b) => peerDisplayName(a).localeCompare(peerDisplayName(b)))
    .map((peerId) => {
      const peer = state.peers.get(peerId);
      const presence = peer?.presence ?? "present";
      const caption = peer?.displayName || peerShortId(peerId);
      const characterColor = chatNameColor(peerId);
      const hasAvatar = isPngAvatarDataUrl(peer?.avatar);
      const status = statusBadgeMarkup(
        peer?.statusEmoji,
        peer?.statusText,
        "status-thinking-bubble",
      );
      const chirpText = normalizePeerChirpText(peer?.chirpText);
      const chirpMarkup = chirpText
        ? `<p class="peer-chirp" title="${escapeAttribute(chirpText)}">${escapeHtml(chirpText)}</p>`
        : "";

      const isTyping = state.typingPeers.has(peerId);
      const characterContent = hasAvatar
        ? avatarMarkup(peer.avatar, caption, "peer-avatar")
        : `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="32"/><circle class="eye" cx="34" cy="42" r="4"/><circle class="eye" cx="56" cy="42" r="4"/><path d="M31 57 Q45 65 59 57"/></svg>`;

      return `<div class="peer-card ${presence}"><div class="peer-caption"><span class="status-dot"></span><span class="peer-caption-text">${escapeHtml(caption)}</span></div><div class="character ${presence} ${hasAvatar ? "has-avatar" : ""}" style="--character-color:${characterColor}">${chirpMarkup}${characterContent}${status}${isTyping ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : ""}</div></div>`;
    })
    .join("");

  if (state.connected) document.body.classList.add("joined-transparent");
  const peerCount = connectedParticipantCount();
  const exitButtonText = state.connected ? "←" : "×";
  const exitButtonLabel = state.connected ? "Leave room" : "Exit";
  const chatButtonLabel = "Chat";
  const menuButtonLabel = "Menu";
  const minimizeButtonLabel = "Minimize";

  app.innerHTML = `<section class="widget main-widget ${aggregate}"><header class="drag-bar"><div class="drag-region" data-tauri-drag-region><span class="drag-dots" aria-hidden="true">⠿</span></div><button class="icon-button chat-bubble ${state.unreadChatCount ? "has-unread" : ""}" data-action="chat" aria-label="${chatButtonLabel}" title="${chatButtonLabel}"><svg class="chat-icon" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M437.333 32H74.667C33.493 32 0 65.493 0 106.667V320c0 41.173 33.493 74.667 74.667 74.667h25.387L65.11 464.555c-2.091 4.203-1.195 9.301 2.219 12.523C69.355 478.997 72 480 74.667 480c1.813 0 3.627-.448 5.291-1.408l146.88-83.925h210.496C478.507 394.667 512 361.173 512 320V106.667C512 65.493 478.507 32 437.333 32zM490.645 319.979c0 29.397-23.936 53.333-53.333 53.333H223.979c-1.856 0-3.669.491-5.291 1.408L99.947 442.581l26.923-53.824c1.664-3.285 1.472-7.232-.469-10.368s-5.376-5.056-9.067-5.056H74.667c-29.397 0-53.333-23.936-53.333-53.333V106.667c0-29.397 23.936-53.333 53.333-53.333v-.021h362.645c29.397 0 53.333 23.936 53.333 53.333V319.979z"/></svg>${state.unreadChatCount ? `<span class="chat-badge">${state.unreadChatCount}</span>` : ""}</button><button class="icon-button" data-action="menu" aria-label="${menuButtonLabel}" title="${menuButtonLabel}">${moreMenuIconSvg()}</button><button class="icon-button" data-action="minimize" aria-label="${minimizeButtonLabel}" title="${minimizeButtonLabel}">−</button><button class="icon-button" data-action="exit" aria-label="${exitButtonLabel}" title="${exitButtonLabel}">${exitButtonText}</button></header><div class="presence-body"><div class="peer-strip">${peerItems || '<p class="peer-empty"><span class="peer-empty-badge">Crickets...</span></p>'}</div></div><aside class="menu-popover" ${state.menuOpen ? "" : "hidden"}><div class="menu-header"><span class="menu-version" data-app-version>${escapeHtml(menuVersionLabel())}</span><button type="button" class="icon-button menu-close" data-action="cancel-name" aria-label="Close menu">×</button></div>${roomInfoMenuMarkup(peerCount)}${nameMenuMarkup(menuNameValue)}${statusMenuMarkup(menuStatusEmojiValue)}${menuDividerMarkup()}${zoomMenuMarkup()}</aside><aside class="chat-popover" ${state.chatOpen ? "" : "hidden"}><div class="chat-header"><span>Chat</span><button class="icon-button" data-action="close-chat">×</button></div><div class="message-log"></div><form class="chat-form"><input aria-label="Message" maxlength="2000" placeholder="Say something…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button aria-label="Send" type="submit">↑</button></form></aside>${statusPickerLayerMarkup()}<button class="resize-grip" data-action="resize" aria-label="Resize window"></button></section>`;
  applyMenuVersionLabel();
  mountAvatarEditor({
    container: app.querySelector(".menu-popover"),
    avatarName: state.displayName || "you",
    beforeSelector: ".name-form",
  });
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
  bindStatusMenu();
  bindAvatarControls(app);
  bindZoomMenuControls();

  if (state.chatOpen) {
    renderMessages();
    setupChatInputTypingListener();
  }
  if (shouldRefocusNameInput) {
    const nameInput = app.querySelector("#display-name-input");
    if (nameInput) {
      nameInput.focus();
      if (
        Number.isInteger(currentNameSelectionStart) &&
        Number.isInteger(currentNameSelectionEnd)
      ) {
        nameInput.setSelectionRange(
          currentNameSelectionStart,
          currentNameSelectionEnd,
        );
      }
    }
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
  state.peerColorIndexes.clear();
  clearStatusForNewRoomSession();
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
  state.peerColorIndexes.clear();
  state.inviteCode = "";
  state.creatingRoom = false;
  state.messages = [];
  state.chatDraft = "";
  clearStatusForNewRoomSession();
  renderOnboarding("choose");
}

async function exitApp() {
  try {
    clearIdleTimer();
    stopPresenceHeartbeat();
    stopPresenceWatchdog();
    stopSystemIdlePolling();
  } catch {
    // Ignore shutdown-time signaling failures.
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
  clearStatusForNewRoomSession();
  await sendLocalProfile().catch(() => {});
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

  clearStatusForNewRoomSession();
  await sendLocalProfile().catch(() => {});
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
    sendLocalProfile().catch(showError);
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
  const openingChat = !state.chatOpen;
  if (openingChat) {
    state.menuOpen = false;
  }

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
  sendLocalProfile().catch(showError);

  state.presenceHeartbeatTimer = setInterval(() => {
    sendCurrentPresence();
    sendLocalProfile().catch(showError);
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

function centerWindowOnLaunch() {
  const resolveCurrentMonitor = async () => {
    if (typeof appWindow.currentMonitor === "function") {
      return appWindow.currentMonitor();
    }

    if (typeof tauri?.window?.currentMonitor === "function") {
      return tauri.window.currentMonitor();
    }

    return null;
  };

  resolveCurrentMonitor()
    .then(async (monitor) => {
      await appWindow.show().catch(() => {});
      await appWindow.unminimize().catch(() => {});
      await appWindow.setFocus().catch(() => {});

      if (!monitor) {
        await appWindow.center().catch(() => {});
        return;
      }

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

      // Any successful peer-status connect signal means we are in-room.
      setConnection(true);
    } else {
      peer.presence = "idle";
      peer.lastSeenAt = Date.now();
      peer.idleSinceAt = Date.now();
      peer.chirpText = "";
      state.connectedPeers.delete(event.peer);
      if (event.peer !== state.selfPeerId) {
        pushPeerNotice("left", event.peer);
      }

      // Only leave room mode when the local peer disconnects.
      if (event.peer === state.selfPeerId) {
        setConnection(false);
      }
    }

    if (app.querySelector(".main-widget")) renderWidget();
    renderMessages();
  } else if (event.type === "presence") {
    if (typeof event.peer !== "string") return;
    if (event.state !== "present" && event.state !== "idle") return;
    const peer = ensurePeer(event.peer);
    peer.presence = event.state;
    peer.lastSeenAt = Date.now();
    peer.idleSinceAt =
      event.state === "idle" ? (peer.idleSinceAt ?? Date.now()) : null;
    if (event.peer !== state.selfPeerId) state.connectedPeers.add(event.peer);

    // Presence events are sent only while connected to a room.
    setConnection(true);

    if (app.querySelector(".main-widget")) renderWidget();
  } else if (event.type === "chat") {
    if (typeof event.peer === "string") {
      const peer = ensurePeer(event.peer);
      peer.lastSeenAt = Date.now();
      event.displayName = peer.displayName || "";
      peer.chirpText = normalizePeerChirpText(event.text);
      const chirpToken = Date.now() + Math.random();
      peer.chirpToken = chirpToken;
      setTimeout(() => {
        const currentPeer = state.peers.get(event.peer);
        if (!currentPeer) return;
        if (currentPeer.chirpToken !== chirpToken) return;

        currentPeer.chirpText = "";
        if (app.querySelector(".main-widget")) renderWidget();
      }, PEER_CHIRP_VISIBLE_MS);
      state.typingPeers.delete(event.peer);
    }

    pushUnreadChatEntry(event, true);
    if (app.querySelector(".main-widget")) renderWidget();
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
    if (event.peer !== state.selfPeerId) state.connectedPeers.add(event.peer);
    peer.displayName = normalizeDisplayName(event.displayName ?? "");
    peer.avatar = isPngAvatarDataUrl(event.avatar) ? event.avatar : "";
    peer.statusEmoji = normalizeStatusEmoji(event.statusEmoji ?? "");
    peer.statusText = normalizeStatusText(event.statusText ?? "");
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
    state.displayNameDraft = defaultDisplayName();
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
state.displayNameDraft = defaultDisplayName();
state.avatar = readAvatar();

// Status is session-scoped; clear any persisted value from previous runs.
saveStatus("", "");
state.statusEmoji = readStatusEmoji();
state.statusText = readStatusText();
state.statusEmojiDraft = state.statusEmoji;
state.statusTextDraft = state.statusText;
renderOnboarding();
document.body.style.background = "transparent";
void loadAppVersion();
centerWindowOnLaunch();
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
