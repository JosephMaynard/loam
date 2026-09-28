// The foreground host service must be (re)started whenever the app is foregrounded — a one-shot start on
// `ready` is refused on API 31+ if the operator switched away during the ~80 s cold start (pre-release
// review 2026-09-25) — and POST_NOTIFICATIONS is asked once, before the first start, never blocking it.
import { describe, expect, it, vi } from "vitest";

import { createHostServiceController, type HostServiceDeps } from "./host-service-controller";

function deps(overrides: Partial<HostServiceDeps> = {}) {
  let active = true;
  const base = {
    apiLevel: 34,
    isAppActive: () => active,
    requestNotificationPermission: vi.fn(async () => "granted" as const),
    startService: vi.fn(() => true),
    ...overrides,
  };
  return { deps: base, setActive: (value: boolean) => (active = value) };
}

describe("createHostServiceController", () => {
  it("asks for notifications once, before the first start, and starts on every ensure (idempotent)", async () => {
    const order: string[] = [];
    const { deps: d } = deps({
      requestNotificationPermission: vi.fn(async () => {
        order.push("prompt");
        return "granted" as const;
      }),
      startService: vi.fn(() => {
        order.push("start");
        return true;
      }),
    });
    const controller = createHostServiceController(d);
    await expect(controller.ensure()).resolves.toBe(true);
    await expect(controller.ensure()).resolves.toBe(true);
    expect(order).toEqual(["prompt", "start", "start"]);
    expect(controller.notificationPermission()).toBe("granted");
  });

  it("a denied notification permission still starts the service", async () => {
    const { deps: d } = deps({ requestNotificationPermission: vi.fn(async () => "denied" as const) });
    const controller = createHostServiceController(d);
    await expect(controller.ensure()).resolves.toBe(true);
    expect(d.startService).toHaveBeenCalledTimes(1);
    expect(controller.notificationPermission()).toBe("denied");
  });

  it("a rejecting prompt counts as unavailable and still starts", async () => {
    const { deps: d } = deps({ requestNotificationPermission: vi.fn(async () => Promise.reject(new Error("no activity"))) });
    const controller = createHostServiceController(d);
    await expect(controller.ensure()).resolves.toBe(true);
    expect(controller.notificationPermission()).toBe("unavailable");
  });

  it("while backgrounded on API 31+: no prompt, no start; the next foreground ensure does both", async () => {
    const { deps: d, setActive } = deps();
    setActive(false);
    const controller = createHostServiceController(d);
    await expect(controller.ensure()).resolves.toBe(false);
    expect(d.requestNotificationPermission).not.toHaveBeenCalled();
    expect(d.startService).not.toHaveBeenCalled();

    setActive(true);
    await expect(controller.ensure()).resolves.toBe(true);
    expect(d.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(d.startService).toHaveBeenCalledTimes(1);
  });

  it("below API 31 a background start is still attempted; below API 33 there is no prompt", async () => {
    const { deps: d, setActive } = deps({ apiLevel: 30 });
    setActive(false);
    const controller = createHostServiceController(d);
    await expect(controller.ensure()).resolves.toBe(true);
    setActive(true);
    await controller.ensure();
    expect(d.requestNotificationPermission).not.toHaveBeenCalled();
    expect(d.startService).toHaveBeenCalledTimes(2);
  });

  it("prompt:false skips the prompt but still starts; a platform refusal or throw resolves false", async () => {
    const { deps: d } = deps();
    const controller = createHostServiceController(d);
    await expect(controller.ensure({ prompt: false })).resolves.toBe(true);
    expect(d.requestNotificationPermission).not.toHaveBeenCalled();

    d.startService.mockImplementationOnce(() => false);
    await expect(controller.ensure()).resolves.toBe(false);
    d.startService.mockImplementationOnce(() => {
      throw new Error("ForegroundServiceStartNotAllowedException");
    });
    await expect(controller.ensure()).resolves.toBe(false);
  });

  it("concurrent ensures share a single prompt", async () => {
    let release: (value: "granted") => void = () => undefined;
    const { deps: d } = deps({
      requestNotificationPermission: vi.fn(() => new Promise<"granted">((resolve) => (release = resolve))),
    });
    const controller = createHostServiceController(d);
    const both = Promise.all([controller.ensure(), controller.ensure()]);
    release("granted");
    await both;
    expect(d.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(d.startService).toHaveBeenCalledTimes(2);
  });
});
