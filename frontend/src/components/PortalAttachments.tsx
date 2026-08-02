"use client";

import { useMemo, useState } from "react";
import PdfViewerModal from "@/components/PdfViewerModal";
import ImageViewerModal from "@/components/ImageViewerModal";

export type PublicAttachment = {
  id: string;
  filename: string;
  label?: string | null;
  content_type: string;
  size_bytes: number;
};

const isPdf = (ct: string) => (ct || "").toLowerCase().includes("application/pdf");
const isImage = (ct: string) => (ct || "").toLowerCase().startsWith("image/");
const fmtBytes = (n: number) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = v;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : val < 10 ? 1 : 0;
  return `${val.toFixed(digits)} ${units[i]}`;
};

export default function PortalAttachments(props: {
  attachments: PublicAttachment[];
  basePath?: string; // ex: "attachments" ou "attachments" sous la page
  title?: string;
}) {
  const { attachments, basePath = "attachments", title = "Pièces jointes" } = props;

  const fileHref = useMemo(() => {
    const base = basePath.replace(/\/$/, "");
    return (id: string, download?: boolean) => `${base}/${id}${download ? "?download=1" : ""}`;
  }, [basePath]);

  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfSrc, setPdfSrc] = useState<string>("");
  const [pdfTitle, setPdfTitle] = useState<string>("");

  const [imgOpen, setImgOpen] = useState(false);
  const [imgSrc, setImgSrc] = useState<string>("");
  const [imgTitle, setImgTitle] = useState<string>("");

  if (!attachments || attachments.length === 0) return null;

  const openPreview = (a: PublicAttachment) => {
    const name = (a.label || "").trim() || a.filename;
    if (isPdf(a.content_type)) {
      setPdfTitle(name);
      setPdfSrc(fileHref(a.id));
      setPdfOpen(true);
      return;
    }
    if (isImage(a.content_type)) {
      setImgTitle(name);
      setImgSrc(fileHref(a.id));
      setImgOpen(true);
      return;
    }
    // fallback: download
    window.open(fileHref(a.id, true), "_blank", "noopener,noreferrer");
  };

  return (
    <>
      <div className="portal-proof mt-10">
        <div className="font-800">{title}</div>
        <div className="muted text-12 mt-4">Documents associés (PDF, PNG, JPG ou WEBP).</div>

        {attachments.map((a) => {
          const name = (a.label || "").trim() || a.filename;
          const canPreview = isPdf(a.content_type) || isImage(a.content_type);
          return (
            <div key={a.id} className="portal-proof__row">
              <div>
                <div className="font-700">{name}</div>
                <div className="muted text-12">
                  {a.content_type} · {fmtBytes(a.size_bytes)}
                </div>
              </div>
              <div className="flex gap-8 flex-wrap items-center">
                {canPreview ? (
                  <button className="btn btn--ghost btn--sm" type="button" onClick={() => openPreview(a)}>
                    Aperçu
                  </button>
                ) : null}
                <a className="btn secondary btn--sm" href={fileHref(a.id, true)} target="_blank" rel="noreferrer">
                  Télécharger
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <PdfViewerModal
        open={pdfOpen}
        title={pdfTitle}
        src={pdfSrc}
        openInNewTabHref={pdfSrc ? `${pdfSrc}?download=1` : undefined}
        onClose={() => setPdfOpen(false)}
      />

      <ImageViewerModal
        open={imgOpen}
        title={imgTitle}
        src={imgSrc}
        openInNewTabHref={imgSrc ? `${imgSrc}?download=1` : undefined}
        onClose={() => setImgOpen(false)}
      />
    </>
  );
}
