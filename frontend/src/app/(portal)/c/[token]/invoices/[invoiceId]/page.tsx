"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { apiUrl, fetchWithTimeout } from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { publicDocumentStatusLabel } from "@/lib/publicDocumentStatus";
import { vatLineReasonLabel } from "@/lib/vatReason";
import {
  PORTAL_DOCUMENT_UNAVAILABLE,
  PORTAL_PAYMENT_UNAVAILABLE,
  portalErrorMessage,
  portalResponseMessage,
} from "@/lib/publicPortalErrors";
import PdfViewerModal from "@/components/PdfViewerModal";
import PortalDocumentFrame from "@/components/PortalDocumentFrame";
import PortalAttachments from "@/components/PortalAttachments";
import styles from "../../../../i/[token]/page.module.css";

type PublicParty = {
  name: string;
  address?: string | null;
  client_type?: string | null;
  siren?: string | null;
  siret?: string | null;
  vat_number?: string | null;
  vat_regime?: string | null;
  vat_exemption_notice?: string | null;
  logo_url?: string | null;
  email?: string | null;
  phone?: string | null;
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

type TimelineEvent = {
  kind: string;
  label: string;
  at: string;
  amount?: number | null;
  method?: string | null;
  status?: string | null;
};

type InvoiceDetail = {
  id: string;
  payment_tracking_enabled?: boolean;
  type?: string | null;
  number?: string | null;
  currency: string;
  status: string;
  issue_date: string;
  service_date?: string | null;
  due_date?: string | null;
  payment_terms?: string | null;
  delivery_address?: string | null;
  delivery_address_differs?: boolean | null;
  operation_nature?: string | null;
  purchase_order_number?: string | null;
  note?: string | null;
  legal_notice?: string | null;
  supplier: PublicParty;
  customer: PublicParty;
  totals: {
    total_ex_vat: number;
    total_vat: number;
    total_inc_vat: number;
    balance_due: number;
    allowance?: number;
    prepaid?: number;
  };
  lines: Array<{
    line_type?: string | null;
    display_number?: string | null;
    reference?: string | null;
    product_name: string;
    detail?: string | null;
    quantity: number;
    unit_code?: string | null;
    unit_price: number;
    vat_rate: number;
    vat_category?: string | null;
    exemption_reason_code?: string | null;
    line_total: number;
  }>;
  payment?: {
    iban?: string | null;
    bic?: string | null;
    payment_reference?: string | null;
  } | null;
  payments?: PaymentSummary[];
  has_facturx?: boolean;
  card_payment_enabled?: boolean;
  reminder_count?: number;
  last_reminder_at?: string | null;
  sent_at?: string | null;
  issued_at?: string | null;
  paid_at?: string | null;
  pdf_path?: string | null;
  facturx_path?: string | null;
  events?: TimelineEvent[];
  attachments?: Array<{
    id: string;
    filename: string;
    label?: string | null;
    content_type: string;
    size_bytes: number;
  }>;
};

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isInvoiceDetailPayload = (value: unknown): value is InvoiceDetail => {
  if (!isRecord(value)) return false;
  if (!isRecord(value.supplier) || !isRecord(value.customer) || !isRecord(value.totals)) return false;
  if (!Array.isArray(value.lines)) return false;
  return typeof value.totals.total_inc_vat !== "undefined";
};

const statusLabel = (status: string) => publicDocumentStatusLabel(status, "invoice");

const statusWithoutPaymentTracking = (status: string, paymentTrackingEnabled: boolean) => {
  const normalized = status.trim().toLowerCase();
  return !paymentTrackingEnabled &&
    ["paid", "partial", "overdue", "refunded", "partially_refunded"].includes(normalized)
    ? "issued"
    : normalized;
};

const paymentMethodLabel = (p: PaymentSummary) => {
  const method = String(p?.method || "").toLowerCase();
  const provider = String(p?.provider || "").toLowerCase();
  if (method.includes("refund")) return "Remboursement Stripe";
  if (method.includes("chargeback") || method.includes("dispute")) return "Contestation carte";
  if (provider === "stripe" || method === "card") {
    const last4 = p?.card_last4 ? `•••• ${p.card_last4}` : "";
    const brand = p?.card_brand ? String(p.card_brand).toUpperCase() : "Carte";
    return `${brand} ${last4}`.trim() + " (Stripe)";
  }
  if (method === "bank_transfer" || method === "transfer" || method === "virement") return "Virement";
  if (method === "cash") return "Espèces";
  if (method) return "Autre moyen de paiement";
  return "Paiement";
};

const normalizeDocumentText = (value?: string | null) => {
  if (!value) return "";
  return String(value).replace(/\\n/g, "\n").trim();
};

const splitAddressLines = (value?: string | null) =>
  normalizeDocumentText(value)
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*,\s*/))
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(.*?)(\b\d{5}\s+.+)$/);
      if (!match) return [line];
      return [match[1]?.trim(), match[2]?.trim()].filter(Boolean) as string[];
    })
    .filter(Boolean);

