import type { User } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import { Avatar } from "./Avatar";
import { CardHeader } from "./ScreenParts";

interface BlockedUsersPanelProps {
  blockedUserIds: ReadonlySet<string>;
  onSetBlocked: (userId: string, blocked: boolean) => Promise<void>;
  usersById: Map<string, User>;
}

/**
 * Settings section listing the people this user has blocked (docs/30 B3), each with an Unblock button.
 * The list comes from the server (the caller keeps it in memory); a blocked id that has since left the
 * roster still shows, under its generated name, so it can always be unblocked.
 */
export function BlockedUsersPanel({ blockedUserIds, onSetBlocked, usersById }: BlockedUsersPanelProps) {
  const [busyId, setBusyId] = useState<string>();

  async function unblock(userId: string): Promise<void> {
    setBusyId(userId);
    try {
      await onSetBlocked(userId, false);
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section aria-labelledby="blocked-users-title" className="card blocked-users-panel">
      <CardHeader description={t("settings.blockedNote")} title={t("settings.blockedTitle")} titleId="blocked-users-title" />
      {blockedUserIds.size ? (
        <ul className="list blocked-users-list">
          {[...blockedUserIds].map((userId) => {
            const user = usersById.get(userId);
            return (
              <li className="list-row" key={userId}>
                <Avatar avatar={user?.avatar} id={userId} size="md" />
                <span className="blocked-users-name" dir="auto">
                  {user?.displayName ?? generateDisplayName(userId)}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={busyId !== undefined}
                  onClick={() => void unblock(userId)}
                  type="button"
                >
                  {t("block.unblock")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-note">{t("settings.blockedEmpty")}</p>
      )}
    </section>
  );
}
