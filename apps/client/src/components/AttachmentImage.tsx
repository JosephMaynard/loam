import type { MessageAttachment } from "@loam/schema";

import { attachmentPath } from "../lib/attachments";
import { useEncryptedImage } from "../lib/use-encrypted-image";

export interface AttachmentImageProps {
  attachment: MessageAttachment;
  alt: string;
}

/**
 * One message image attachment. In `required` transport mode the raw endpoint won't serve a direct
 * `<img>` GET, so the `src` is resolved through the tunnel into a `blob:` URL (docs/08); otherwise it's
 * the plain same-origin URL. The link target reuses the same resolved `src` so "open in a new tab"
 * works in both cases. A per-attachment component so the `useEncryptedImage` hook isn't called in a map.
 */
export function AttachmentImage({ attachment, alt }: AttachmentImageProps) {
  const src = useEncryptedImage(attachmentPath(attachment));

  return (
    <a href={src} rel="noreferrer" target="_blank">
      <img
        alt={alt}
        className="message-attachment"
        height={attachment.height}
        loading="lazy"
        src={src}
        width={attachment.width}
      />
    </a>
  );
}
