import { afterEach, describe, expect, it } from "vitest";

import { tabbableElements, trapFocus } from "./focus-trap";

const mounted: HTMLElement[] = [];

/** A dialog panel holding the given markup, attached to the document so focus() works. */
function dialogWith(markup: string): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;
  dialog.innerHTML = markup;
  document.body.appendChild(dialog);
  mounted.push(dialog);
  return dialog;
}

function tab(dialog: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
  trapFocus(dialog, event);
  return event;
}

afterEach(() => {
  for (const element of mounted) {
    element.remove();
  }
  mounted.length = 0;
});

describe("trapFocus", () => {
  it("skips hidden controls: the hidden attribute and display:none or visibility:hidden ancestors", () => {
    const dialog = dialogWith(`
      <button id="first">First</button>
      <button id="hidden-attr" hidden>Hidden</button>
      <div style="display: none"><button id="in-display-none">Collapsed</button></div>
      <div style="visibility: hidden"><a id="in-invisible" href="#">Invisible</a></div>
      <button id="disabled" disabled>Off</button>
      <button id="last">Last</button>
    `);

    expect(tabbableElements(dialog).map((element) => element.id)).toEqual(["first", "last"]);

    // Tab from the last visible control wraps to the first visible one, never onto a hidden one.
    dialog.querySelector<HTMLButtonElement>("#last")!.focus();
    const forward = tab(dialog);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("first");

    // Shift+Tab from the first wraps to the last visible one.
    const backward = tab(dialog, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("last");
  });

  it("lets Tab move normally between two visible controls", () => {
    const dialog = dialogWith(`<button id="a">A</button><button id="b">B</button>`);
    dialog.querySelector<HTMLButtonElement>("#a")!.focus();
    const event = tab(dialog);
    expect(event.defaultPrevented).toBe(false);
  });

  it("swallows Tab when nothing visible can take focus", () => {
    const dialog = dialogWith(`<div hidden><button>Ghost</button></div>`);
    dialog.focus();
    const event = tab(dialog);
    expect(event.defaultPrevented).toBe(true);
  });
});
