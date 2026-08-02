"use client";

import { type CSSProperties, use, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  BadgeCheck,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  CreditCard,
  Download,
  FileText,
  Info,
  Mail,
  MapPin,
  Phone,
  Printer,
} from "lucide-react";
import { apiUrl, fetchWithTimeout } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
import { publicDocumentStatusLabel } from "@/lib/publicDocumentStatus";
import PdfViewerModal from "@/components/PdfViewerModal";
import PortalDocumentFrame from "@/components/PortalDocumentFrame";
import PortalAttachments from "@/components/PortalAttachments";
import { documentVatLegalLabel, vatLineReasonLabel } from "@/lib/vatReason";
import {
  PORTAL_DOCUMENT_UNAVAILABLE,
  PORTAL_PAYMENT_UNAVAILABLE,
  portalErrorMessage,
  portalResponseMessage,
} from "@/lib/publicPortalErrors";
import styles from "./page.module.css";

type PublicInvoice = {
  type: string;
  number?: string | null;
  currency: string;
  status: string;
  issue_date?: string | null;
  service_date?: string | null;
  due_date?: string | null;
  payment_terms?: string | null;
  delivery_address?: string | null;
  delivery_address_differs?: boolean | null;
  operation_nature?: string | null;
  purchase_order_number?: string | null;
  note?: string | null;
  legal_notice?: string | null;
  supplier: {
    name: string;
    address?: string | null;
    siren?: string | null;
    siret?: string | null;
    vat_number?: string | null;
    vat_regime?: string | null;
    vat_exemption_notice?: string | null;
    logo_url?: string | null;
    email?: string | null;
    phone?: string | null;
    legal_form?: string | null;
    share_capital?: string | null;
    rcs?: string | null;
    vat_on_debits?: boolean | null;
    late_payment_interest?: string | null;
    recovery_fee_eur?: number | null;
    discount_terms?: string | null;
  };
  customer: {
    name: string;
    address?: string | null;
    client_type?: string | null;
    siren?: string | null;
    siret?: string | null;
    vat_number?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  payment?: {
    iban?: string | null;
    bic?: string | null;
    payment_reference?: string | null;
  } | null;
  payments?: Array<{
    date: string;
    method?: string | null;
    amount: number;
    provider?: string | null;
    receipt_url?: string | null;
    card_brand?: string | null;
    card_last4?: string | null;
  }>;
  payment_tracking_enabled?: boolean;
  has_facturx: boolean;
  card_payment_enabled?: boolean;
  public_expires_at?: string | null;
  public_expires_in_days?: number | null;
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
  attachments?: Array<{
    id: string;
    filename: string;
    label?: string | null;
    content_type: string;
    size_bytes: number;
  }>;
};

type StatusTone = "paid" | "sent" | "overdue" | "draft";

const PORTAL_DOCUMENT_BASE_WIDTH = 794;
const PORTAL_DOCUMENT_LOCKED_ZOOM = 1.05;
const PIXFACTURE_BRAND_NAME = "PixFacture";

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isPublicInvoicePayload = (value: unknown): value is PublicInvoice => {
  if (!isRecord(value)) return false;
  if (!isRecord(value.supplier) || !isRecord(value.customer) || !isRecord(value.totals)) return false;
  if (!Array.isArray(value.lines)) return false;
  return typeof value.totals.total_inc_vat !== "undefined";
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const statusLabel = (status: string) => publicDocumentStatusLabel(status, "invoice");

const statusTone = (status: string): StatusTone => {
  if (status === "paid") return "paid";
  if (status === "sent" || status === "issued" || status === "partial") return "sent";
  if (status === "overdue") return "overdue";
  return "draft";
};

const isIndividualClientType = (clientType?: string | null) =>
  ["particulier", "individual", "person", "consumer", "b2c"].includes(
    String(clientType || "")
      .trim()
      .toLowerCase(),
  );

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
      const street = match[1]?.trim();
      const postalCity = match[2]?.trim();
      return [street, postalCity].filter(Boolean) as string[];
    })
    .filter(Boolean);

const hasFrenchPostalLine = (lines: string[]) => lines.some((line) => /\b\d{5}\s+[A-Za-zÀ-ÿ]/.test(line));

const stripDomesticFranceLine = (lines: string[]) =>
  lines.filter((line, index) => !(index === lines.length - 1 && /^france$/i.test(line.trim())));

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

function publicPaymentLabel(payment: NonNullable<PublicInvoice["payments"]>[number]) {
  const method = String(payment?.method || "").toLowerCase();
  const provider = String(payment?.provider || "").toLowerCase();
  if (method.includes("refund")) return "Remboursement Stripe";
  if (method.includes("chargeback") || method.includes("dispute")) return "Contestation carte";
  if (provider === "stripe" || method === "card") {
    const brand = payment?.card_brand ? String(payment.card_brand).toUpperCase() : "Carte bancaire";
    const last4 = payment?.card_last4 ? ` •••• ${payment.card_last4}` : "";
    return `${brand}${last4} (Stripe)`;
  }
  if (method === "bank_transfer" || method === "transfer" || method === "virement") return "Virement bancaire";
  if (method === "cash") return "Espèces";
  if (method) return "Autre moyen de paiement";
  return "Paiement";
}

const formatPercentFr = (value: number) => `${decimalFormatterFr.format(Number(value || 0))} %`;

