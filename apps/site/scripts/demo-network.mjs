// Starts a real LOAM node filled with a believable afternoon at a small festival, for the website's
// screenshots (scripts/screenshots.mjs). Everything goes through the public API, as real clients would;
// afterwards the timestamps are spread over the afternoon (straight in the demo database, which only this
// script ever uses) so the screenshots don't show forty messages sent in the same second.
//
//   node apps/site/scripts/demo-network.mjs            # seeds, then serves on http://127.0.0.1:4310
//
// Needs `pnpm build` first (the server's dist/ and the client's dist/). Prints the session cookies the
// screenshot script uses, as JSON on the last line, and keeps serving until killed.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const PORT = Number(process.env.DEMO_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHOTO = process.env.DEMO_PHOTO; // optional JPEG (< 256 KB) for the photo post

const dataDir = mkdtempSync(join(tmpdir(), "loam-demo-"));
writeFileSync(
  join(dataDir, "config.json"),
  JSON.stringify({
    node: { name: "Valley Gathering", locale: "en" },
    security: { profile: "standard" },
    identity: { allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    features: { enablePresence: true },
  }),
);

let server;
function startServer() {
  server = spawn(process.execPath, [join(repo, "apps/server/dist/server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLIENT_PORT: String(PORT),
      HOST: "127.0.0.1",
      LOAM_DATA_DIR: dataDir,
      LOAM_CLIENT_DIST: join(repo, "apps/client/dist"),
      LOAM_JOIN_HOST: "192.168.4.1",
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return waitForServer();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The demo server did not start");
}

function stopServer() {
  return new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill("SIGINT");
  });
}

/** One person: their own session cookie, like a separate phone. */
async function person(displayName, avatar) {
  const response = await fetch(`${BASE}/api/config`);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { currentUser } = await response.json();
  const me = { cookie, id: currentUser.id };
  const update = { ...(displayName ? { displayName } : {}), ...(avatar ? { avatar } : {}) };
  if (Object.keys(update).length) {
    await api(me, "PATCH", "/api/users/me", update);
  }
  return me;
}

async function api(who, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: who.cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Minutes before "now" for each message, applied after seeding (see retime()).
const timeline = new Map();
async function post(who, channelId, body, minutesAgo, extra = {}) {
  const { message } = await api(who, "POST", "/api/messages", { type: "channelPost", channelId, body, ...extra });
  timeline.set(message.id, minutesAgo);
  return message;
}
async function reply(who, parent, body, minutesAgo) {
  const { message } = await api(who, "POST", "/api/messages", {
    type: "channelReply",
    channelId: parent.channelId,
    parentMessageId: parent.id,
    body,
  });
  timeline.set(message.id, minutesAgo);
  return message;
}
async function dm(who, to, body, minutesAgo) {
  const { message } = await api(who, "POST", "/api/messages", { type: "dm", recipientUserId: to.id, body });
  timeline.set(message.id, minutesAgo);
  return message;
}
async function react(who, target, reaction, minutesAgo) {
  const { message } = await api(who, "POST", "/api/messages", { type: "reaction", targetMessageId: target.id, reaction });
  timeline.set(message.id, minutesAgo);
}

async function seed() {
  // The first session on a fresh node is its admin: the info tent.
  // Avatar seeds picked for friendly faces (the expression follows the seed).
  const jo = await person("Jo · Info tent", { kind: "generated", mode: "face", seed: "face-60" });
  const maya = await person("Maya", { kind: "generated", mode: "face", seed: "face-58" });
  const tom = await person("Tom · First aid", { kind: "generated", mode: "face", seed: "face-56" });
  const priya = await person("Priya", { kind: "generated", mode: "face", seed: "face-29" });
  const kofi = await person("Kofi", { kind: "generated", mode: "face", seed: "face-13" });
  const lena = await person("Lena", { kind: "generated", mode: "face", seed: "face-15" });
  const sam = await person("Sam", { kind: "generated", mode: "face", seed: "face-9" });
  const owl = await person(undefined, { kind: "generated", mode: "face", seed: "face-53" }); // keeps the generated name
  const wren = await person(undefined, { kind: "generated", mode: "face", seed: "face-93" });

  for (const channel of [
    { name: "Lost and found", description: "Lost something? Found something? Post it here." },
    { name: "Rides home", description: "Offer or ask for a lift after the last set." },
    { name: "Volunteers", description: "Shifts, swaps and who needs a hand." },
  ]) {
    await api(jo, "POST", "/api/channels", channel);
  }
  await api(jo, "PATCH", "/api/channels/general", { description: "Everything happening around the valley this weekend." });
  await api(jo, "PATCH", "/api/channels/announcements", { description: "News from the info tent." });
  const channels = await api(jo, "GET", "/api/channels");
  const id = (name) => channels.find((channel) => channel.name === name).id;

  // Announcements
  const welcome = await post(
    jo,
    "announcements",
    "**Welcome to Valley Gathering!** 🌿 There's no phone signal in the valley, so this is how we reach each other this weekend. Info tent is by the main gate.",
    190,
  );
  await react(maya, welcome, "❤️", 185);
  await react(kofi, welcome, "❤️", 180);
  await react(lena, welcome, "🙌", 170);
  const water = await post(jo, "announcements", "Water refill points are open at the main gate and behind the Oak stage. Please bring your own bottle 💧", 95);
  await react(priya, water, "👍", 90);
  await post(jo, "announcements", "**Change of plan:** the 6pm workshop moves from the Willow tent to the Meadow tent (rain on the way ☔).", 18);

  // General
  await post(kofi, "general", "Anyone else at the Oak stage? The sound check is incredible", 64);
  await post(owl, "general", "Food trucks by the bridge are open now 🌮", 58);
  const meet = await post(priya, "general", "We're setting up a picnic on the hill above the Meadow tent, everyone welcome 🧺", 41);
  await react(maya, meet, "🙌", 40);
  await react(sam, meet, "🙌", 39);
  await react(lena, meet, "❤️", 38);
  await reply(lena, meet, "Coming over after the workshop!", 37);
  await reply(sam, meet, "I'll bring the frisbee", 35);
  await reply(maya, meet, "Save us a spot, there are four of us", 33);
  if (PHOTO) {
    const data = readFileSync(PHOTO).toString("base64");
    const attachment = await api(lena, "POST", "/api/attachments", { mimeType: "image/jpeg", data, width: 1100, height: 760 });
    const photo = await post(lena, "general", "Someone drew a map of every info point in the valley 😍", 26, { attachments: [{ id: attachment.id, mimeType: "image/jpeg", width: 1100, height: 760 }] });
    await react(kofi, photo, "😍", 25);
    await react(priya, photo, "😍", 24);
    await react(maya, photo, "❤️", 22);
  }
  await post(wren, "general", "Is the shuttle to the car park still running?", 12);
  await post(jo, "general", "Yes! Every 20 minutes from the main gate until midnight.", 11);
  await post(maya, "general", "Rain's coming in from the west, grab a jacket before the evening sets 🌧️", 4);

  // Lost and found
  const keys = await post(sam, id("Lost and found"), "Found a set of keys with a little green fox keyring near the Meadow tent. Leaving them at the info tent 🦊🔑", 73);
  await reply(owl, keys, "That's mine!! Thank you so much 🙏", 70);
  await react(jo, keys, "🙌", 69);
  await post(priya, id("Lost and found"), "Lost a blue water bottle with stickers on it, somewhere between the bridge and the Oak stage", 29);

  // Rides home
  await post(kofi, id("Rides home"), "Driving back to the city around 11pm, two seats free. Can drop off on the way.", 55);
  await post(lena, id("Rides home"), "Anyone heading north on Sunday morning?", 21);

  // Volunteers
  await post(jo, id("Volunteers"), "Could two people cover the info tent from 4 to 6? Tea and cake provided ☕🍰", 120);
  await post(tom, id("Volunteers"), "First aid is fully staffed until 8pm. Find us by the blue flag 🩹", 100);

  // Direct messages: Maya's inbox.
  await dm(priya, maya, "Are you coming to the picnic?", 48);
  await dm(maya, priya, "Yes! Bringing snacks 🍓", 46);
  await dm(priya, maya, "Perfect, we're by the big oak tree", 45);
  await dm(tom, maya, "Your friend's ankle is strapped up, she's resting at the first aid tent. Nothing broken 👍", 15);
  await dm(maya, tom, "Thank you so much, on my way over now", 14);
  await dm(kofi, maya, "Still need a lift tonight?", 8);

  return { jo, maya, priya, tom };
}

/** Spread the seeded messages over the afternoon, by the minutes-ago each was given, ending at 5:42 pm
 *  today (a festival afternoon, whatever time the screenshots are taken). */
function retime() {
  const db = new DatabaseSync(join(dataDir, "loam.db"));
  const end = new Date();
  end.setHours(17, 42, 0, 0);
  const now = end.getTime();
  const select = db.prepare("SELECT data FROM messages WHERE id = ?");
  const update = db.prepare("UPDATE messages SET created_at = ?, data = ? WHERE id = ?");
  for (const [messageId, minutesAgo] of timeline) {
    const row = select.get(messageId);
    if (!row) {
      continue;
    }
    const createdAt = now - minutesAgo * 60_000 - Math.floor(Math.random() * 40_000);
    update.run(createdAt, JSON.stringify({ ...JSON.parse(row.data), createdAt }), messageId);
  }
  db.close();
}

await startServer();
const people = await seed();
await stopServer();
retime();
await startServer();
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGINT"));
const bootstrap = await (await fetch(`${BASE}/api/bootstrap`)).json();
console.log(
  JSON.stringify({
    base: BASE,
    dataDir,
    transportKey: bootstrap.networkConfig.transportPublicKey,
    cookies: Object.fromEntries(Object.entries(people).map(([name, who]) => [name, who.cookie])),
  }),
);
