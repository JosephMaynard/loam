import avatarTemplate from "../../../../apps/client/src/assets/avatars.svg?raw";
import { generateDisplayName } from "./display-name";

import {
  generateAvatar as generatePackageAvatar,
  getAvatarColors as getPackageAvatarColors,
  getAvatarCounts as getPackageAvatarCounts,
  hashString,
  initAvatarTemplate,
} from "@loam/avatar";
import type { AvatarColors, AvatarFeatureCounts, AvatarMode, AvatarResult } from "@loam/avatar";

initAvatarTemplate(avatarTemplate);

export type { AvatarColors, AvatarFeatureCounts, AvatarMode, AvatarResult };
export { hashString };

export function generateAvatar(
  id: string,
  options?: { mode?: AvatarMode; label?: string },
): AvatarResult {
  const label = options?.label ?? (options?.mode === "initial" ? generateDisplayName(id) : undefined);
  return generatePackageAvatar(id, { ...options, label });
}

export function getAvatarColors(id: string): AvatarColors {
  return getPackageAvatarColors(id);
}

export function getAvatarCounts(): AvatarFeatureCounts {
  return getPackageAvatarCounts();
}
