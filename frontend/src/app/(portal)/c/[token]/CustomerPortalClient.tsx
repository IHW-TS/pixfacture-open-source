"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiUrl, fetchWithTimeout } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
import { publicDocumentStatusLabel } from "@/lib/publicDocumentStatus";
import { PORTAL_DOCUMENT_UNAVAILABLE, portalErrorMessage, portalResponseMessage } from "@/lib/publicPortalErrors";
import PdfViewerModal from "@/components/PdfViewerModal";

type PublicParty = {
  name: string;
  address?: string | null;
  siret?: string | null;
  vat_number?: string | null;
  logo_url?: string | null;
  portal_theme?: string | null;
  portal_support_email?: string | null;
  portal_footer_note?: string | null;
};

type PaymentSummary = {
  date: string;
  method?: string | null;
  amount: number;
  provider?: string | null;
  receipt_url?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
};

type PortalDoc = {
  kind: "invoice" | "credit_note" | "quote";
  id: string;
  number?: string | null;
  currency: string;
  status: string;
  issue_date: string;
  due_date?: string | null;
  valid_until?: string | null;
  total_inc_vat: number;
  balance_due?: number | null;
  portal_path?: string | null;
  pdf_path?: string | null;
  facturx_path?: string | null;
  can_pay_by_card?: boolean;
  last_payment?: PaymentSummary | null;
};

type PublicCustomerPortal = {
  supplier: PublicParty;
  customer: PublicParty;
  documents: PortalDoc[];
  payment_tracking_enabled?: boolean;
};

type Tab = "invoices" | "credit_notes" | "quotes";

const EMPTY_PORTAL_DOCS: PortalDoc[] = [];

const statusLabel = (status: string, kind: PortalDoc["kind"]) =>
  publicDocumentStatusLabel(status, kind === "quote" ? "quote" : "invoice");

const statusWithoutPaymentTracking = (status: string, paymentTrackingEnabled: boolean) => {
  const normalized = status.trim().toLowerCase();
  return !paymentTrackingEnabled &&
    ["paid", "partial", "overdue", "refunded", "partially_refunded"].includes(normalized)
    ? "issued"
    : normalized;
};

const money = (amount: number, currency: string) => `${Number(amount || 0).toFixed(2)} ${currency || "EUR"}`;

