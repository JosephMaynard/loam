import { useMemo } from "preact/hooks";

import { generateAvatar } from "../lib/avatar";
import type { AvatarMode } from "../lib/avatar";
import { useEncryptedImage } from "../lib/use-encrypted-image";
import type { UserAvatar } from "@loam/schema";

export interface AvatarProps {
  id: string;
  avatar?: UserAvatar;
  className?: string;
  mode?: AvatarMode;
  label?: string;
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
 * @returns A Preact element representing the avatar
 */
export function Avatar({ id, avatar: userAvatar, className, mode = "face", label }: AvatarProps) {
  const imagePath = userAvatar ? avatarImagePath(userAvatar) : undefined;
  const imageSrc = useEncryptedImage(imagePath);
  const avatarSeed = userAvatar?.seed ?? id;
  const avatarMode = userAvatar?.mode ?? mode;
  const avatar = useMemo(
    () => generateAvatar(avatarSeed, { mode: avatarMode, label }),
    [avatarMode, avatarSeed, label],
  );
  const wrapperClassName = ["avatar", className]
    .filter(Boolean)
    .join(" ");

  return imagePath ? (
    <span aria-hidden="true" className={wrapperClassName}>
      <img alt="" src={imageSrc} />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className={wrapperClassName}
      dangerouslySetInnerHTML={{ __html: avatar.html }}
    />
  );
}
