"use client";

import { useEffect, useRef, useState } from "react";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";

type InvoiceExportsModalProps = {
  open: boolean;
  canExport: boolean;
  onClose: () => void;
  onDownload: (path: string, filename?: string) => void;
  tooltip?: string;
};

type EdiFormat = "ubl" | "cii";

export default function InvoiceExportsModal({
  open,
  canExport,
  onClose,
  onDownload,
  tooltip,
}: InvoiceExportsModalProps) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [ediFormat, setEdiFormat] = useState<EdiFormat>("ubl");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setStartDate("");
    setEndDate("");
    setEdiFormat("ubl");
  }, [open]);

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

  const buildParams = () => {
    const params = new URLSearchParams();
    if (startDate) params.append("start_date", startDate);
    if (endDate) params.append("end_date", endDate);
    return params;
  };

  const handleCsvExport = () => {
    const params = buildParams();
    const qs = params.toString();
    onDownload(`/api/invoices/export.csv${qs ? `?${qs}` : ""}`, "export-compta.csv");
  };

  const handleFecExport = () => {
    const params = buildParams();
    const qs = params.toString();
    onDownload(`/api/invoices/export.fec${qs ? `?${qs}` : ""}`, "export-fec.csv");
  };

  const handleEdiExport = () => {
    const params = buildParams();
    params.append("format", ediFormat);
    onDownload(`/api/invoices/export.edi.zip?${params.toString()}`, `export-edi-${ediFormat}.zip`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Exports ventes & contrôle compta"
      className="modal-overlay ui-overlay z-70"
      data-state={state}
    >
      <div ref={dialogRef} className="card ui-dialog max-w-560 w-full grid-simple gap-14">
        <div className="panel__header flex items-center justify-between">
          <h3 className="m-0">Exports ventes & contrôle compta</h3>
          <button ref={closeButtonRef} className="icon-button" aria-label="Fermer" type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="grid-simple gap-12">
          <div className="form-grid">
            <label>
              Période début
              <br />
              <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <small className="muted">Format : jj/mm/aaaa</small>
            </label>
            <label>
              Période fin
              <br />
              <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              <small className="muted">Format : jj/mm/aaaa</small>
            </label>
          </div>
          <label>
            Format EDI
            <select className="input" value={ediFormat} onChange={(e) => setEdiFormat(e.target.value as EdiFormat)}>
              <option value="ubl">UBL</option>
              <option value="cii">CII</option>
            </select>
          </label>
          <div className="row gap-10 flex-wrap">
            <button
              className="btn secondary"
              type="button"
              onClick={handleCsvExport}
              disabled={!canExport}
              title={
                !canExport
                  ? tooltip
                  : "Exporte les ventes sur la période saisie, ou toutes les ventes si aucune période n'est indiquée."
              }
            >
              Exporter les ventes filtrées
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={handleFecExport}
              disabled={!canExport}
              title={!canExport ? tooltip : undefined}
            >
              Journal ventes format FEC
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={handleEdiExport}
              disabled={!canExport}
              title={
                !canExport
                  ? tooltip
                  : "Exporte l'archive EDI sur la période saisie, ou toutes les ventes si aucune période n'est indiquée."
              }
            >
              Exporter EDI filtré (ZIP)
            </button>
          </div>
          <p className="muted m-0">
            Le journal des ventes au format FEC est un export de travail à contrôler avec votre cabinet, pas un FEC
            fiscal complet de l’exercice.
          </p>
        </div>
      </div>
    </div>
  );
}
