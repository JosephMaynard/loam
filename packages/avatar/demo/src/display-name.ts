import {
  generateDisplayName as generatePackageDisplayName,
  getDisplayNameParts as getPackageDisplayNameParts,
} from "@loam/display-name";
import type { DisplayNameParts } from "@loam/display-name";

export type { DisplayNameParts };

export function generateDisplayName(id: string): string {
  return generatePackageDisplayName(id);
}

export function getDisplayNameParts(id: string): DisplayNameParts {
  return getPackageDisplayNameParts(id);
}
