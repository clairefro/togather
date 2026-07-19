import process from "bare-process";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import Hyperswarm from "hyperswarm";

const PRESENCE_STATES = new Set(["present", "idle", "away"]);
const MAX_CHAT_LENGTH = 2_000;
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";
const ADJECTIVES = [
  "ancient",
  "brave",
  "calm",
  "daring",
  "eager",
  "fuzzy",
  "gentle",
  "happy",
  "icy",
  "jolly",
  "kind",
  "lucky",
  "mellow",
  "nimble",
  "odd",
  "playful",
  "quick",
  "radiant",
  "silent",
  "tidy",
  "urban",
  "vivid",
  "warm",
  "young",
  "zesty",
  "amber",
  "bright",
  "clever",
  "distant",
  "earthy",
  "fancy",
  "glossy",
  "hollow",
  "indigo",
  "jumpy",
  "knitted",
  "lunar",
  "misty",
  "navy",
  "opal",
  "peppy",
  "quiet",
  "rusty",
  "sunny",
  "teal",
  "upbeat",
  "velvet",
  "witty",
  "yearly",
  "zippy",
  "agile",
  "blissful",
  "cozy",
  "dusty",
  "elastic",
  "feisty",
  "golden",
  "honest",
  "ivory",
  "jaunty",
  "kinder",
  "leafy",
  "marble",
  "noble",
  "oaken",
  "plucky",
  "quaint",
  "royal",
  "spry",
  "tender",
  "ultra",
  "verdant",
  "whimsy",
  "xenial",
  "yuletide",
  "azure",
  "breezy",
  "crisp",
  "dewy",
  "embered",
  "frisky",
  "gritty",
  "hearty",
  "inked",
  "jazzy",
  "keen",
  "limber",
  "mirthful",
  "neat",
  "open",
  "perky",
  "quicker",
  "rosy",
  "snug",
  "trim",
  "uplifted",
  "vintage",
  "windy",
  "yummy",
  "zen",
];
const NOUNS = [
  "anchor",
  "beacon",
  "cabin",
  "drift",
  "ember",
  "forest",
  "garden",
  "harbor",
  "island",
  "jungle",
  "kitten",
  "lantern",
  "meadow",
  "needle",
  "ocean",
  "pocket",
  "quartz",
  "river",
  "sunset",
  "tunnel",
  "utopia",
  "valley",
  "window",
  "yonder",
  "zephyr",
  "asteroid",
  "bridge",
  "comet",
  "dolphin",
  "engine",
  "feather",
  "galaxy",
  "horizon",
  "inkwell",
  "jacket",
  "keystone",
  "labyrinth",
  "moonbeam",
  "notebook",
  "orchard",
  "planet",
  "quiver",
  "rainbow",
  "skylight",
  "thunder",
  "uniform",
  "voyager",
  "wildflower",
  "yardstick",
  "zeppelin",
  "acorn",
  "breeze",
  "canyon",
  "daybreak",
  "evergreen",
  "firefly",
  "glacier",
  "hammock",
  "iceberg",
  "jigsaw",
  "kettle",
  "lighthouse",
  "mariner",
  "nebula",
  "outpost",
  "pavilion",
  "quarry",
  "raindrop",
  "seashell",
  "trellis",
  "uplink",
  "violet",
  "waterfall",
  "xylophone",
  "yarn",
  "zipline",
  "apricot",
  "boardwalk",
  "campfire",
  "domino",
  "echo",
  "fountain",
  "gadget",
  "headland",
  "icicle",
  "junction",
  "keyhole",
  "locket",
  "monsoon",
  "northstar",
  "oasis",
  "postcard",
  "quasar",
  "runway",
  "sandbar",
  "teacup",
  "uplands",
  "vineyard",
  "waypoint",
  "yacht",
];
const swarm = new Hyperswarm();
const peers = new Map();

let discovery = null;
let inputBuffer = "";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message) {
  emit({ type: "error", message });
}

function peerId(publicKey) {
  return b4a.toString(publicKey, "hex");
}

