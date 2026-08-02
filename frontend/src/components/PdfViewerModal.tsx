"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";

type Props = {
  open: boolean;
  title: string;
  src: string; // same-origin document URL or proxy route
  onClose: () => void;
  /** Optional: open/download link shown in toolbar */
  openInNewTabHref?: string;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const DEFAULT_PDF_SCALE = 0.9;

export default function PdfViewerModal({ open, title, src, onClose, openInNewTabHref }: Props) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [scale, setScale] = useState(DEFAULT_PDF_SCALE);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Reset zoom when opening a different doc
  const key = useMemo(() => `${src}`, [src]);
  useEffect(() => {
    if (!open) return;
    setScale(DEFAULT_PDF_SCALE);
  }, [open, key]);

  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => null);
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
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

  // Fullscreen state tracking
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const zoomIn = () => setScale((s) => clamp(Number((s + 0.1).toFixed(2)), 0.6, 2.0));
  const zoomOut = () => setScale((s) => clamp(Number((s - 0.1).toFixed(2)), 0.6, 2.0));
  const zoomReset = () => setScale(DEFAULT_PDF_SCALE);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      } else {
        await modalRef.current?.requestFullscreen?.();
      }
    } catch {
      // ignore
    }
  };

  if (!mounted) return null;
  const scaleClass = `pdf-scale-${Math.round(scale * 100)}`;

  return (
    <div
      className="pdf-modal-backdrop ui-overlay ui-overlay--dark"
      data-state={state}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="pdf-modal ui-dialog" ref={modalRef}>
        <div className="pdf-modal__toolbar">
          <div className="pdf-modal__title">
            <span className="font-800">{title}</span>
          </div>
          <div className="pdf-modal__actions">
            <button type="button" className="btn btn--sm pdf-modal__button" onClick={zoomOut} aria-label="Zoom -">
              −
            </button>
            <button type="button" className="btn btn--sm pdf-modal__button" onClick={zoomIn} aria-label="Zoom +">
              +
            </button>
            <button type="button" className="btn btn--sm pdf-modal__button" onClick={zoomReset}>
              Ajuster
            </button>

            <button type="button" className="btn btn--sm pdf-modal__button" onClick={toggleFullscreen}>
              {isFullscreen ? "Quitter plein écran" : "Plein écran"}
            </button>

            {openInNewTabHref ? (
              <a className="btn btn--sm pdf-modal__button" href={openInNewTabHref} target="_blank" rel="noreferrer">
                Ouvrir
              </a>
            ) : null}

            <button ref={closeButtonRef} type="button" className="btn btn--sm pdf-modal__button" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
        <div className="pdf-modal__body">
          <iframe className={`pdf-modal__frame ${scaleClass}`} src={src} title={title} />
        </div>
      </div>
    </div>
  );
}
