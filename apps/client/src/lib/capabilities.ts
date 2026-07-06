import type { User } from "@loam/schema";

/**
 * Whether a user may ban / shadow-ban / unban other (non-admin) members. Admins implicitly can;
 * otherwise the "moderator" role grants it. Mirrors the server's `canModerate`.
 *
 * @param user - The user whose capability is being checked.
 * @returns True when the user is an admin or holds the moderator role.
 */
export function canModerate(user: User): boolean {
  return !user.banned && !user.pending && (user.isAdmin || (user.roles?.includes("moderator") ?? false));
}

/**
 * Whether a user may approve / deny pending joins and see the in-client invite QR. Admins implicitly
 * can; otherwise the "greeter" role grants it. Mirrors the server's `canGreet`.
 *
 * @param user - The user whose capability is being checked.
 * @returns True when the user is an admin or holds the greeter role.
 */
export function canGreet(user: User): boolean {
  return !user.banned && !user.pending && (user.isAdmin || (user.roles?.includes("greeter") ?? false));
}

/**
 * Whether a user may assign roles to others. Only admins can. Mirrors the server rule that role
 * changes are admin-only.
 *
 * @param user - The user whose capability is being checked.
 * @returns True when the user is an admin.
 */
export function canManageRoles(user: User): boolean {
  return user.isAdmin;
}

/**
 * Whether a target user is protected from moderation / role changes: admins and the actor
 * themselves. The server returns 403 for these; the client hides the controls.
 *
 * @param target - The user the controls would act on.
 * @param actor - The signed-in user attempting the action.
 * @returns True when the controls must be hidden (target is an admin or is the actor).
 */
export function isProtectedTarget(target: User, actor: User): boolean {
  return target.isAdmin || target.id === actor.id;
}