const formatPercentCompactFr = (value: number) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0 %";
  if (Number.isInteger(amount)) {
    return `${new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)} %`;
  }
  return `${decimalFormatterFr.format(amount)} %`;
};

const formatQuantity = (value: number) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0";
  return quantityFormatterFr.format(amount);
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

function VisualAvatar({
  name,
  logoUrl,
  compact = false,
  accent = false,
  hero = false,
}: {
  name: string;
  logoUrl?: string | null;
  compact?: boolean;
  accent?: boolean;
  hero?: boolean;
}) {
  const initials = name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div
      className={cx(
        styles.avatar,
        compact && styles.avatarCompact,
        accent && styles.avatarAccent,
        hero && styles.avatarHero,
        logoUrl && styles.avatarLogo,
      )}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={name} className={styles.avatarImg} />
      ) : (
        <span className={styles.avatarInitials}>{initials}</span>
      )}
    </div>
  );
}

function StatusBadge({ status, banner = false }: { status: string; banner?: boolean }) {
  const tone = statusTone(status);
  const label = statusLabel(status);
  const Icon = tone === "paid" ? CheckCircle2 : tone === "overdue" ? AlertCircle : Info;

  return (
    <span className={cx(styles.statusBadge, styles[`status${tone}`], banner && styles.statusBadgeBanner)}>
      <Icon size={banner ? 11 : 12} />
      {banner ? label.toUpperCase() : label}
    </span>
  );
}