const decimalFormatterFr = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const quantityFormatterFr = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatCurrencyFr = (value: number, currency: string) => {
  const amount = Number(value || 0);
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${decimalFormatterFr.format(amount)} ${currency}`;
  }
};

const formatQuantity = (value: number) => quantityFormatterFr.format(Number(value || 0));

const formatPercent = (value: number) => {
  const amount = Number(value || 0);
  if (Number.isInteger(amount)) {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(amount)} %`;
  }
  return `${decimalFormatterFr.format(amount)} %`;
};

const operationNatureLabel = (value?: string | null) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "goods") return "Biens";
  if (normalized === "services") return "Services";
  if (normalized === "mixed") return "Biens et services";
  return String(value || "").trim() || null;
};

const isIndividualClientType = (clientType?: string | null) =>
  ["particulier", "individual", "person", "consumer", "b2c"].includes(
    String(clientType || "")
      .trim()
      .toLowerCase(),
  );

function PartyBlock({
  title,
  party,
  accent = false,
  hideLegalIdentity = false,
}: {
  title: string;
  party: PublicParty;
  accent?: boolean;
  hideLegalIdentity?: boolean;
}) {
  const lines = splitAddressLines(party.address);
  const showDistinctSiret = Boolean(party.siret && party.siret !== party.siren);
  const showLegalIdentity = !hideLegalIdentity && Boolean(party.siren || party.siret || party.vat_number);

  return (
    <div className={`portal-client-party ${accent ? "portal-client-party--accent" : ""}`}>
      <div className="portal-client-party__head">{title}</div>
      <div className="portal-client-party__body">
        <div className="portal-client-party__name">{party.name}</div>
        {lines.length ? (
          <div className="portal-client-party__lines">
            {lines.map((line, index) => (
              <div key={`${title}-line-${index}`}>{line}</div>
            ))}
          </div>
        ) : null}
        {party.email ? (
          <a className="portal-client-party__link" href={`mailto:${party.email}`}>
            {party.email}
          </a>
        ) : null}
        {party.phone ? <div className="portal-client-party__text">{party.phone}</div> : null}
        {showLegalIdentity ? (
          <div className="portal-client-party__ids">
            {party.siren ? (
              <div>
                <span>SIREN</span>
                <strong>{party.siren}</strong>
              </div>
            ) : null}
            {showDistinctSiret ? (
              <div>
                <span>SIRET</span>
                <strong>{party.siret}</strong>
              </div>
            ) : null}
            {party.vat_number ? (
              <div>
                <span>N° TVA</span>
                <strong>{party.vat_number}</strong>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function CustomerPortalInvoiceDetailPage({
  params,
}: {
  params: Promise<{ token: string; invoiceId: string }>;
}) {
  const { token, invoiceId } = use(params);

  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [payingByCard, setPayingByCard] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const paymentStatus = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("payment");
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/customers/${token}/invoices/${invoiceId}`), {
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) {
        throw new Error(await portalResponseMessage(res, PORTAL_DOCUMENT_UNAVAILABLE));
      }
      const data = await res.json();
      if (!isInvoiceDetailPayload(data)) {
        throw new Error(PORTAL_DOCUMENT_UNAVAILABLE);
      }
      setDoc(data);
    } catch (e: any) {
      setDoc(null);
      setError(portalErrorMessage(e?.message, PORTAL_DOCUMENT_UNAVAILABLE));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, invoiceId]);

  useEffect(() => {
    if (paymentStatus !== "success") return;
    const t = window.setTimeout(() => load(), 3500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentStatus]);

  const isCreditNote = useMemo(() => (doc?.type || "invoice") === "credit_note", [doc]);
  const currency = doc?.currency || "EUR";
  const documentLabel = isCreditNote ? "Avoir" : "Facture";
  const paymentTrackingEnabled = doc?.payment_tracking_enabled === true;
  const displayedStatus = statusWithoutPaymentTracking(String(doc?.status || ""), paymentTrackingEnabled);
  const balanceDue = paymentTrackingEnabled ? Number(doc?.totals?.balance_due || 0) : 0;
  const visibleEvents = paymentTrackingEnabled
    ? doc?.events || []
    : (doc?.events || []).filter((event) => !["paid", "payment", "refund", "followup"].includes(event.kind));
  const canPayByCard = false;
  const displayAmount = (value: number) =>
    formatCurrencyFr(isCreditNote ? Math.abs(Number(value || 0)) : Number(value || 0), currency);
  const signedAmount = (value: number) => formatCurrencyFr(Number(value || 0), currency);
  const issueDateLabel = doc?.issue_date ? formatDateFr(doc.issue_date) : "—";
  const serviceDateLabel = doc?.service_date ? formatDateFr(doc.service_date) : issueDateLabel;
  const dueDateLabel = doc?.due_date ? formatDateFr(doc.due_date) : "—";
  const paymentTermsLabel = String(doc?.payment_terms || "").trim() || "—";
  const operationLabel = operationNatureLabel(doc?.operation_nature);
  const normalizedLegalNotice = normalizeDocumentText(doc?.legal_notice);
  const normalizedNote = normalizeDocumentText(doc?.note);
  const deliveryLines = splitAddressLines(doc?.delivery_address);
  const showDelivery = Boolean(doc?.delivery_address_differs || deliveryLines.length);

  const themeKey = useMemo(() => {
    const t = String(doc?.supplier?.portal_theme || "")
      .trim()
      .toLowerCase();
    const allowed = ["blue", "indigo", "emerald", "orange", "rose", "slate", "violet"];
    return allowed.includes(t) ? t : "blue";
  }, [doc]);

  const portalBaseHref = `/c/${encodeURIComponent(token)}/invoices/${encodeURIComponent(invoiceId)}`;
  const previewHtmlHref = `${portalBaseHref}/preview.html`;
  const pdfHref = `${portalBaseHref}/pdf`;
  const facturxHref = `${portalBaseHref}/facturx`;
  const bundleHref = `${portalBaseHref}/bundle`;

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setInfo("Copié.");
      window.setTimeout(() => setInfo(null), 1200);
    } catch {
      setInfo("Copie automatique indisponible. Sélectionnez puis copiez manuellement.");
    }
  }

  async function startCardPayment() {
    if (!doc || payingByCard) return;
    setPayingByCard(true);
    setPaymentError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/customers/${token}/invoices/${invoiceId}/pay/checkout`), {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        throw new Error(PORTAL_PAYMENT_UNAVAILABLE);
      }
      window.location.assign(String(data.url));
    } catch (e: any) {
      setPaymentError(PORTAL_PAYMENT_UNAVAILABLE);
      setPayingByCard(false);
    }
  }

  return (
    <div className={`portal-card portal-theme-${themeKey}`}>
      <div className="portal-detail-top">
        <Link className="btn btn--sm btn--ghost" href={`/c/${token}`}>
          ← Retour
        </Link>
      </div>

      {loading ? (
        <div className="muted">Ouverture du document…</div>
      ) : error ? (
        <div>
          <h1 className="font-900">Document</h1>
          <div className="muted mt-6">{error}</div>
        </div>
      ) : !doc ? (
        <div className="muted">Introuvable</div>
      ) : (
        <>
          <div className="portal-header">
            <div className="flex items-center gap-12">
              {doc.supplier.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={doc.supplier.logo_url} alt="Logo" className="portal-logo" />
              ) : (
                <div className="portal-logo-fallback" aria-hidden="true">
                  {doc.supplier?.name?.slice(0, 2)?.toUpperCase() || "F"}
                </div>
              )}
              <div>
                <h1 className="font-900">
                  {documentLabel} {doc.number || ""}
                  <span className="portal-status">{statusLabel(displayedStatus)}</span>
                </h1>
                <div className="muted text-12">
                  {doc.supplier?.name} · {doc.customer?.name}
                </div>
              </div>
            </div>
            <div className="portal-actions">
              {canPayByCard ? (
                <button className="btn btn--sm" type="button" onClick={startCardPayment} disabled={payingByCard}>
                  {payingByCard ? "Ouverture…" : "Payer par carte"}
                </button>
              ) : null}
              <button className="btn btn--sm btn--ghost" type="button" onClick={() => setPreviewOpen(true)}>
                Aperçu
              </button>
              <details className="portal-client-menu">
                <summary className="btn btn--sm btn--ghost list-none cursor-pointer">Documents</summary>
                <div className="portal-client-menu__panel">
                  <a className="portal-client-menu__item" href={pdfHref} target="_blank" rel="noreferrer">
                    PDF
                  </a>
                  {doc.facturx_path ? (
                    <a className="portal-client-menu__item" href={facturxHref} target="_blank" rel="noreferrer">
                      Export structuré
                    </a>
                  ) : null}
                  <a className="portal-client-menu__item" href={bundleHref} target="_blank" rel="noreferrer">
                    Dossier complet
                  </a>
                </div>
              </details>
            </div>
          </div>

          <PdfViewerModal
            open={previewOpen}
            title={`${documentLabel} ${doc.number || ""}`.trim()}
            src={previewHtmlHref}
            openInNewTabHref={previewHtmlHref}
            onClose={() => setPreviewOpen(false)}
          />

          {paymentError ? <div className="notice warning mt-12">{paymentError}</div> : null}

          <PortalDocumentFrame
            src={previewHtmlHref}
            title={`${documentLabel} ${doc.number || ""}`.trim()}
            viewportClassName={styles.serverDocumentViewport}
            shellClassName={styles.serverDocumentFrameShell}
            frameClassName={styles.serverDocumentFrame}
            aria-label={`${documentLabel} ${doc.number || ""}`.trim()}
            data-testid="customer-portal-invoice-document"
          />

          <div className={styles.legacyDocumentFallback} aria-hidden="true">
            <section className="portal-client-paper">
              <div className="portal-client-paper__header">
                <div className="portal-client-paper__brand">
                  {doc.supplier.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={doc.supplier.logo_url} alt={doc.supplier.name} />
                  ) : (
                    <div className="portal-logo-fallback" aria-hidden="true">
                      {doc.supplier.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <strong>{doc.supplier.name}</strong>
                    {doc.supplier.email ? <span>{doc.supplier.email}</span> : null}
                  </div>
                </div>
                <div className="portal-client-paper__title">
                  <span>{documentLabel.toUpperCase()}</span>
                  <strong>{doc.number || "—"}</strong>
                  <em>{statusLabel(displayedStatus)}</em>
                </div>
              </div>

              <div className="portal-client-meta-grid">
                <div>
                  <span>Date d’émission</span>
                  <strong>{issueDateLabel}</strong>
                </div>
                <div>
                  <span>Date de prestation</span>
                  <strong>{serviceDateLabel}</strong>
                </div>
                <div>
                  <span>Échéance</span>
                  <strong>{dueDateLabel}</strong>
                </div>
                <div>
                  <span>Conditions</span>
                  <strong>{paymentTermsLabel}</strong>
                </div>
              </div>

              <div className="portal-client-parties">
                <PartyBlock title="Émetteur" party={doc.supplier} />
                <PartyBlock
                  title="Facturé à"
                  party={doc.customer}
                  hideLegalIdentity={isIndividualClientType(doc.customer?.client_type)}
                  accent
                />
              </div>

              <div className="portal-client-table-wrap">
                <table className="portal-client-table">
                  <colgroup>
                    <col className="portal-client-col-index" />
                    <col className="portal-client-col-product" />
                    <col className="portal-client-col-qty" />
                    <col className="portal-client-col-unit-price" />
                    <col className="portal-client-col-vat" />
                    <col className="portal-client-col-total" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>N°</th>
                      <th>Produit / service</th>
                      <th className="num">Qté</th>
                      <th className="num">PU HT</th>
                      <th className="num">TVA</th>
                      <th className="num">Total HT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lines.map((line, index) => {
                      const lineKind = String(line.line_type || "item").toLowerCase();
                      if (lineKind === "comment" || lineKind === "section" || lineKind === "title") {
                        return (
                          <tr key={`${line.product_name}-${index}`}>
                            <td colSpan={6}>
                              <strong>{line.product_name}</strong>
                              {line.detail && line.detail !== line.product_name ? <span>{line.detail}</span> : null}
                            </td>
                          </tr>
                        );
                      }
                      const itemNumber = doc.lines.slice(0, index + 1).filter((candidate) => {
                        const kind = String(candidate.line_type || "item").toLowerCase();
                        return kind !== "comment" && kind !== "section" && kind !== "title";
                      }).length;
                      return (
                        <tr key={`${line.product_name}-${index}`}>
                          <td>{line.display_number || itemNumber}</td>
                          <td>
                            <strong>{line.product_name}</strong>
                            {line.reference ? <span>Réf. {line.reference}</span> : null}
                            {line.detail ? <span>{line.detail}</span> : null}
                          </td>
                          <td className="num">{formatQuantity(Math.abs(Number(line.quantity || 0)))}</td>
                          <td className="num">{displayAmount(line.unit_price)}</td>
                          <td className="num">
                            {formatPercent(line.vat_rate)}
                            {vatLineReasonLabel(line, doc.supplier) ? (
                              <span className="muted text-12">{vatLineReasonLabel(line, doc.supplier)}</span>
                            ) : null}
                          </td>
                          <td className="num">{displayAmount(line.line_total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="portal-client-balance-row">
                <div className="portal-client-support">
                  {showDelivery ? (
                    <div>
                      <span>Livraison</span>
                      {deliveryLines.map((line, index) => (
                        <strong key={`delivery-${index}`}>{line}</strong>
                      ))}
                    </div>
                  ) : null}
                  {operationLabel ? (
                    <div>
                      <span>Nature</span>
                      <strong>{operationLabel}</strong>
                    </div>
                  ) : null}
                  {doc.purchase_order_number ? (
                    <div>
                      <span>Commande</span>
                      <strong>{doc.purchase_order_number}</strong>
                    </div>
                  ) : null}
                  {doc.payment?.iban ? (
                    <div>
                      <span>IBAN</span>
                      <button type="button" onClick={() => copyToClipboard(String(doc.payment?.iban))}>
                        {doc.payment.iban}
                      </button>
                    </div>
                  ) : null}
                  {doc.payment?.bic ? (
                    <div>
                      <span>BIC</span>
                      <button type="button" onClick={() => copyToClipboard(String(doc.payment?.bic))}>
                        {doc.payment.bic}
                      </button>
                    </div>
                  ) : null}
                  {doc.payment?.payment_reference ? (
                    <div>
                      <span>Référence</span>
                      <button type="button" onClick={() => copyToClipboard(String(doc.payment?.payment_reference))}>
                        {doc.payment.payment_reference}
                      </button>
                    </div>
                  ) : null}
                  {info ? <p className="muted text-12">{info}</p> : null}
                </div>

                <div className="portal-client-totals">
                  <div>
                    <span>Total HT</span>
                    <strong>{displayAmount(doc.totals.total_ex_vat)}</strong>
                  </div>
                  {Number(doc.totals.allowance || 0) > 0 ? (
                    <div>
                      <span>Remise</span>
                      <strong>- {formatCurrencyFr(Math.abs(Number(doc.totals.allowance || 0)), currency)}</strong>
                    </div>
                  ) : null}
                  <div>
                    <span>TVA</span>
                    <strong>{displayAmount(doc.totals.total_vat)}</strong>
                  </div>
                  {Number(doc.totals.prepaid || 0) > 0 ? (
                    <div>
                      <span>Acompte</span>
                      <strong>- {formatCurrencyFr(Math.abs(Number(doc.totals.prepaid || 0)), currency)}</strong>
                    </div>
                  ) : null}
                  <div className="portal-client-totals__total">
                    <span>Total TTC</span>
                    <strong>{displayAmount(doc.totals.total_inc_vat)}</strong>
                  </div>
                  {paymentTrackingEnabled && !isCreditNote && balanceDue > 0 ? (
                    <div>
                      <span>Reste dû</span>
                      <strong>{signedAmount(balanceDue)}</strong>
                    </div>
                  ) : null}
                </div>
              </div>

              {normalizedLegalNotice || normalizedNote ? (
                <div className="portal-client-paper__note">
                  {normalizedLegalNotice ? <p>{normalizedLegalNotice}</p> : null}
                  {normalizedNote ? <p>{normalizedNote}</p> : null}
                </div>
              ) : null}
            </section>
          </div>

          <PortalAttachments attachments={doc.attachments || []} />

          <div className={paymentTrackingEnabled ? "grid grid-2 gap-12 mt-12" : "grid gap-12 mt-12"}>
            <div className="portal-block">
              <div className="font-800">Historique</div>
              {!visibleEvents.length ? (
                <div className="muted mt-8">Aucun événement.</div>
              ) : (
                <div className="timeline mt-10">
                  {visibleEvents.map((event, idx) => (
                    <div key={`${event.at}-${idx}`} className="timeline-row">
                      <div className="timeline-row__left">
                        <div className="font-800">{event.label}</div>
                        <div className="muted text-12">{formatDateTimeFr(event.at)}</div>
                      </div>
                      <div className="timeline-row__right">
                        {typeof event.amount === "number" ? (
                          <span className="mono">{displayAmount(event.amount)}</span>
                        ) : null}
                        {event.method ? <span className="muted text-12">{event.method}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {paymentTrackingEnabled ? (
              <div className="portal-block">
                <div className="font-800">Paiements</div>
                {!doc.payments?.length ? (
                  <div className="muted mt-8">Aucun paiement enregistré.</div>
                ) : (
                  <div className="mt-10">
                    {doc.payments.map((payment, idx) => (
                      <div key={`${payment.date}-${idx}`} className="portal-payment-row">
                        <div className="portal-payment-row__left">
                          <div className="font-800">{paymentMethodLabel(payment)}</div>
                          <div className="muted text-12">{formatDateTimeFr(payment.date)}</div>
                          {payment.receipt_url ? (
                            <div className="muted text-12">
                              <a href={payment.receipt_url} target="_blank" rel="noreferrer">
                                {String(payment.provider || "").toLowerCase() === "stripe" ? "Reçu Stripe" : "Reçu"}
                              </a>
                            </div>
                          ) : null}
                        </div>
                        <div className="portal-payment-row__right">
                          <div className="font-900">{displayAmount(payment.amount)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
