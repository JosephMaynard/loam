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
  const wrapperClassName = [
    "inline-grid aspect-square shrink-0 overflow-hidden rounded-[28%] ring-1 ring-black/8 [&>svg]:block [&>svg]:size-full",
    className,
  ]
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
