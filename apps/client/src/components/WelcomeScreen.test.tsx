import type { User } from "@loam/schema";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { parseRoute, parseSocketEvent } from "../lib/protocol";
import { WelcomeScreen } from "./WelcomeScreen";

const mounted: HTMLDivElement[] = [];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

const newcomer: User = {
  id: "user.0123456789abcdef",
  displayName: "brave.copper.otter",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: false,
};

function mount(user: User, onAgree = vi.fn(async () => undefined), onReroll = vi.fn(async () => undefined)) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  render(<WelcomeScreen currentUser={user} nodeName="Valley Gathering" onAgree={onAgree} onReroll={onReroll} />, container);
  const buttons = [...container.querySelectorAll("button")];
  return { container, onAgree, onReroll, buttons };
}

describe("WelcomeScreen", () => {
  it("greets the person by network, shows their name, and links the full rules", () => {
    const { container } = mount(newcomer);
    expect(container.querySelector("h1")?.textContent).toContain("Valley Gathering");
    expect(container.querySelector(".welcome-name")?.textContent).toBe("brave.copper.otter");
    expect(container.querySelector('a[href="/rules"]')).not.toBeNull();
  });

  it("agrees with one tap, confirming they're 18 or over", async () => {
    const { buttons, onAgree } = mount(newcomer);
    const agree = buttons.find((button) => button.classList.contains("welcome-agree"))!;
    expect(agree.textContent).toContain("18");
    agree.click();
    await tick();
    expect(onAgree).toHaveBeenCalledTimes(1);
  });

  it("offers another name before the first agreement only", async () => {
    const first = mount(newcomer);
    const reroll = first.buttons.find((button) => !button.classList.contains("welcome-agree"))!;
    reroll.click();
    await tick();
    expect(first.onReroll).toHaveBeenCalledTimes(1);

    // Someone agreeing to a newer version of the rules keeps their name.
    const returning = mount({ ...newcomer, rulesVersion: 1 });
    expect(returning.buttons).toHaveLength(1);
  });

  it("quietly drops \"Try another\" when the node says this person keeps their name", async () => {
    const { container, buttons } = mount(
      newcomer,
      undefined,
      vi.fn(async () => {
        throw new ApiError(403, { code: "reroll_not_allowed", error: "no" }, "no");
      }),
    );
    buttons.find((button) => !button.classList.contains("welcome-agree"))!.click();
    await tick();
    await tick();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says so when agreeing fails, and leaves the button usable", async () => {
    const { container, buttons } = mount(
      newcomer,
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const agree = buttons.find((button) => button.classList.contains("welcome-agree"))!;
    agree.click();
    await tick();
    await tick();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(agree.disabled).toBe(false);
  });
});

describe("rules route and queue nudge", () => {
  it("parses /rules and the moderator-only reportsChanged event", () => {
    expect(parseRoute("/rules")).toEqual({ screen: "rules" });
    expect(parseSocketEvent(JSON.stringify({ type: "reportsChanged" }))).toEqual({ type: "reportsChanged" });
  });
});
