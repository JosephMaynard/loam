/**
 * Dialogs drawn over a screen: a yes/no question, a text or password field, a list to pick from, and a
 * read-only panel (help, a QR to scan). One is open at a time and takes every key until it closes.
 */
import { type Line, padEnd, text, textWidth, truncate } from "./ansi.js";
import { isChar, type Key } from "./keys.js";

/** A single-line text field with a cursor. */
export type TextField = { value: string; cursor: number; secret?: boolean; maxLength?: number };

export function textField(value = "", options: { secret?: boolean; maxLength?: number } = {}): TextField {
  return { value, cursor: [...value].length, ...options };
}

/** Edit `field` with `key`. Returns "submit" on Enter, "cancel" on Escape, otherwise undefined. */
export function editField(field: TextField, key: Key): "submit" | "cancel" | undefined {
  const chars = [...field.value];
  switch (key.name) {
    case "enter":
      return "submit";
    case "escape":
      return "cancel";
    case "left":
      field.cursor = Math.max(0, field.cursor - 1);
      return undefined;
    case "right":
      field.cursor = Math.min(chars.length, field.cursor + 1);
      return undefined;
    case "home":
      field.cursor = 0;
      return undefined;
    case "end":
      field.cursor = chars.length;
      return undefined;
    case "backspace":
      if (field.cursor > 0) {
        chars.splice(field.cursor - 1, 1);
        field.cursor -= 1;
        field.value = chars.join("");
      }
      return undefined;
    case "delete":
      if (field.cursor < chars.length) {
        chars.splice(field.cursor, 1);
        field.value = chars.join("");
      }
      return undefined;
    case "char": {
      const added = [...(key.char ?? "")];
      if (field.maxLength !== undefined && chars.length + added.length > field.maxLength) {
        return undefined;
      }
      chars.splice(field.cursor, 0, ...added);
      field.cursor += added.length;
      field.value = chars.join("");
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The field as a line `width` columns wide, the cursor shown as an inverted cell. */
export function fieldLine(field: TextField, width: number): Line {
  const chars = [...field.value].map((char) => (field.secret ? "•" : char));
  // Scroll so the cursor stays in view.
  let start = 0;
  while (textWidth(chars.slice(start, field.cursor).join("")) > width - 2) {
    start += 1;
  }
  const before = chars.slice(start, field.cursor).join("");
  const under = chars[field.cursor] ?? " ";
  const after = truncate(chars.slice(field.cursor + 1).join(""), Math.max(0, width - textWidth(before) - 1));
  return [
    { text: before },
    { text: under, style: { inverse: true } },
    { text: after },
  ];
}

export type ConfirmModal = {
  kind: "confirm";
  title: string;
  body: string[];
  yes: string;
  danger?: boolean;
  onYes(): void;
};

export type InputModal = {
  kind: "input";
  title: string;
  body: string[];
  field: TextField;
  error?: string;
  /** Return an error to show and keep the dialog open, or nothing to close it. */
  onSubmit(value: string): string | undefined | Promise<string | undefined>;
  onCancel?(): void;
};

export type ChoiceModal = {
  kind: "choice";
  title: string;
  body: string[];
  options: { label: string; detail?: string }[];
  selected: number;
  onPick(index: number): void;
};

export type PanelModal = {
  kind: "panel";
  title: string;
  /** The content, or a function that lays it out for the room there is (a QR only when it fits whole). */
  lines: Line[] | ((width: number, height: number) => Line[]);
  /** Shown at the bottom; Escape or Enter closes the panel. */
  footer?: string;
};

export type Modal = ConfirmModal | InputModal | ChoiceModal | PanelModal;

/** Handle a key for `modal`. Returns true when the modal should close. */
export async function modalKey(modal: Modal, key: Key): Promise<boolean> {
  switch (modal.kind) {
    case "confirm":
      if (isChar(key, "y") || (key.name === "enter" && !modal.danger)) {
        modal.onYes();
        return true;
      }
      return isChar(key, "n") || key.name === "escape" || key.name === "enter";
    case "panel":
      return key.name === "escape" || key.name === "enter" || isChar(key, "q");
    case "choice":
      if (key.name === "up") {
        modal.selected = Math.max(0, modal.selected - 1);
      } else if (key.name === "down") {
        modal.selected = Math.min(modal.options.length - 1, modal.selected + 1);
      } else if (key.name === "enter") {
        modal.onPick(modal.selected);
        return true;
      } else if (key.name === "escape") {
        return true;
      }
      return false;
    case "input": {
      const action = editField(modal.field, key);
      if (action === "cancel") {
        modal.onCancel?.();
        return true;
      }
      if (action === "submit") {
        const error = await modal.onSubmit(modal.field.value);
        if (error) {
          modal.error = error;
          return false;
        }
        return true;
      }
      modal.error = undefined;
      return false;
    }
  }
}

/** The modal's lines, `width` columns wide and `height` rows tall at most (borders not counted). */
export function modalLines(modal: Modal, width: number, height: number): Line[] {
  const inner = Math.max(10, width - 4);
  const lines: Line[] = [text(modal.title, { bold: true }), []];
  const body = modal.kind === "panel" ? [] : modal.body;
  body.forEach((paragraph, index) => {
    if (index > 0) {
      lines.push([]);
    }
    lines.push(...wrap(paragraph, inner).map((line) => text(line)));
  });
  if (body.length) {
    lines.push([]);
  }

  switch (modal.kind) {
    case "confirm":
      lines.push([
        { text: modal.danger ? `y ${modal.yes}` : `Enter/y ${modal.yes}`, style: { bold: true, fg: modal.danger ? "red" : "green" } },
        { text: "   n cancel", style: { dim: true } },
      ]);
      break;
    case "input":
      lines.push([{ text: "› ", style: { dim: true } }, ...fieldLine(modal.field, inner - 2)]);
      lines.push(modal.error ? text(modal.error, { fg: "red" }) : []);
      lines.push(text("Enter to confirm · Esc to cancel", { dim: true }));
      break;
    case "choice":
      modal.options.forEach((option, index) => {
        const chosen = index === modal.selected;
        lines.push([
          { text: chosen ? "› " : "  ", style: { fg: "cyan" } },
          { text: padEnd(option.label, Math.min(inner - 2, 28)), style: chosen ? { inverse: true } : undefined },
          { text: option.detail ? `  ${option.detail}` : "", style: { dim: true } },
        ]);
      });
      lines.push([]);
      lines.push(text("↑↓ choose · Enter to pick · Esc to cancel", { dim: true }));
      break;
    case "panel":
      lines.push(...(typeof modal.lines === "function" ? modal.lines(inner, Math.max(0, height - 4)) : modal.lines));
      lines.push([]);
      lines.push(text(modal.footer ?? "Esc to close", { dim: true }));
      break;
  }
  return lines;
}

/** A link split into `width`-column pieces: never cut short, since a shortened link doesn't work. */
export function breakLink(value: string, width: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of value) {
    if (textWidth(current + char) > width) {
      pieces.push(current);
      current = "";
    }
    current += char;
  }
  return current ? [...pieces, current] : pieces;
}

/** Word-wrap `value` to `width` columns. */
export function wrap(value: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of value.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate) <= width) {
        current = candidate;
      } else {
        if (current) {
          out.push(current);
        }
        current = textWidth(word) > width ? truncate(word, width) : word;
      }
    }
    out.push(current);
  }
  return out;
}
