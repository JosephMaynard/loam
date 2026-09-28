import type { User } from "@loam/schema";

/** The roster order the UI shows (by display name). */
export function sortUsers(users: Iterable<User>): User[] {
  return Array.from(users).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * Apply the server's FULL user list (`GET /api/users` returns every user this caller may see) to the
 * cached roster. Additive merging alone kept users the server no longer returns — banned, pending, or
 * gone after a node reset — in memory and IndexedDB forever (pre-release review 2026-09-25). A cached user
 * missing from the list is dropped only if it was already held when the request started (`preFetchIds`):
 * one who arrived by a live `userUpserted` while the request was in flight isn't a removal.
 *
 * @returns the reconciled roster and the ids removed from it.
 */
export function reconcileRoster(
  previous: User[],
  serverUsers: User[],
  preFetchIds: ReadonlySet<string>,
): { users: User[]; removedIds: string[] } {
  const next = new Map<string, User>();
  const serverIds = new Set(serverUsers.map((user) => user.id));
  const removedIds: string[] = [];

  for (const user of previous) {
    if (serverIds.has(user.id) || !preFetchIds.has(user.id)) {
      next.set(user.id, user);
    } else {
      removedIds.push(user.id);
    }
  }

  for (const user of serverUsers) {
    next.set(user.id, user);
  }

  return { users: sortUsers(next.values()), removedIds };
}
