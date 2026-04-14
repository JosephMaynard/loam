import { useMemo } from "preact/hooks";

import { generateAvatar } from "../lib/avatar";
import type { AvatarMode } from "../lib/avatar";

export interface AvatarProps {
  id: string;
  className?: string;
  mode?: AvatarMode;
  label?: string;
}

export function Avatar({ id, className, mode = "face", label }: AvatarProps) {
  const avatar = useMemo(() => generateAvatar(id, { mode, label }), [id, label, mode]);
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