function PartyCard({
  role,
  name,
  lines,
  siren,
  siret,
  vat,
  email,
  phone,
  clientType,
  accent = false,
}: {
  role: string;
  name: string;
  lines: string[];
  siren?: string | null;
  siret?: string | null;
  vat?: string | null;
  email?: string | null;
  phone?: string | null;
  clientType?: string | null;
  accent?: boolean;
}) {
  const showDistinctSiret = Boolean(siret && siret !== siren);
  const showSiretOnly = Boolean(!siren && siret);
  const showLegalIdentity = !isIndividualClientType(clientType) && Boolean(siren || siret || vat);

  return (
    <div className={cx(styles.partyCard, accent && styles.partyCardAccent)}>
      <div className={cx(styles.partyCardBand, accent && styles.partyCardBandAccent)}>
        <span className={styles.overline}>{role}</span>
      </div>

      <div className={styles.partyCardBody}>
        <p className={styles.partyCardName}>{name}</p>

        {lines.length ? (
          <div className={cx(styles.partyCardRow, styles.partyCardAddressRow)}>
            <MapPin size={14} className={styles.partyCardIcon} />
            <div className={styles.partyCardStack}>
              {lines.map((line, index) => (
                <p key={`${role}-line-${index}`}>{line}</p>
              ))}
            </div>
          </div>
        ) : null}

        {email ? (
          <div className={cx(styles.partyCardRow, styles.partyCardMailRow)}>
            <Mail size={14} className={styles.partyCardIcon} />
            <a className={styles.partyCardMail} href={`mailto:${email}`}>
              {email}
            </a>
          </div>
        ) : null}

        {phone ? (
          <div className={cx(styles.partyCardRow, styles.partyCardMailRow)}>
            <Phone size={14} className={styles.partyCardIcon} />
            <p className={styles.partyCardText}>{phone}</p>
          </div>
        ) : null}

        {showLegalIdentity && (
          <div className={styles.partyCardIdentity}>
            <Building2 size={14} className={styles.partyCardIcon} />
            <div className={styles.partyCardMeta}>
              {siren ? (
                <p>
                  <span className={styles.partyCardMetaLabel}>SIREN</span>
                  <span className={styles.partyCardMetaValue}>{siren}</span>
                </p>
              ) : null}
              {showDistinctSiret || showSiretOnly ? (
                <p>
                  <span className={styles.partyCardMetaLabel}>SIRET</span>
                  <span className={styles.partyCardMetaValue}>{siret}</span>
                </p>
              ) : null}
              {vat ? (
                <p>
                  <span className={styles.partyCardMetaLabel}>N° TVA</span>
                  <span className={styles.partyCardMetaValue}>{vat}</span>
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PublicInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [payingByCard, setPayingByCard] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const portalBaseHref = `/i/${encodeURIComponent(token)}`;
  const previewHtmlHref = `${portalBaseHref}/preview.html`;
  const pdfHref = `${portalBaseHref}/pdf`;
  const bundleHref = `${portalBaseHref}/bundle`;
  const facturxUrl = useMemo(() => apiUrl(`/api/public/invoices/${token}/facturx.pdf`), [token]);
  const paymentStatus = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("payment");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/invoices/${token}`), {
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) {
        throw new Error(await portalResponseMessage(res, PORTAL_DOCUMENT_UNAVAILABLE));
      }
      const data = await res.json();
      if (!isPublicInvoicePayload(data)) {
        throw new Error(PORTAL_DOCUMENT_UNAVAILABLE);
      }
      setInvoice(data);
    } catch (err: any) {
      setInvoice(null);
      setError(portalErrorMessage(err?.message, PORTAL_DOCUMENT_UNAVAILABLE));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paymentStatus !== "success") return;
    const timeoutId = window.setTimeout(() => void load(), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [load, paymentStatus]);

  const isDraft = invoice?.status === "draft";
  const isCreditNote = useMemo(() => (invoice?.type || "invoice") === "credit_note", [invoice]);
  const supportEmail = useMemo(() => {
    const email = String((invoice as any)?.supplier?.portal_support_email || "").trim();
    return email || null;
  }, [invoice]);
  const normalizedNote = useMemo(() => normalizeDocumentText(invoice?.note), [invoice?.note]);
  const isPublisherSupplier = useMemo(
    () => /entreprise-exemple/i.test(String(invoice?.supplier?.name || "")),
    [invoice?.supplier?.name],
  );
  const supplierFallbackAddress = useMemo(() => {
    if (!isPublisherSupplier) return null;
    return process.env.NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS || process.env.NEXT_PUBLIC_LEGAL_ADDRESS || null;
  }, [isPublisherSupplier]);
  const supplierFallbackEmail = useMemo(() => {
    if (!isPublisherSupplier) return null;
    return (
      process.env.NEXT_PUBLIC_LEGAL_COMPANY_EMAIL ||
      process.env.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL ||
      process.env.NEXT_PUBLIC_LEGAL_EMAIL ||
      null
    );
  }, [isPublisherSupplier]);
  const normalizedLegalNotice = useMemo(() => normalizeDocumentText(invoice?.legal_notice), [invoice?.legal_notice]);
  const normalizedDeliveryAddress = useMemo(
    () => normalizeDocumentText(invoice?.delivery_address),
    [invoice?.delivery_address],
  );
  const supplierAddress = useMemo(
    () => normalizeDocumentText(invoice?.supplier?.address) || normalizeDocumentText(supplierFallbackAddress),
    [invoice?.supplier?.address, supplierFallbackAddress],
  );
  const customerAddress = useMemo(
    () => normalizeDocumentText(invoice?.customer?.address),
    [invoice?.customer?.address],
  );

  const currency = invoice?.currency || "EUR";
  const money = (value: number) => formatCurrencyFr(Number(value || 0), currency);
  const paymentTrackingEnabled = invoice?.payment_tracking_enabled === true;
  const visibleInvoiceStatus =
    !paymentTrackingEnabled &&
    ["paid", "partial", "overdue", "refunded", "partially_refunded"].includes(
      String(invoice?.status || "").toLowerCase(),
    )
      ? "issued"
      : String(invoice?.status || "");
  const balanceDue = paymentTrackingEnabled ? Number(invoice?.totals?.balance_due || 0) : 0;
  const canPayByCard = Boolean(
    invoice?.card_payment_enabled &&
    !isCreditNote &&
    balanceDue > 0 &&
    !["draft", "canceled", "paid"].includes(visibleInvoiceStatus.toLowerCase()),
  );
  const paymentReturnConfirmed =
    paymentTrackingEnabled && paymentStatus === "success" && (balanceDue <= 0 || visibleInvoiceStatus === "paid");
  const supplierContactEmail = invoice?.supplier?.email || supplierFallbackEmail || supportEmail || null;
  const documentLabel = isCreditNote ? "Avoir" : "Facture";
  const issueDateLabel = invoice?.issue_date ? formatDateFr(invoice.issue_date) : "—";
  const serviceDateLabel = invoice?.service_date
    ? formatDateFr(invoice.service_date)
    : invoice?.issue_date
      ? formatDateFr(invoice.issue_date)
      : "—";
  const dueDateLabel = invoice?.due_date ? formatDateFr(invoice.due_date) : "—";
  const paymentTermsLabel = String(invoice?.payment_terms || "").trim() || "—";
  const supplierName = invoice?.supplier?.name || "Entreprise";
  const customerName = invoice?.customer?.name || "Client";
  const invoiceNumber = invoice?.number || "Brouillon";
  const supplierAddressLines = splitAddressLines(supplierAddress);
  const customerAddressLines = splitAddressLines(customerAddress);
  const isDomesticFrenchInvoice =
    hasFrenchPostalLine(supplierAddressLines) && hasFrenchPostalLine(customerAddressLines);
  const supplierLines = isDomesticFrenchInvoice ? stripDomesticFranceLine(supplierAddressLines) : supplierAddressLines;
  const customerLines = isDomesticFrenchInvoice ? stripDomesticFranceLine(customerAddressLines) : customerAddressLines;
  const deliveryAddressLines = useMemo(() => {
    const rawLines = splitAddressLines(normalizedDeliveryAddress);
    if (!rawLines.length) return [] as string[];
    return isDomesticFrenchInvoice ? stripDomesticFranceLine(rawLines) : rawLines;
  }, [normalizedDeliveryAddress, isDomesticFrenchInvoice]);
  const showDistinctDeliveryAddress = useMemo(() => {
    const delivery = normalizedDeliveryAddress.trim();
    const customer = customerAddress.trim();
    return Boolean(invoice?.delivery_address_differs) || Boolean(delivery && delivery !== customer);
  }, [invoice?.delivery_address_differs, normalizedDeliveryAddress, customerAddress]);
  const operationLabel = useMemo(() => operationNatureLabel(invoice?.operation_nature), [invoice?.operation_nature]);
  const paymentSupportItems = useMemo(() => {
    const items: Array<{ label: string; lines: string[] }> = [];
    if (showDistinctDeliveryAddress && deliveryAddressLines.length) {
      items.push({ label: "Adresse de livraison", lines: deliveryAddressLines });
    }
    if (invoice?.payment?.iban) items.push({ label: "IBAN", lines: [invoice.payment.iban] });
    if (invoice?.payment?.bic) items.push({ label: "BIC", lines: [invoice.payment.bic] });
    if (operationLabel) items.push({ label: "Nature de l’opération", lines: [operationLabel] });
    return items;
  }, [
    deliveryAddressLines,
    invoice?.payment?.bic,
    invoice?.payment?.iban,
    operationLabel,
    showDistinctDeliveryAddress,
  ]);
  const legalSupportItems = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];
    if (invoice?.has_facturx) {
      items.push({ label: "Factur-X", value: "Factur-X/XML à l'export" });
    }
    const vatSupportLabel =
      documentVatLegalLabel(invoice?.lines || [], invoice?.supplier).replace(/[.!?]+$/, "") ||
      (!isCreditNote ? "TVA exigible à l'encaissement" : "");
    if (vatSupportLabel) {
      items.push({ label: "TVA", value: vatSupportLabel });
    }
    if (invoice?.purchase_order_number) {
      items.push({ label: "Commande", value: String(invoice.purchase_order_number) });
    }
    const discountTerms = String(invoice?.supplier?.discount_terms || "").trim();
    const latePaymentInterest = String(invoice?.supplier?.late_payment_interest || "").trim();
    if (discountTerms) items.push({ label: "Escompte", value: discountTerms });
    if (latePaymentInterest) items.push({ label: "Pénalités de retard", value: latePaymentInterest });
    if (invoice?.supplier?.recovery_fee_eur != null) {
      items.push({
        label: "Indemnité forfaitaire",
        value: formatCurrencyFr(Number(invoice.supplier.recovery_fee_eur), currency),
      });
    }
    return items;
  }, [currency, invoice, isCreditNote]);
  const supplierLegalLine = useMemo(() => {
    const parts: string[] = [];
    const legalForm = String(invoice?.supplier?.legal_form || "").trim();
    const shareCapital = String(invoice?.supplier?.share_capital || "").trim();
    const rcs = String(invoice?.supplier?.rcs || "").trim();
    if (legalForm) parts.push(legalForm);
    if (shareCapital) parts.push(legalForm ? `au capital de ${shareCapital}` : `Capital : ${shareCapital}`);
    if (rcs) parts.push(`RCS ${rcs}`);
    return parts.join(" · ");
  }, [invoice?.supplier?.legal_form, invoice?.supplier?.rcs, invoice?.supplier?.share_capital]);
  const legalNoticeLines = useMemo(
    () =>
      normalizedLegalNotice
        ? normalizedLegalNotice
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    [normalizedLegalNotice],
  );
  const supplierMetaLine = useMemo(() => {
    const parts = [supplierName];
    if (invoice?.supplier?.siret) parts.push(`SIRET ${invoice.supplier.siret}`);
    if (invoice?.supplier?.vat_number) parts.push(`TVA ${invoice.supplier.vat_number}`);
    return parts.join(" — ");
  }, [invoice?.supplier?.siret, invoice?.supplier?.vat_number, supplierName]);
  const paidAmount = useMemo(
    () =>
      (paymentTrackingEnabled ? invoice?.payments || [] : []).reduce((sum, payment) => {
        const amount = Number(payment?.amount || 0);
        return Number.isFinite(amount) ? sum + amount : sum;
      }, 0),
    [invoice?.payments, paymentTrackingEnabled],
  );
  const paymentRows = useMemo(
    () =>
      (paymentTrackingEnabled ? invoice?.payments || [] : [])
        .map((payment, index) => ({
          id: `${payment.date || "payment"}-${index}`,
          label: publicPaymentLabel(payment),
          date: payment.date ? formatDateFr(payment.date) : "",
          amount: Number(payment.amount || 0),
          receiptUrl: payment.receipt_url || null,
          provider: String(payment.provider || "").toLowerCase(),
        }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [invoice?.payments, paymentTrackingEnabled],
  );
  const showBalanceDueRow = paymentTrackingEnabled && (Number(invoice?.totals?.prepaid || 0) > 0 || paidAmount > 0);
  const publicExpiryLabel = invoice?.public_expires_at ? formatDateFr(invoice.public_expires_at) : null;
  const publicExpiryMessage = useMemo(() => {
    if (!publicExpiryLabel) return null;
    const daysLeft = Number(invoice?.public_expires_in_days ?? 0);
    if (daysLeft <= 0) {
      return `Ce lien expire aujourd'hui. Téléchargez ou consultez la facture avant la fin de journée.`;
    }
    return `Ce lien reste disponible ${daysLeft} jour${daysLeft > 1 ? "s" : ""}, jusqu'au ${publicExpiryLabel}, pour consulter ou télécharger la facture.`;
  }, [invoice?.public_expires_in_days, publicExpiryLabel]);
  const publicExpiryShortLabel = useMemo(() => {
    if (!publicExpiryLabel) return null;
    const daysLeft = Number(invoice?.public_expires_in_days ?? 0);
    if (daysLeft <= 0) return "Aujourd'hui";
    return `${daysLeft} jour${daysLeft > 1 ? "s" : ""}`;
  }, [invoice?.public_expires_in_days, publicExpiryLabel]);
  const pageStyle = useMemo(
    () =>
      ({
        "--invoice-detail-scale": String(PORTAL_DOCUMENT_LOCKED_ZOOM),
        "--public-document-visual-width": `${Math.max(
          PORTAL_DOCUMENT_BASE_WIDTH,
          Math.round(PORTAL_DOCUMENT_BASE_WIDTH * PORTAL_DOCUMENT_LOCKED_ZOOM),
        )}px`,
      }) as CSSProperties,
    [],
  );

  const copyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setCopied(false);
    }
  };

  const startCardPayment = async () => {
    if (!invoice || !canPayByCard || payingByCard) return;
    setPayingByCard(true);
    setPaymentError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/invoices/${token}/pay/checkout`), {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) throw new Error(PORTAL_PAYMENT_UNAVAILABLE);
      const checkoutUrl = new URL(String(data.url));
      if (checkoutUrl.protocol !== "https:") throw new Error(PORTAL_PAYMENT_UNAVAILABLE);
      window.location.assign(checkoutUrl.toString());
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[public-invoice-payment] checkout unavailable", error);
      }
      setPaymentError(PORTAL_PAYMENT_UNAVAILABLE);
      setPayingByCard(false);
    }
  };

  const printDocument = () => {
    if (typeof window === "undefined") return;
    const opened = window.open(pdfHref, "_blank");
    if (opened) opened.opener = null;
    if (!opened) window.location.href = pdfHref;
  };

  return (
    <div className={cx(styles.page, isDraft && styles.pageDraft)} style={pageStyle}>
      {loading ? (
        <div className={styles.stateCard}>Chargement…</div>
      ) : error ? (
        <div className={styles.stateCard}>
          <strong>Accès indisponible</strong>
          <p>{error}</p>
        </div>
      ) : !invoice ? (
        <div className={styles.stateCard}>Introuvable</div>
      ) : (
        <>
          <h1 className="sr-only">{`${documentLabel} ${invoiceNumber}`.trim()}</h1>
          <PdfViewerModal
            open={previewOpen}
            title={`${documentLabel} ${invoiceNumber}`.trim()}
            src={previewHtmlHref}
            openInNewTabHref={previewHtmlHref}
            onClose={() => setPreviewOpen(false)}
          />

          <header className={styles.header}>
            <div className={styles.headerProgress} />
            <div className={styles.headerInner}>
              <div className={styles.headerLeft}>
                <div className={styles.brandInline}>
                  <span className={styles.pixFactureLogo} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/favicon.svg" alt="" className={styles.pixFactureLogoImg} />
                  </span>
                  <span className={styles.brandName}>{PIXFACTURE_BRAND_NAME}</span>
                </div>
              </div>

              <div className={styles.headerActions}>
                {canPayByCard ? (
                  <button
                    type="button"
                    className={cx(styles.actionButton, styles.actionPrimary)}
                    onClick={() => void startCardPayment()}
                    disabled={payingByCard}
                  >
                    <CreditCard size={13} />
                    <span>{payingByCard ? "Ouverture…" : `Payer ${money(balanceDue)}`}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={cx(styles.actionButton, copied && styles.actionSuccess, styles.desktopOnlyButton)}
                  onClick={copyLink}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? "Copié !" : "Copier le lien"}</span>
                </button>

                <details className={styles.menu}>
                  <summary className={cx(styles.actionButton, styles.actionPrimary)}>
                    <Download size={13} />
                    <span>Télécharger</span>
                    <span className={styles.caret}>▾</span>
                  </summary>
                  <div className={styles.menuPanel}>
                    <button type="button" className={styles.menuItem} onClick={() => setPreviewOpen(true)}>
                      <div className={styles.menuIcon}>
                        <FileText size={15} />
                      </div>
                      <div>
                        <p className={styles.menuLabel}>Aperçu du document</p>
                        <p className={styles.menuDesc}>Rendu identique au document</p>
                      </div>
                    </button>

                    <a className={styles.menuItem} href={pdfHref} target="_blank" rel="noreferrer">
                      <div className={styles.menuIcon}>
                        <Download size={15} />
                      </div>
                      <div>
                        <p className={styles.menuLabel}>Télécharger PDF</p>
                        <p className={styles.menuDesc}>Version imprimable A4</p>
                      </div>
                    </a>

                    {invoice.has_facturx ? (
                      <a className={styles.menuItem} href={facturxUrl} target="_blank" rel="noreferrer">
                        <div className={styles.menuIcon}>
                          <BadgeCheck size={15} />
                        </div>
                        <div>
                          <p className={styles.menuLabel}>Export structuré</p>
                          <p className={styles.menuDesc}>Factur-X/XML à l'export</p>
                        </div>
                      </a>
                    ) : null}

                    <a className={styles.menuItem} href={bundleHref} target="_blank" rel="noreferrer">
                      <div className={styles.menuIcon}>
                        <Archive size={15} />
                      </div>
                      <div>
                        <p className={styles.menuLabel}>Dossier ZIP client</p>
                        <p className={styles.menuDesc}>Document et pièces jointes</p>
                      </div>
                    </a>

                    <button type="button" className={styles.menuItem} onClick={printDocument}>
                      <div className={styles.menuIcon}>
                        <Printer size={15} />
                      </div>
                      <div>
                        <p className={styles.menuLabel}>Imprimer</p>
                        <p className={styles.menuDesc}>Ouvrir le PDF imprimable</p>
                      </div>
                    </button>

                    <div className={styles.menuFoot}>
                      <BadgeCheck size={13} />
                      <p>{invoice.has_facturx ? "Export structuré disponible" : "Version PDF officielle"}</p>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </header>

          <main className={styles.main}>
            {paymentTrackingEnabled && paymentStatus === "success" ? (
              <div
                className={cx(styles.paymentReturnNotice, paymentReturnConfirmed && styles.paymentReturnNoticeSuccess)}
                role="status"
                aria-live="polite"
              >
                <div>
                  <strong>{paymentReturnConfirmed ? "Paiement confirmé" : "Paiement en cours de confirmation"}</strong>
                  <p>
                    {paymentReturnConfirmed
                      ? "La facture est à jour."
                      : "Le prestataire de paiement a renvoyé vers cette page. Le règlement sera confirmé ici après confirmation sécurisée du prestataire."}
                  </p>
                </div>
                {!paymentReturnConfirmed ? (
                  <button type="button" onClick={() => void load()} disabled={loading}>
                    Vérifier le règlement
                  </button>
                ) : null}
              </div>
            ) : null}
            {paymentTrackingEnabled && paymentStatus === "cancel" ? (
              <div className={styles.paymentReturnNotice} role="status">
                <div>
                  <strong>Paiement non finalisé</strong>
                  <p>Aucun règlement n’est enregistré. Vous pouvez reprendre le paiement quand vous le souhaitez.</p>
                </div>
              </div>
            ) : null}
            {paymentTrackingEnabled && paymentError ? (
              <div className={styles.paymentError} role="alert">
                {paymentError}
              </div>
            ) : null}
            <div
              className={cx(
                styles.documentPresentationGrid,
                !publicExpiryMessage && styles.documentPresentationGridSolo,
              )}
            >
              <div className={styles.documentPresentationMain}>
                <PortalDocumentFrame
                  src={previewHtmlHref}
                  title={`${documentLabel} ${invoiceNumber}`.trim()}
                  viewportClassName={styles.serverDocumentViewport}
                  shellClassName={styles.serverDocumentFrameShell}
                  frameClassName={styles.serverDocumentFrame}
                  data-testid="public-invoice-document"
                />

                <div className={styles.legacyDocumentFallback} aria-hidden="true">
                  <article className={styles.document}>
                    <div className={styles.documentAccent} />
                    <div className={styles.documentWatermark}>{invoiceNumber}</div>
                    {visibleInvoiceStatus === "paid" ? <div className={styles.documentStamp}>PAYÉE</div> : null}

                    <div className={styles.documentHeader}>
                      <div className={styles.documentCompany}>
                        <VisualAvatar name={supplierName} logoUrl={invoice?.supplier?.logo_url} hero />
                      </div>

                      <div className={styles.documentTitleBlock}>
                        <p className={styles.overline}>{documentLabel}</p>
                        <p className={styles.documentReference}>{invoiceNumber}</p>
                        <div className={styles.documentStatus}>
                          <StatusBadge status={visibleInvoiceStatus} />
                        </div>
                      </div>
                    </div>

                    <div className={styles.documentDivider} />

                    <div className={styles.metaGrid}>
                      <div className={styles.metaCard}>
                        <div className={styles.metaCardLabel}>
                          <Calendar size={12} />
                          <span>Date d’émission</span>
                        </div>
                        <p className={styles.metaCardValue}>{issueDateLabel}</p>
                      </div>
                      <div className={styles.metaCard}>
                        <div className={styles.metaCardLabel}>
                          <Calendar size={12} />
                          <span>Date de prestation</span>
                        </div>
                        <p className={styles.metaCardValue}>{serviceDateLabel}</p>
                      </div>
                      <div className={styles.metaCard}>
                        <div className={styles.metaCardLabel}>
                          <Clock3 size={12} />
                          <span>Échéance</span>
                        </div>
                        <p className={styles.metaCardValue}>{dueDateLabel}</p>
                      </div>
                      <div className={styles.metaCard}>
                        <div className={styles.metaCardLabel}>
                          <FileText size={12} />
                          <span>Conditions</span>
                        </div>
                        <p className={styles.metaCardValue}>{paymentTermsLabel}</p>
                      </div>
                    </div>

                    <div className={styles.parties}>
                      <PartyCard
                        role="Émetteur"
                        name={supplierName}
                        lines={supplierLines}
                        siren={invoice.supplier?.siren}
                        siret={invoice.supplier?.siret}
                        vat={invoice.supplier?.vat_number}
                        email={supplierContactEmail}
                        phone={invoice.supplier?.phone}
                      />

                      <div className={styles.partiesArrow}>
                        <div className={styles.partiesLine} />
                        <div className={styles.partiesBubble}>
                          <ArrowRight size={15} />
                        </div>
                        <div className={styles.partiesLine} />
                      </div>

                      <PartyCard
                        role="Facturé à"
                        name={customerName}
                        lines={customerLines}
                        siren={invoice.customer?.siren}
                        siret={invoice.customer?.siret}
                        vat={invoice.customer?.vat_number}
                        email={invoice.customer?.email}
                        phone={invoice.customer?.phone}
                        clientType={invoice.customer?.client_type}
                        accent
                      />
                    </div>

                    <section className={styles.section}>
                      <p className={cx(styles.overline, styles.overlineMuted)}>Détail des prestations</p>

                      <div className={cx(styles.tableWrap, styles.tableDesktop)}>
                        <table className={styles.table}>
                          <colgroup>
                            <col className={styles.colIndex} />
                            <col className={styles.colReference} />
                            <col className={styles.colProduct} />
                            <col className={styles.colQty} />
                            <col className={styles.colUnitPrice} />
                            <col className={styles.colVat} />
                            <col className={styles.colAmount} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th className={cx(styles.isNarrow, styles.isCenter)}>#</th>
                              <th>Référence</th>
                              <th>Produit / Service</th>
                              <th className={styles.isCenter}>Qté</th>
                              <th className={styles.isRight}>PU HT</th>
                              <th className={styles.isRight}>TVA</th>
                              <th className={styles.isRight}>Total HT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {invoice.lines.map((line, index) => {
                              const lineKind = String(line.line_type || "item").toLowerCase();
                              const detail = String(line.detail || "").trim();
                              const productName = line.product_name || `Ligne ${index + 1}`;
                              if (lineKind === "comment" || lineKind === "section" || lineKind === "title") {
                                return (
                                  <tr key={`${productName}-${index}`} className={styles.tableSpecialRow}>
                                    <td colSpan={7}>
                                      <p
                                        className={cx(
                                          styles.tableTitle,
                                          (lineKind === "section" || lineKind === "title") && styles.tableSectionTitle,
                                        )}
                                      >
                                        {productName}
                                      </p>
                                      {detail && detail !== productName ? (
                                        <p className={styles.tableDetail}>{detail}</p>
                                      ) : null}
                                    </td>
                                  </tr>
                                );
                              }
                              const itemNumber = invoice.lines.slice(0, index + 1).filter((candidate) => {
                                const kind = String(candidate.line_type || "item").toLowerCase();
                                return kind !== "comment" && kind !== "section" && kind !== "title";
                              }).length;
                              return (
                                <tr key={`${productName}-${index}`}>
                                  <td className={styles.isCenter}>
                                    <span className={styles.tableIndex}>{itemNumber}</span>
                                  </td>
                                  <td>
                                    <span className={styles.tableReference}>{line.reference || "—"}</span>
                                  </td>
                                  <td>
                                    <p className={styles.tableTitle}>{productName}</p>
                                    {detail && detail !== productName ? (
                                      <p className={styles.tableDetail}>{detail}</p>
                                    ) : null}
                                  </td>
                                  <td className={styles.isCenter}>{formatQuantity(line.quantity)}</td>
                                  <td className={styles.isRight}>{money(line.unit_price)}</td>
                                  <td className={styles.isRight}>
                                    <span className={styles.tableVat}>{formatPercentCompactFr(line.vat_rate)}</span>
                                    {vatLineReasonLabel(line, invoice.supplier) ? (
                                      <span className={styles.tableDetail}>
                                        {vatLineReasonLabel(line, invoice.supplier)}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td className={styles.isRight}>
                                    <span className={styles.tableAmount}>{money(line.line_total)}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className={styles.tableMobile}>
                        {invoice.lines.map((line, index) => {
                          const lineKind = String(line.line_type || "item").toLowerCase();
                          if (lineKind === "comment" || lineKind === "section" || lineKind === "title") {
                            return (
                              <div key={`${line.product_name}-mobile-${index}`} className={styles.mobileCard}>
                                <p
                                  className={cx(
                                    styles.tableTitle,
                                    (lineKind === "section" || lineKind === "title") && styles.tableSectionTitle,
                                  )}
                                >
                                  {line.product_name}
                                </p>
                                {line.detail && line.detail !== line.product_name ? (
                                  <p className={styles.tableDetail}>{line.detail}</p>
                                ) : null}
                              </div>
                            );
                          }
                          return (
                            <div key={`${line.product_name}-mobile-${index}`} className={styles.mobileCard}>
                              <div className={styles.mobileHead}>
                                <div>
                                  <p className={styles.tableReference}>{line.reference || "—"}</p>
                                  <p className={styles.tableTitle}>{line.product_name}</p>
                                  {line.detail ? <p className={styles.tableDetail}>{line.detail}</p> : null}
                                </div>
                                <p className={styles.tableAmount}>{money(line.line_total)}</p>
                              </div>
                              <div className={styles.mobileMeta}>
                                <span>
                                  Qté : <strong>{formatQuantity(line.quantity)}</strong>
                                </span>
                                <span>
                                  PU : <strong>{money(line.unit_price)}</strong>
                                </span>
                                <span>
                                  TVA : <strong>{formatPercentCompactFr(line.vat_rate)}</strong>
                                </span>
                                {vatLineReasonLabel(line, invoice.supplier) ? (
                                  <span>
                                    Motif : <strong>{vatLineReasonLabel(line, invoice.supplier)}</strong>
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className={styles.totalsWrap}>
                        <div className={styles.totals}>
                          <div className={styles.totalsRow}>
                            <span>{(invoice.totals.allowance || 0) > 0 ? "Sous-total HT" : "Total HT"}</span>
                            <strong>{money(invoice.totals.total_ex_vat + (invoice.totals.allowance || 0))}</strong>
                          </div>
                          {(invoice.totals.allowance || 0) > 0 ? (
                            <div className={styles.totalsRow}>
                              <span>Remises HT</span>
                              <strong>- {money(invoice.totals.allowance || 0)}</strong>
                            </div>
                          ) : null}
                          <div className={styles.totalsRow}>
                            <span>TVA ({formatPercentCompactFr(invoice.lines[0]?.vat_rate || 0)})</span>
                            <strong>+ {money(invoice.totals.total_vat)}</strong>
                          </div>
                          <div className={cx(styles.totalsRow, styles.totalsRowTotal)}>
                            <div className={styles.totalsAccent} />
                            <span>Total TTC</span>
                            <strong>{money(invoice.totals.total_inc_vat)}</strong>
                          </div>
                          {(invoice.totals.prepaid || 0) > 0 ? (
                            <div className={styles.totalsRow}>
                              <span>Acompte déjà versé</span>
                              <strong>- {money(invoice.totals.prepaid || 0)}</strong>
                            </div>
                          ) : null}
                          {showBalanceDueRow ? (
                            <div className={cx(styles.totalsRow, styles.totalsRowPaid)}>
                              <div className={styles.paidLabel}>
                                <CheckCircle2 size={14} />
                                <span>Reste dû</span>
                              </div>
                              <strong>{money(balanceDue)}</strong>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </section>

                    {paymentSupportItems.length && legalSupportItems.length ? (
                      <div className={styles.supportGrid}>
                        <div className={styles.supportCard}>
                          <p className={cx(styles.overline, styles.overlineMuted)}>Livraison / paiement</p>
                          <div className={styles.supportCopy}>
                            {paymentSupportItems.map((item, index) => (
                              <div key={`support-payment-${index}`} className={styles.supportRow}>
                                <span className={styles.supportLabel}>{item.label} :</span>
                                <div className={styles.supportValue}>
                                  {item.lines.map((line, lineIndex) => (
                                    <p key={`support-payment-line-${index}-${lineIndex}`}>{line}</p>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className={styles.supportCard}>
                          <p className={cx(styles.overline, styles.overlineMuted)}>Mentions légales</p>
                          <div className={styles.supportCopy}>
                            {legalSupportItems.map((item, index) => (
                              <div key={`support-legal-${index}`} className={styles.supportRow}>
                                <span className={styles.supportLabel}>{item.label} :</span>
                                <div className={styles.supportValue}>
                                  <p>{item.value}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : paymentSupportItems.length ? (
                      <section className={cx(styles.supportCard, styles.supportSection)}>
                        <p className={cx(styles.overline, styles.overlineMuted)}>Livraison / paiement</p>
                        <div className={styles.supportCopy}>
                          {paymentSupportItems.map((item, index) => (
                            <div key={`support-payment-${index}`} className={styles.supportRow}>
                              <span className={styles.supportLabel}>{item.label} :</span>
                              <div className={styles.supportValue}>
                                {item.lines.map((line, lineIndex) => (
                                  <p key={`support-payment-line-${index}-${lineIndex}`}>{line}</p>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : legalSupportItems.length ? (
                      <section className={cx(styles.supportCard, styles.supportSection)}>
                        <p className={cx(styles.overline, styles.overlineMuted)}>Mentions légales</p>
                        <div className={styles.supportCopy}>
                          {legalSupportItems.map((item, index) => (
                            <div key={`support-legal-${index}`} className={styles.supportRow}>
                              <span className={styles.supportLabel}>{item.label} :</span>
                              <div className={styles.supportValue}>
                                <p>{item.value}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {normalizedNote ? (
                      <div className={styles.noteSection}>
                        <div className={styles.noteText}>
                          {normalizedNote.split("\n").map((line, index) => (
                            <p key={`note-${index}`}>{line}</p>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {paymentRows.length ? (
                      <div className={styles.paymentHistoryCard}>
                        <p className={styles.paymentHistoryTitle}>Paiements enregistrés</p>
                        <div className={styles.paymentHistoryList}>
                          {paymentRows.map((payment) => (
                            <div key={payment.id} className={styles.paymentHistoryRow}>
                              <div className={styles.paymentHistoryMain}>
                                <span className={styles.paymentHistoryLabel}>{payment.label}</span>
                                {payment.date ? (
                                  <span className={styles.paymentHistoryDate}>{payment.date}</span>
                                ) : null}
                                {payment.receiptUrl ? (
                                  <a
                                    className={styles.paymentReceiptLink}
                                    href={payment.receiptUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Reçu Stripe
                                  </a>
                                ) : null}
                              </div>
                              <span
                                className={
                                  payment.amount < 0 ? styles.paymentHistoryAmountNegative : styles.paymentHistoryAmount
                                }
                              >
                                {money(payment.amount)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className={styles.legalNoticeCard}>
                      {supplierLegalLine ? <p>{supplierLegalLine}</p> : null}
                      {legalNoticeLines.map((line, index) => (
                        <p key={`legal-notice-${index}`}>{line}</p>
                      ))}
                      <p className={styles.documentFooterMeta}>{supplierMetaLine}</p>
                    </div>
                  </article>
                </div>
              </div>

              {publicExpiryMessage ? (
                <aside className={styles.documentSideRail} aria-label="Disponibilité du lien public">
                  <section className={styles.publicPresentationPanel} aria-label="Présentation du lien public">
                    <div className={styles.publicValidityCard}>
                      <div className={styles.publicValidityHeader}>
                        <span className={styles.publicValidityIcon}>
                          <Clock3 size={15} />
                        </span>
                        <div>
                          <p>Lien de consultation</p>
                          {publicExpiryShortLabel ? <strong>{publicExpiryShortLabel}</strong> : null}
                        </div>
                      </div>
                      <p>
                        Disponible jusqu'au <strong>{publicExpiryLabel}</strong>.
                      </p>
                      <small>Consultation et téléchargement restent actifs pendant cette période.</small>
                    </div>
                  </section>
                </aside>
              ) : null}
            </div>

            {invoice.attachments?.length ? (
              <section className={styles.supportCard}>
                <p className={cx(styles.overline, styles.overlineMuted)}>Documents associés à la facture</p>
                <div className="mt-10">
                  <PortalAttachments attachments={invoice.attachments || []} />
                </div>
              </section>
            ) : null}
          </main>
        </>
      )}
    </div>
  );
}
