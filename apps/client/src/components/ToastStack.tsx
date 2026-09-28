import { useLocation } from "preact-iso";

import { t } from "../i18n";

/** One new-message toast: a live message that arrived in a conversation the user isn't looking at. */
export type ToastItem = {
  id: string;
  title: string;
  body: string;
  /** The conversation's route; toasts for the same conversation coalesce into one. */
  route: string;
  /** The conversation's name as a toast shows it ("#general", or the DM partner's name). */
  place?: string;
  /** Who wrote the message (a coalesced channel toast prefixes the newest body with it). */
  author?: string;
};

/** At most this many conversations show a toast at once; older ones wait in state and expire unseen. */
const MAX_VISIBLE_TOASTS = 2;

/** The toasts for one conversation, newest last. */
type ToastGroup = { route: string; items: ToastItem[] };

/**
 * Group toasts by conversation, keeping first-arrival order, and return the newest `MAX_VISIBLE_TOASTS`
 * groups. Each item keeps its own auto-dismiss timer in the app, so a group lives until its newest message
 * expires.
 */
export function groupToasts(toasts: ToastItem[]): ToastGroup[] {
  const groups = new Map<string, ToastGroup>();

  for (const toast of toasts) {
    const group = groups.get(toast.route);
    if (group) {
      group.items.push(toast);
      // Re-insert so the conversation with the newest message sorts last (nearest the edge it slides from).
      groups.delete(toast.route);
      groups.set(toast.route, group);
    } else {
      groups.set(toast.route, { route: toast.route, items: [toast] });
    }
  }

  return Array.from(groups.values()).slice(-MAX_VISIBLE_TOASTS);
}

/**
 * Fixed-position stack of auto-dismissing toasts announcing new messages in non-active conversations.
 * Several messages in one conversation coalesce into a single toast ("3 new messages in #general" over the
 * newest message), and at most two conversations show at once, so a busy channel can't bury the screen.
 * Tapping a toast opens the conversation and dismisses all of its messages.
 */
export function ToastStack({ onDismiss, toasts }: { onDismiss: (id: string) => void; toasts: ToastItem[] }) {
  const location = useLocation();

  if (!toasts.length) {
    return null;
  }

  return (
    <div aria-live="polite" className="toast-stack" role="status">
      {groupToasts(toasts).map((group) => {
        const newest = group.items[group.items.length - 1]!;
        const count = group.items.length;
        return (
          <button
            className="toast"
            key={group.route}
            onClick={() => {
              location.route(group.route);
              for (const item of group.items) {
                onDismiss(item.id);
              }
            }}
            type="button"
          >
            <strong className="toast-title">
              {count > 1 ? t("toast.newMessages", { n: count, place: newest.place ?? newest.title }) : newest.title}
            </strong>
            <span className="toast-body" dir="auto">
              {count > 1 && newest.author && newest.author !== newest.place
                ? `${newest.author}: ${newest.body}`
                : newest.body}
            </span>
          </button>
        );
      })}
    </div>
  );
}
