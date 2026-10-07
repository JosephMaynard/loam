/**
 * The LOAM app's privacy policy, served by the node itself at `/privacy` (views/PrivacyView.tsx), so
 * reading it never needs the internet or another website. It is the app section of the public policy
 * (apps/site/privacy.html, which Google Play links to): keep the two in step. Plain structured text,
 * rendered as elements (never as HTML); `**bold**` and `` `code` `` are the only inline markup.
 */

export type PolicyBlock = { kind: "p"; text: string } | { kind: "list"; items: string[] };
export type PolicySection = { heading: string; blocks: PolicyBlock[] };

export const PRIVACY_POLICY_UPDATED = "7 October 2026";

/** Where people report problems: LOAM has no telemetry, so these are the only way we hear of one. */
export const ISSUE_TRACKER = "github.com/MagicZebraLtd/loam/issues";
export const CONTACT_EMAIL = "opensource@magiczebra.co.uk";

export const PRIVACY_POLICY: PolicySection[] = [
  {
    heading: "Who holds your data",
    blocks: [
      {
        kind: "p",
        text:
          "LOAM has no central server and no cloud service. Whoever starts a LOAM network (the host) runs it on " +
          "their own phone, laptop or Raspberry Pi. Everything posted on that network is stored on the host's " +
          "device. Magic Zebra Ltd, which publishes LOAM, never receives it, cannot see it, and has no copy of " +
          "it. The host decides how their network is set up, so on a given network the host controls the data " +
          "described below.",
      },
    ],
  },
  {
    heading: "No accounts, analytics or tracking",
    blocks: [
      {
        kind: "p",
        text:
          "LOAM has no sign-up, and it never asks for an email address, phone number or real name. It contains " +
          "no analytics, advertising, crash reporting or third-party tracking code.",
      },
      {
        kind: "p",
        text:
          "That also means LOAM never tells us when something goes wrong. If you find a problem, please let us " +
          `know: open an issue at \`${ISSUE_TRACKER}\`, or email Magic Zebra Ltd at \`${CONTACT_EMAIL}\`.`,
      },
    ],
  },
  {
    heading: "Checking for updates",
    blocks: [
      {
        kind: "p",
        text:
          "The Android app from Google Play asks the Play Store app on the phone whether a newer LOAM exists, " +
          "when LOAM opens. The Android app from GitHub checks only when you tap **Check for updates**: it asks " +
          "GitHub for LOAM's latest version number, and GitHub sees your phone's internet address. Neither " +
          "check sends anything from your LOAM network, and neither downloads or installs anything by itself.",
      },
    ],
  },
  {
    heading: "What the host device stores",
    blocks: [
      {
        kind: "list",
        items: [
          "**Your identity on that network:** a random user id (such as `user.1a2b3c4d…`), the name generated " +
            "from it or one you choose, and your avatar settings or a picture you upload. A session cookie links " +
            "your browser to that id.",
          "**What you post:** channel messages, replies, direct messages, reactions, and any pictures or files " +
            "you attach. A location appears only if you add it to a message yourself.",
          "**That you agreed to the network rules**, and which version of them.",
          "**Moderation records:** reports you make, and actions the host or moderators take (bans, timeouts, " +
            "removed messages, join approvals). When you report a message, the network's moderators can read " +
            "that message and see its pictures and files, even in a direct message, while your report is open.",
          "**Your block list:** the people you have blocked. Only you see it; it isn't shared with them, with " +
            "moderators, or with other networks.",
          "**Network settings** chosen by the host.",
        ],
      },
      {
        kind: "p",
        text:
          "Your own device keeps a copy of the conversations you have open so LOAM keeps working when the " +
          "connection drops. That copy is deleted when the network is reset.",
      },
    ],
  },
  {
    heading: "How long it is kept, and how it is deleted",
    blocks: [
      {
        kind: "list",
        items: [
          "By default, data stays on the host device until someone deletes it. You can delete your own " +
            "messages. The host can make messages disappear automatically after a set time.",
          "The host can run an **Emergency reset**, which deletes every message, person, picture and file on " +
            "the network and clears the copies on devices connected at the time. A device that was offline " +
            "clears its copy the next time it connects to that network.",
          "The host can store the network encrypted. With encryption on, a reset also replaces the key, so the " +
            "deleted data can't be recovered from the device's storage. Pictures and files are stored beside the " +
            "encrypted database, and a reset deletes them.",
          "Uninstalling the Android host app deletes everything it stored.",
        ],
      },
    ],
  },
  {
    heading: "When data leaves the host device",
    blocks: [
      {
        kind: "p",
        text:
          "Normally nothing leaves the host device except the messages delivered to the people on that network, " +
          "over the local Wi-Fi or hotspot. When you join by scanning the host's code, LOAM encrypts the " +
          "messages between your device and the host, and the pictures and files you upload. Downloading " +
          "pictures and files is encrypted too when the host requires encrypted connections; otherwise they are " +
          "downloaded unencrypted over the local network. Data leaves the host device only if the host turns on " +
          "one of these:",
      },
      {
        kind: "list",
        items: [
          "**Linking with other LOAM networks:** public channels (their names and descriptions), the messages, " +
            "replies and reactions in them, their pictures and files, and their authors' ids, names and avatar " +
            "settings are copied to the linked networks. Direct messages and private channels never are.",
          "**A remote assistant:** if the host connects the assistant to a model on another computer, messages " +
            "you send the assistant go to that computer. The on-device assistant runs entirely on the host phone.",
          "**Mesh delivery** (experimental): messages to your mesh contacts may be carried by other LOAM " +
            "networks, sealed so only the recipient can read them.",
        ],
      },
      {
        kind: "p",
        text:
          "When the host downloads an on-device assistant model, the host phone fetches it from Hugging Face or " +
          "from a web address the host enters. That request is between the host phone and that site and contains " +
          "no LOAM user data.",
      },
    ],
  },
  {
    heading: "Android permissions",
    blocks: [
      {
        kind: "list",
        items: [
          "**Nearby Wi-Fi devices and location:** Android requires these to start a hotspot. LOAM never reads " +
            "or records your location.",
          "**Camera:** only to scan another network's link code when this phone joins it. No pictures are kept.",
          "**Notifications:** to show that the phone is hosting a network.",
          "**Foreground service and wake lock:** to keep the network running while the screen is off.",
          "**Bluetooth and Wi-Fi Aware** (mesh, experimental): to find nearby LOAM devices to exchange sealed " +
            "messages with.",
        ],
      },
    ],
  },
  {
    heading: "Children",
    blocks: [
      {
        kind: "p",
        text:
          "LOAM is for adults: everyone confirms they are 18 or over before they post. Its rules prohibit any sexual " +
          "content involving anyone under 18, and LOAM collects no information that would identify a child.",
      },
    ],
  },
  {
    heading: "Questions and changes",
    blocks: [
      {
        kind: "p",
        text:
          "Questions about data on this network go to its host, who holds it. Questions about this policy go to " +
          "Magic Zebra Ltd through the LOAM project's issue tracker (`github.com/MagicZebraLtd/loam`) or by email " +
          `(\`${CONTACT_EMAIL}\`). Changes ` +
          "are published with a new date.",
      },
    ],
  },
];

export type InlinePart = { text: string; style?: "strong" | "code" };

/** Split a policy string into plain, `**strong**` and `` `code` `` runs. Pure. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index) });
    }
    parts.push(match[1] !== undefined ? { text: match[1], style: "strong" } : { text: match[2]!, style: "code" });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last) });
  }
  return parts;
}
