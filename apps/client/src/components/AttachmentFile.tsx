import type { MessageAttachment } from "@loam/schema";

import { t } from "../i18n";
import { attachmentPath } from "../lib/attachments";
import { useEncryptedImage } from "../lib/use-encrypted-image";

/**
 * A non-image file attachment (P11), rendered as a download link. Reuses the tunnel-aware URL resolver
 * (docs/08) exactly like `AttachmentImage`: in `required` transport mode a direct GET to `/api/attachments`
 * is 401'd, so the bytes are fetched through the tunnel and offered as a `blob:` URL; otherwise it's the
 * plain same-origin URL. A per-attachment component so `useEncryptedImage` isn't called inside a `.map`.
 */
export function AttachmentFile({ attachment }: { attachment: MessageAttachment }) {
  const href = useEncryptedImage(attachmentPath(attachment));

  return (
    <a className="attachment-file" download={attachment.name ?? "file"} href={href} rel="noreferrer">
      📎 {attachment.name ?? t("message.attachedFile")}
    </a>
  );
}
