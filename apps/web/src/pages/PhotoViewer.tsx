import { useFocusTrap } from "@laundry/ui";
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function PhotoViewer({
  children,
  onClose,
}: Readonly<{ children: ReactNode; onClose: () => void }>) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(viewerRef, true);

  const content = (
    <div
      ref={viewerRef}
      className="ld-photo-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="查看照片"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="ld-photo-viewer__body">{children}</div>
    </div>
  );

  // A glass drawer creates a containing block that clips nested fixed overlays.
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
