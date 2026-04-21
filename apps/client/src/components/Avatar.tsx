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

export function Avatar({ id, avatar: userAvatar, className, mode = "face", label }: AvatarProps) {
  const avatarSeed = userAvatar?.seed ?? id;
  const avatarMode = userAvatar?.mode ?? mode;
  const avatar = useMemo(
    () => generateAvatar(avatarSeed, { mode: avatarMode, label }),
    [avatarMode, avatarSeed, label],
  );
  const wrapperClassName = ["avatar", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      aria-hidden="true"
      className={wrapperClassName}
      dangerouslySetInnerHTML={{ __html: avatar.html }}
    />
  );
}