export default function CustomerPortalClient({
  token,
  initialData = null,
  initialError = null,
}: {
  token: string;
  initialData?: PublicCustomerPortal | null;
  initialError?: string | null;
}) {
  const hasInitialSnapshot = initialData !== null || initialError !== null;
  const [loading, setLoading] = useState(!hasInitialSnapshot);
  const [data, setData] = useState<PublicCustomerPortal | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [tab, setTab] = useState<Tab>("invoices");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("Aperçu du document");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/customers/${token}`), {
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) {
        throw new Error(await portalResponseMessage(res, PORTAL_DOCUMENT_UNAVAILABLE));
      }
      const payload = (await res.json()) as PublicCustomerPortal;
      setData(payload);

      const kinds = new Set((payload.documents || []).map((d) => d.kind));
      if (!kinds.has("invoice") && kinds.has("quote")) setTab("quotes");
      if (!kinds.has("invoice") && !kinds.has("quote") && kinds.has("credit_note")) setTab("credit_notes");
    } catch (e: any) {
      setData(null);
      setError(portalErrorMessage(e?.message, PORTAL_DOCUMENT_UNAVAILABLE));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (hasInitialSnapshot) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, hasInitialSnapshot]);

  useEffect(() => {
    if (!data) return;
    const kinds = new Set((data.documents || []).map((d) => d.kind));
    if (!kinds.has("invoice") && kinds.has("quote")) setTab("quotes");
    if (!kinds.has("invoice") && !kinds.has("quote") && kinds.has("credit_note")) setTab("credit_notes");
  }, [data]);

  const docs = data?.documents ?? EMPTY_PORTAL_DOCS;
  const paymentTrackingEnabled = data?.payment_tracking_enabled === true;
  const invoices = useMemo(() => docs.filter((d) => d.kind === "invoice"), [docs]);
  const creditNotes = useMemo(() => docs.filter((d) => d.kind === "credit_note"), [docs]);
  const quotes = useMemo(() => docs.filter((d) => d.kind === "quote"), [docs]);
  const currentDocs = tab === "invoices" ? invoices : tab === "credit_notes" ? creditNotes : quotes;

  const openPreview = (doc: PortalDoc) => {
    const local =
      doc.kind === "quote"
        ? `/c/${token}/quotes/${doc.id}/preview.html`
        : doc.kind === "invoice" || doc.kind === "credit_note"
          ? `/c/${token}/invoices/${doc.id}/preview.html`
          : null;
    if (!local) return;
    setPreviewTitle(
      `${doc.kind === "quote" ? "Devis" : doc.kind === "credit_note" ? "Avoir" : "Facture"} ${doc.number || ""}`.trim(),
    );
    setPreviewSrc(local);
    setPreviewOpen(true);
  };

  const supplier = data?.supplier;
  const customer = data?.customer;

  const themeKey = useMemo(() => {
    const t = String((supplier as any)?.portal_theme || "")
      .trim()
      .toLowerCase();
    const allowed = ["blue", "indigo", "emerald", "orange", "rose", "slate", "violet"];
    return allowed.includes(t) ? t : "blue";
  }, [supplier]);

  const supportEmail = useMemo(() => {
    const e = String((supplier as any)?.portal_support_email || "").trim();
    return e || null;
  }, [supplier]);

  const footerNote = useMemo(() => {
    const n = String((supplier as any)?.portal_footer_note || "").trim();
    return n || null;
  }, [supplier]);

  return (
    <div className={`portal-card portal-theme-${themeKey}`}>
      {loading ? (
        <div className="muted">Ouverture de votre espace client…</div>
      ) : error ? (
        <div>
          <h1 className="font-900">Espace client</h1>
          <div className="muted mt-6">{error}</div>
          <div className="mt-12 flex items-center gap-8 flex-wrap">
            <button type="button" className="btn btn--sm" onClick={() => void load()}>
              Réessayer
            </button>
            {supportEmail ? (
              <a className="btn btn--sm btn--ghost" href={`mailto:${supportEmail}`}>
                Contacter l'émetteur
              </a>
            ) : null}
          </div>
        </div>
      ) : !data ? (
        <div className="muted">Introuvable</div>
      ) : (
        <>
          <div className="portal-header">
            <div className="flex items-center gap-12">
              {supplier?.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={supplier.logo_url} alt="Logo" className="portal-logo" />
              ) : (
                <div className="portal-logo-fallback" aria-hidden="true">
                  {supplier?.name?.slice(0, 2)?.toUpperCase() || "C"}
                </div>
              )}
              <div>
                <h1 className="font-900">Espace client</h1>
                <div className="muted text-12">
                  {supplier?.name} · {customer?.name}
                </div>
              </div>
            </div>
          </div>

          <div className="portal-tabs" role="tablist" aria-label="Documents">
            <button
              type="button"
              className={`portal-tab ${tab === "invoices" ? "portal-tab--active" : ""}`}
              onClick={() => setTab("invoices")}
            >
              Factures <span className="portal-tab__count">{invoices.length}</span>
            </button>
            <button
              type="button"
              className={`portal-tab ${tab === "credit_notes" ? "portal-tab--active" : ""}`}
              onClick={() => setTab("credit_notes")}
            >
              Avoirs <span className="portal-tab__count">{creditNotes.length}</span>
            </button>
            <button
              type="button"
              className={`portal-tab ${tab === "quotes" ? "portal-tab--active" : ""}`}
              onClick={() => setTab("quotes")}
            >
              Devis <span className="portal-tab__count">{quotes.length}</span>
            </button>
          </div>

          <PdfViewerModal
            open={previewOpen}
            title={previewTitle}
            src={previewSrc || ""}
            openInNewTabHref={previewSrc || undefined}
            onClose={() => setPreviewOpen(false)}
          />

          {!currentDocs.length ? (
            <div className="muted mt-10">Aucun document.</div>
          ) : (
            <>
              <div className="table-wrap mt-10 portal-docs-table">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Date</th>
                      <th className="num">Montant</th>
                      <th>Statut</th>
                      <th className="num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentDocs.map((d) => {
                      const isInvoice = d.kind === "invoice";
                      const isCredit = d.kind === "credit_note";
                      const isQuote = d.kind === "quote";
                      const localPdf = isQuote ? `/c/${token}/quotes/${d.id}/pdf` : `/c/${token}/invoices/${d.id}/pdf`;
                      const localFacturx = isInvoice ? `/c/${token}/invoices/${d.id}/facturx` : null;
                      const detailHref = isQuote ? `/c/${token}/quotes/${d.id}` : `/c/${token}/invoices/${d.id}`;

                      const paymentBadge =
                        paymentTrackingEnabled && isInvoice && d.last_payment ? (
                          <div className="muted text-12 mt-4">
                            {String(d.last_payment.method || "")
                              .toLowerCase()
                              .includes("refund")
                              ? "Dernier remboursement"
                              : String(d.last_payment.method || "")
                                    .toLowerCase()
                                    .includes("chargeback") ||
                                  String(d.last_payment.method || "")
                                    .toLowerCase()
                                    .includes("dispute")
                                ? "Dernière contestation"
                                : "Dernier paiement"}{" "}
                            : {formatDateFr(d.last_payment.date)} · {money(d.last_payment.amount, d.currency)}
                            {d.last_payment.receipt_url ? (
                              <>
                                {" "}
                                ·{" "}
                                <a href={d.last_payment.receipt_url} target="_blank" rel="noreferrer">
                                  Reçu Stripe
                                </a>
                              </>
                            ) : null}
                          </div>
                        ) : null;

                      return (
                        <tr key={d.id}>
                          <td>
                            <div className="font-800">
                              {isQuote ? "Devis" : isCredit ? "Avoir" : "Facture"} {d.number || ""}
                            </div>
                            {isInvoice && d.due_date ? (
                              <div className="muted text-12">Échéance : {formatDateFr(d.due_date)}</div>
                            ) : null}
                            {isQuote && d.valid_until ? (
                              <div className="muted text-12">Valable jusqu’au : {formatDateFr(d.valid_until)}</div>
                            ) : null}
                            {paymentBadge}
                          </td>
                          <td>{d.issue_date ? formatDateFr(d.issue_date) : ""}</td>
                          <td className="num">
                            {money(isCredit ? Math.abs(d.total_inc_vat) : d.total_inc_vat, d.currency)}
                            {paymentTrackingEnabled && isInvoice && Number(d.balance_due || 0) > 0 ? (
                              <div className="muted text-12">
                                Reste dû : {money(Number(d.balance_due || 0), d.currency)}
                              </div>
                            ) : null}
                            {paymentTrackingEnabled && isCredit && Number(d.balance_due || 0) > 0 ? (
                              <div className="muted text-12">
                                À rembourser : {money(Number(d.balance_due || 0), d.currency)}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {statusLabel(
                              statusWithoutPaymentTracking(String(d.status || ""), paymentTrackingEnabled),
                              d.kind,
                            )}
                          </td>
                          <td className="num">
                            <div className="portal-row-actions">
                              <Link className="btn btn--sm" href={detailHref}>
                                Détails
                              </Link>
                              {d.portal_path ? (
                                <a
                                  className="btn btn--sm btn--ghost"
                                  href={d.portal_path}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Lien direct
                                </a>
                              ) : null}
                              <button className="btn btn--sm btn--ghost" type="button" onClick={() => openPreview(d)}>
                                Aperçu
                              </button>
                              <a className="btn btn--sm btn--ghost" href={localPdf} target="_blank" rel="noreferrer">
                                PDF
                              </a>
                              {localFacturx && d.facturx_path ? (
                                <a
                                  className="btn btn--sm btn--ghost"
                                  href={localFacturx}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Électronique
                                </a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="portal-doc-cards mt-10">
                {currentDocs.map((d) => {
                  const isInvoice = d.kind === "invoice";
                  const isCredit = d.kind === "credit_note";
                  const isQuote = d.kind === "quote";
                  const localPdf = isQuote ? `/c/${token}/quotes/${d.id}/pdf` : `/c/${token}/invoices/${d.id}/pdf`;
                  const localFacturx = isInvoice ? `/c/${token}/invoices/${d.id}/facturx` : null;
                  const detailHref = isQuote ? `/c/${token}/quotes/${d.id}` : `/c/${token}/invoices/${d.id}`;
                  const kindLabel = isQuote ? "Devis" : isCredit ? "Avoir" : "Facture";

                  return (
                    <article key={`card-${d.id}`} className="portal-doc-card">
                      <div className="portal-doc-card__top">
                        <div>
                          <div className="portal-doc-card__title">
                            {kindLabel} {d.number || ""}
                          </div>
                          <div className="muted text-12">
                            {d.issue_date ? formatDateFr(d.issue_date) : "Date non renseignée"}
                          </div>
                        </div>
                        <span className="portal-status">
                          {statusLabel(
                            statusWithoutPaymentTracking(String(d.status || ""), paymentTrackingEnabled),
                            d.kind,
                          )}
                        </span>
                      </div>
                      <div className="portal-doc-card__meta">
                        <div>
                          <span>Montant</span>
                          <strong>{money(isCredit ? Math.abs(d.total_inc_vat) : d.total_inc_vat, d.currency)}</strong>
                        </div>
                        {isInvoice && d.due_date ? (
                          <div>
                            <span>Échéance</span>
                            <strong>{formatDateFr(d.due_date)}</strong>
                          </div>
                        ) : null}
                        {isQuote && d.valid_until ? (
                          <div>
                            <span>Valable jusqu’au</span>
                            <strong>{formatDateFr(d.valid_until)}</strong>
                          </div>
                        ) : null}
                        {paymentTrackingEnabled && isInvoice && Number(d.balance_due || 0) > 0 ? (
                          <div>
                            <span>Reste dû</span>
                            <strong>{money(Number(d.balance_due || 0), d.currency)}</strong>
                          </div>
                        ) : null}
                      </div>
                      <div className="portal-doc-card__actions">
                        <Link className="btn btn--sm" href={detailHref}>
                          Détails
                        </Link>
                        <button className="btn btn--sm btn--ghost" type="button" onClick={() => openPreview(d)}>
                          Aperçu
                        </button>
                        <a className="btn btn--sm btn--ghost" href={localPdf} target="_blank" rel="noreferrer">
                          PDF
                        </a>
                        {localFacturx && d.facturx_path ? (
                          <a className="btn btn--sm btn--ghost" href={localFacturx} target="_blank" rel="noreferrer">
                            Électronique
                          </a>
                        ) : null}
                        {d.portal_path ? (
                          <a className="btn btn--sm btn--ghost" href={d.portal_path} target="_blank" rel="noreferrer">
                            Lien direct
                          </a>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}

          <div className="muted mt-12 text-12">Ce lien est personnel et confidentiel.</div>
          {supportEmail ? (
            <div className="muted mt-8 text-12">
              Besoin d’aide ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
            </div>
          ) : null}
          {footerNote ? <div className="muted mt-6 text-12 pre-line">{footerNote}</div> : null}
        </>
      )}
    </div>
  );
}
