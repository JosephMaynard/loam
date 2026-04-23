import { useMemo } from "preact/hooks";

import { generateAvatar } from "../lib/avatar";
import type { AvatarMode } from "../lib/avatar";
import type { UserAvatar } from "@loam/schema";

export interface AvatarProps {
  id: string;
  avatar?: UserAvatar;
  className?: string;
  mode?: AvatarMode;
  label?: string;
}

function avatarImagePath(avatar: UserAvatar): string | undefined {
  if (avatar.kind !== "image" || !avatar.imageId || !avatar.mimeType) {
    return undefined;
  }

  const extension = avatar.mimeType === "image/png" ? "png" : avatar.mimeType === "image/jpeg" ? "jpg" : "webp";
  return `/api/avatars/${encodeURIComponent(`${avatar.imageId}.${extension}`)}`;
}

export function Avatar({ id, avatar: userAvatar, className, mode = "face", label }: AvatarProps) {
  const imagePath = userAvatar ? avatarImagePath(userAvatar) : undefined;
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
      <img alt="" src={imagePath} />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className={wrapperClassName}
      dangerouslySetInnerHTML={{ __html: avatar.html }}
    />
  );
}