function randomWord(words) {
  const bytes = crypto.randomBytes(4);
  const random =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return words[random % words.length];
}

function randomAlphanumeric(length) {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    const byte = crypto.randomBytes(1)[0];
    value += ALPHANUMERIC[byte % ALPHANUMERIC.length];
  }

  return value;
}

function createRoomCode() {
  return `${randomWord(ADJECTIVES)}-${randomWord(NOUNS)}-${randomAlphanumeric(5)}`;
}

function parseRoomCode(code) {
  if (typeof code !== "string") {
    throw new Error("Room code must be a string.");
  }

  const normalized = code.trim();
  if (!normalized) {
    throw new Error("Room code cannot be empty.");
  }

  return normalized;
}

function sendToPeers(message) {
  const payload = `${JSON.stringify(message)}\n`;

  for (const socket of peers.values()) {
    if (!socket.destroyed) socket.write(payload);
  }
}

function receivePeerMessage(line) {
  let message;

  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message?.type === "presence" && PRESENCE_STATES.has(message.state)) {
    emit({ type: "presence", state: message.state });
  } else if (
    message?.type === "chat" &&
    typeof message.text === "string" &&
    typeof message.ts === "number"
  ) {
    emit({
      type: "chat",
      text: message.text.slice(0, MAX_CHAT_LENGTH),
      ts: message.ts,
      from: "peer",
    });
  }
}

function attachPeer(socket, info) {
  const id = peerId(info.publicKey);
  let messageBuffer = "";

  peers.set(id, socket);
  emit({ type: "peer-status", connected: true, peer: id });

  socket.on("data", (chunk) => {
    messageBuffer += b4a.toString(chunk);
    const lines = messageBuffer.split("\n");
    messageBuffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) receivePeerMessage(line);
    }
  });

  const disconnect = () => {
    if (peers.get(id) !== socket) return;

    peers.delete(id);
    emit({ type: "peer-status", connected: false, peer: id });
    emit({ type: "presence", state: "away" });
  };

  socket.once("close", disconnect);
  socket.once("error", disconnect);
}

async function leavePairing() {
  if (discovery) {
    await discovery.destroy().catch(() => {});
    discovery = null;
  }

  for (const socket of peers.values()) {
    socket.destroy();
  }

  peers.clear();
}

async function joinTopic(topic) {
  await leavePairing();
  discovery = swarm.join(topic, { client: true, server: true });
  await discovery.flushed();
  emit({ type: "topic-joined" });
}

async function handleCommand(command) {
  switch (command?.type) {
    case "create-pairing": {
      const roomCode = createRoomCode();
      await joinTopic(crypto.hash(b4a.from(roomCode)));
      emit({ type: "invite", code: roomCode });
      return;
    }

    case "join-pairing": {
      const roomCode = parseRoomCode(command.code);
      emit({ type: "joined" });
      await joinTopic(crypto.hash(b4a.from(roomCode)));
      return;
    }

    case "send-chat": {
      if (typeof command.text !== "string")
        throw new Error("Chat text must be a string.");

      const text = command.text.trim().slice(0, MAX_CHAT_LENGTH);
      if (text) sendToPeers({ type: "chat", text, ts: Date.now() });
      return;
    }

    case "send-presence": {
      if (!PRESENCE_STATES.has(command.state)) {
        throw new Error("Presence state must be present, idle, or away.");
      }

      sendToPeers({ type: "presence", state: command.state });
      return;
    }

    case "leave":
      await leavePairing();
      return;

    default:
      throw new Error("Unknown command.");
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      handleCommand(JSON.parse(line)).catch((error) => fail(error.message));
    } catch {
      fail("Commands must be newline-delimited JSON objects.");
    }
  }
});

process.stdin.on("end", () => {
  leavePairing()
    .then(() => swarm.destroy())
    .finally(() => process.exit(0));
});

swarm.on("connection", attachPeer);
swarm.on("error", (error) => fail(`Network error: ${error.message}`));

emit({ type: "ready", publicKey: peerId(swarm.keyPair.publicKey) });
