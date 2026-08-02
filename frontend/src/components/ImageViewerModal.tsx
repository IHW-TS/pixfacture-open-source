"use client";

import { useEffect, useRef } from "react";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";

export default function ImageViewerModal(props: {
  open: boolean;
  src: string;
  title?: string;
  openInNewTabHref?: string;
  onClose: () => void;
}) {
  const { open, src, title, openInNewTabHref, onClose } = props;
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!mounted) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div
      className="pdf-modal-backdrop ui-overlay ui-overlay--dark"
      data-state={state}
      role="dialog"
      aria-modal="true"
      aria-label={title || "Prévisualisation"}
      onClick={onClose}
    >
      <div ref={dialogRef} className="pdf-modal ui-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-modal__toolbar">
          <div className="pdf-modal__title font-800">{title || "Prévisualisation"}</div>
          <div className="pdf-modal__actions">
            {openInNewTabHref ? (
              <a className="btn btn--ghost btn--sm" href={openInNewTabHref} target="_blank" rel="noreferrer">
                Ouvrir
              </a>
            ) : null}
            <button ref={closeButtonRef} className="btn btn--ghost btn--sm" type="button" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
        <div className="pdf-modal__body">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="pdf-modal__frame image-modal__img" src={src} alt={title || "Prévisualisation"} />
        </div>
      </div>
    </div>
  );
}
