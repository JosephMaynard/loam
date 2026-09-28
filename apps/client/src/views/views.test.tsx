import type { NetworkConfig, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MeshView } from "./MeshView";
import { PeopleView } from "./PeopleView";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

// Smoke tests for the screens extracted from app.tsx: each renders with minimal props into the shared
// ScreenHeader + .screen-body + .screen-column layout, and the destructive actions confirm first.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
  mounted.push(container);
  return container;
}

/** Let effects run, the stubbed fetch resolve, and Preact re-render. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function button(host: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent === text);
}

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const admin: User = { ...me, id: "user.admin", displayName: "Ada", isAdmin: true };
const troll: User = { ...me, id: "user.troll", displayName: "Troll" };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/moderation/users")) {
        return new Response(JSON.stringify([admin, troll]), { status: 200 });
      }
      if (url.includes("/api/moderation/reports") || url.includes("/api/access/pending") || url.includes("/api/mesh/contacts")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      // Never answers: the mesh card stays "loading" (a shape this smoke test doesn't need).
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("SearchView", () => {
  it("renders a search field in the screen column", () => {
    const host = mount(
      <SearchView blockedUserIds={new Set()} channels={[]} currentUser={me} usersById={new Map()} />,
    );

    expect(host.querySelector(".screen-header h1")?.textContent).toBe("Find messages");
    expect(host.querySelector(".screen-column form.search-form input[type=search]")).not.toBeNull();
  });
});

describe("MeshView", () => {
  it("renders its three cards", () => {
    const host = mount(<MeshView />);

    expect(host.querySelector(".screen-header h1")?.textContent).toBe("Mesh mail");
    expect(host.querySelectorAll(".screen-column > .card")).toHaveLength(3);
  });
});

describe("SettingsView", () => {
  const networkConfig = {
    allowUserDisplayNameEdit: true,
    allowUserAvatarEdit: true,
    allowUserAvatarUpload: false,
    allowAdminClaim: false,
    securityProfile: "hardened",
  } as unknown as NetworkConfig;

  function mountSettings(onWipeDevice = vi.fn(async () => {})) {
    return mount(
      <SettingsView
        blockedUserIds={new Set()}
        config={{ joinUrl: "http://10.0.0.1:3000/", version: "9.9.9", networkConfig }}
        currentUser={me}
        onClaimAdmin={async () => {}}
        onSetBlocked={async () => {}}
        onUpdateCurrentUser={async () => {}}
        onUploadAvatarImage={async () => {}}
        onWipeDevice={onWipeDevice}
        usersById={new Map()}
      />,
    );
  }

  it("renders the identity, join and admin cards with an xl avatar and the avatar-style choices", () => {
    const host = mountSettings();

    expect(host.querySelector(".screen-header h1")?.textContent).toBe("Settings");
    expect(host.querySelector(".identity-card .avatar-xl")).not.toBeNull();
    expect(host.querySelectorAll(".choice-tile input[type=radio]")).toHaveLength(3);
    expect(host.querySelector(".join-card .join-url")?.textContent).toBe("http://10.0.0.1:3000/");
    expect(host.querySelector(".node-version")?.textContent).toBe("LOAM v9.9.9");
  });

  it("wipes the device only after the alertdialog's typed confirmation", async () => {
    const onWipeDevice = vi.fn(async () => {});
    const host = mountSettings(onWipeDevice);

    button(host.querySelector(".card-danger")!, "Wipe this device")!.click();
    await flush();
    const dialog = host.querySelector('[role="alertdialog"]')!;
    const confirm = button(dialog, "Wipe this device")!;
    expect(confirm.disabled).toBe(true);

    const field = dialog.querySelector("input") as HTMLInputElement;
    field.value = "wipe";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    confirm.click();
    await flush();
    expect(onWipeDevice).toHaveBeenCalledTimes(1);
  });
});

describe("PeopleView", () => {
  it("tells a plain member the area isn't for them", () => {
    const host = mount(<PeopleView currentUser={me} onUsersChanged={() => {}} />);

    expect(host.querySelector(".screen-header h1")?.textContent).toBe("Not authorized");
    expect(host.querySelector(".card")).toBeNull();
  });

  it("lists the roster for an admin and confirms a ban before sending it", async () => {
    const host = mount(<PeopleView currentUser={admin} onUsersChanged={() => {}} />);
    await flush();

    const rows = Array.from(host.querySelectorAll(".person-row"));
    expect(rows).toHaveLength(2);
    const trollRow = rows.find((row) => row.textContent?.includes("Troll"))!;
    expect(trollRow.querySelector(".avatar-md")).not.toBeNull();

    button(trollRow, "Ban")!.click();
    await flush();
    const dialog = host.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Ban Troll?");
    button(dialog, "Cancel")!.click();
    await flush();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });
});
