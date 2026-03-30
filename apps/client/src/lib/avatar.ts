import avatarTemplate from "../assets/avatars.svg?raw";

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
  return generatePackageAvatar(id, options);
}

export function getAvatarColors(id: string): AvatarColors {
  return getPackageAvatarColors(id);
}

export function getAvatarCounts(): AvatarFeatureCounts {
  return getPackageAvatarCounts();
}
