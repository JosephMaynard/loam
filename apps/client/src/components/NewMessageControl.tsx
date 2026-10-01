import type { User } from "@loam/schema";
import { useMemo, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialog";
import { IconPlus } from "./icons";
import { NavLink } from "./NavLink";

/**
 * "New message": the sidebar lists only existing conversations, so starting one goes through this picker —
 * everyone on the node (bar yourself), filtered by name as you type, online people first. Choosing someone
 * opens the DM and closes the picker.
 */
export function NewMessageControl({
  onlineUserIds,
  people,
}: {
  onlineUserIds: ReadonlySet<string>;
  /** Everyone this user could message (the current user already removed). */
  people: User[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return people
      .filter((user) => !needle || user.displayName.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(onlineUserIds.has(b.id)) - Number(onlineUserIds.has(a.id)) ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [filter, onlineUserIds, people]);

  function close(): void {
    setOpen(false);
    setFilter("");
  }

  return (
    <>
      <button className="nav-link new-message-toggle" onClick={() => setOpen(true)} ref={triggerRef} type="button">
        <span aria-hidden="true" className="nav-glyph">
          <IconPlus size={18} />
        </span>
        <span className="nav-label">{t("newMessage.open")}</span>
      </button>
      {open ? (
        <Dialog className="new-message-dialog" onClose={close} returnFocusTo={triggerRef} title={t("newMessage.title")}>
          <input
            aria-label={t("newMessage.filter")}
            className="input"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            dir="auto"
            onInput={(event) => setFilter(event.currentTarget.value)}
            placeholder={t("newMessage.filter")}
            type="search"
            value={filter}
          />
          {/* Any pick routes to the DM (NavLink), so close the picker on the way. */}
          <nav aria-label={t("newMessage.title")} className="new-message-list" onClickCapture={close}>
            {matches.map((user) => (
              <NavLink active={false} href={`/dm/${encodeURIComponent(user.id)}`} key={user.id}>
                <Avatar
                  avatar={user.avatar}
                  id={user.id}
                  presence={onlineUserIds.has(user.id) ? "online" : undefined}
                  size="sm"
                />
                <span className="nav-label">{user.displayName}</span>
              </NavLink>
            ))}
          </nav>
          {!matches.length ? (
            <p className="form-note">{people.length ? t("newMessage.noMatch") : t("newMessage.nobody")}</p>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
