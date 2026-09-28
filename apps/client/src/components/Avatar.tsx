import { useMemo } from "preact/hooks";

import { t } from "../i18n";
import { generateAvatar } from "../lib/avatar";
import type { AvatarMode } from "../lib/avatar";
import { useEncryptedImage } from "../lib/use-encrypted-image";
import type { UserAvatar } from "@loam/schema";

/** Avatar sizes: xs 20 · sm 28 · md 36 · lg 44 · xl 96 px (see DESIGN.md). */
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface AvatarProps {
  id: string;
  avatar?: UserAvatar;
  className?: string;
  mode?: AvatarMode;
  label?: string;
  /**
   * One of the design-system sizes (adds `avatar-<size>`). Omit it only where a legacy stylesheet still
   * sizes `.avatar` from its container.
   */
  size?: AvatarSize;
  /** `"online"` adds the green presence dot at the bottom inline-end corner. */
  presence?: "online";
}

/**
 * Compute a server URL path for a UserAvatar that is stored as an image.
 *
 * @param avatar - The UserAvatar to inspect; must have `kind === "image"` and contain both `imageId` and `mimeType` to produce a path.
 * @returns The `/api/avatars/<encoded>` path for the avatar's image (`.png`, `.jpg`, or `.webp` based on `mimeType`), or `undefined` if the avatar is not an image or lacks required fields.
 */
function avatarImagePath(avatar: UserAvatar): string | undefined {
  if (avatar.kind !== "image" || !avatar.imageId || !avatar.mimeType) {
    return undefined;
  }

  const extension = avatar.mimeType === "image/png" ? "png" : avatar.mimeType === "image/jpeg" ? "jpg" : "webp";
  return `/api/avatars/${encodeURIComponent(`${avatar.imageId}.${extension}`)}`;
}

/**
 * Render a user avatar as either an image (when the provided avatar is an image) or generated avatar HTML.
 *
 * @param id - Identifier used as the fallback seed for generated avatars when `avatar` does not provide a seed
 * @param avatar - Optional user avatar metadata; may supply an image to render or seed/mode for generated avatars
 * @param className - Optional additional CSS class(es) applied to the avatar wrapper
 * @param mode - Default avatar mode to use when `avatar` does not specify one
 * @param label - Optional label forwarded to avatar generation (e.g., for display or accessibility)
 * @param size - Design-system size (`xs` 20 · `sm` 28 · `md` 36 · `lg` 44 · `xl` 96 px)
 * @param presence - `"online"` adds the presence dot
 * @returns A Preact element representing the avatar
 */
export function Avatar({ id, avatar: userAvatar, className, mode = "face", label, presence, size }: AvatarProps) {
  const imagePath = userAvatar ? avatarImagePath(userAvatar) : undefined;
  const imageSrc = useEncryptedImage(imagePath);
  const avatarSeed = userAvatar?.seed ?? id;
  const avatarMode = userAvatar?.mode ?? mode;
  const avatar = useMemo(
    () => generateAvatar(avatarSeed, { mode: avatarMode, label }),
    [avatarMode, avatarSeed, label],
  );
  const wrapperClassName = ["avatar", size ? `avatar-${size}` : undefined, className].filter(Boolean).join(" ");

  const face = imagePath ? (
    <span aria-hidden="true" className={wrapperClassName}>
      <img alt="" src={imageSrc} />
    </span>
  ) : (
    <span aria-hidden="true" className={wrapperClassName} dangerouslySetInnerHTML={{ __html: avatar.html }} />
  );

  if (presence !== "online") {
    return face;
  }

  // The avatar clips its art to the rounded square (`overflow: hidden`), so the dot sits on an unclipped
  // wrapper instead. It is the one part with meaning for assistive tech, hence `role="img"` + a label.
  return (
    <span className={size ? `presence-anchor presence-${size}` : "presence-anchor"}>
      {face}
      <span aria-label={t("sidebar.online")} className="presence-dot" role="img" title={t("sidebar.online")} />
    </span>
  );
}
