"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_DOCUMENT_HEIGHT = 1123;
const MIN_DOCUMENT_HEIGHT = 420;
const MAX_DOCUMENT_HEIGHT = 9000;
const DEFAULT_DOCUMENT_WIDTH = 794;
const DEFAULT_DOCUMENT_ZOOM = 1.05;

type Props = {
  src: string;
  title: string;
  viewportClassName: string;
  shellClassName: string;
  frameClassName: string;
  baseWidth?: number;
  "aria-label"?: string;
  "data-testid"?: string;
};

export default function PortalDocumentFrame({
  src,
  title,
  viewportClassName,
  shellClassName,
  frameClassName,
  baseWidth = DEFAULT_DOCUMENT_WIDTH,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: Props) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState(DEFAULT_DOCUMENT_HEIGHT);
  const [viewportWidth, setViewportWidth] = useState(baseWidth);
  const [manualZoom, setManualZoom] = useState(DEFAULT_DOCUMENT_ZOOM);

  const updateViewportMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const width = Math.floor(viewport.clientWidth || viewport.getBoundingClientRect().width || baseWidth);
    setViewportWidth(Math.max(1, width));

    const rawZoom = window.getComputedStyle(viewport).getPropertyValue("--invoice-detail-scale").trim();
    const parsedZoom = Number(rawZoom || String(DEFAULT_DOCUMENT_ZOOM));
    setManualZoom(Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : DEFAULT_DOCUMENT_ZOOM);
  }, [baseWidth]);

  const updateFrameHeight = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc?.body || !doc.documentElement) return;

    try {
      const page = doc.querySelector(".page") as HTMLElement | null;
      const pageHeight = page ? Math.max(page.scrollHeight, page.offsetHeight, page.getBoundingClientRect().height) : 0;
      const fallbackHeight = Math.max(
        doc.body.scrollHeight,
        doc.body.offsetHeight,
        doc.documentElement.scrollHeight,
        doc.documentElement.offsetHeight,
      );
      const measuredHeight = Math.ceil(pageHeight || fallbackHeight);
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
      setFrameHeight(Math.min(MAX_DOCUMENT_HEIGHT, Math.max(MIN_DOCUMENT_HEIGHT, measuredHeight + 2)));
    } catch {
      setFrameHeight(DEFAULT_DOCUMENT_HEIGHT);
    }
  }, []);

  useEffect(() => {
    setFrameHeight(DEFAULT_DOCUMENT_HEIGHT);
  }, [src]);

  useEffect(() => {
    updateViewportMetrics();
  });

  useEffect(() => {
    updateViewportMetrics();
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewportMetrics);
    observer?.observe(viewport);
    window.addEventListener("resize", updateViewportMetrics);
    window.addEventListener("orientationchange", updateViewportMetrics);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateViewportMetrics);
      window.removeEventListener("orientationchange", updateViewportMetrics);
    };
  }, [updateViewportMetrics]);

  const viewportScaleLimit = viewportWidth / Math.max(1, baseWidth);
  const fitScale = Math.min(1, viewportScaleLimit);
  const requestedScale = fitScale < 1 ? fitScale * Math.min(manualZoom, 1) : manualZoom;
  const safeScale = Math.max(0.1, Math.min(requestedScale, viewportScaleLimit || 1));
  const visualHeight = Math.ceil(frameHeight * safeScale);
  const viewportStyle = {
    "--portal-document-frame-width": `${baseWidth}px`,
    "--portal-document-frame-height": `${frameHeight}px`,
    "--portal-document-frame-scale": String(safeScale),
    "--portal-document-frame-visual-height": `${visualHeight}px`,
  } as CSSProperties;

  return (
    <section
      ref={viewportRef}
      className={viewportClassName}
      style={viewportStyle}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <div className={shellClassName}>
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          className={frameClassName}
          sandbox="allow-same-origin"
          onLoad={updateFrameHeight}
          height={frameHeight}
        />
      </div>
    </section>
  );
}
