"use client";

import { type CSSProperties, use, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  FileText,
  Info,
  Mail,
  MapPin,
  Phone,
  Printer,
} from "lucide-react";
import { apiUrl, fetchWithTimeout } from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { publicDocumentStatusLabel } from "@/lib/publicDocumentStatus";
import PdfViewerModal from "@/components/PdfViewerModal";
import PortalDocumentFrame from "@/components/PortalDocumentFrame";
import PortalAttachments from "@/components/PortalAttachments";
import { QuoteResponsePanel } from "../../components/QuoteResponsePanel";
import { documentVatLegalLabel, vatLineReasonLabel } from "@/lib/vatReason";
import {
  PORTAL_ACTION_UNAVAILABLE,
  PORTAL_DOCUMENT_UNAVAILABLE,
  portalErrorMessage,
  portalResponseMessage,
} from "@/lib/publicPortalErrors";
import styles from "../../i/[token]/page.module.css";

type PublicQuote = {
  number?: string | null;
  currency: string;
  status: string;
  issue_date?: string | null;
  service_date?: string | null;
  valid_until?: string | null;
  payment_terms?: string | null;
  delivery_address?: string | null;
  delivery_address_differs?: boolean | null;
  operation_nature?: string | null;
  purchase_order_number?: string | null;
  acceptance_mode?: string | null;
  terms_url?: string | null;
  terms_required?: boolean | null;
  legal_notice?: string | null;
  payment_iban?: string | null;
  payment_bic?: string | null;
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
    portal_theme?: string | null;
    portal_support_email?: string | null;
    portal_footer_note?: string | null;
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
  lines: Array<{
    line_type?: string | null;
    product_name: string;
    detail?: string | null;
    quantity: number;
    unit_price: number;
    vat_rate: number;
    vat_category?: string | null;
    exemption_reason_code?: string | null;
    line_total: number;
  }>;
  totals: {
    total_ex_vat: number;
    total_vat: number;
    total_inc_vat: number;
  };
  requested_advance?: {
    label?: string | null;
    reference?: string | null;
    amount_ht?: number | null;
    amount_vat?: number | null;
    amount_ttc?: number | null;
    vat_rate?: number | null;
  } | null;
  note?: string | null;
  accepted_at?: string | null;
  accepted_name?: string | null;
  accepted_terms_at?: string | null;
  rejected_at?: string | null;
  rejected_reason?: string | null;
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
const DEFAULT_TERMS_URL = "/legal/cgv";

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isPublicQuotePayload = (value: unknown): value is PublicQuote => {
  if (!isRecord(value)) return false;
  if (!isRecord(value.supplier) || !isRecord(value.customer) || !isRecord(value.totals)) return false;
  if (!Array.isArray(value.lines)) return false;
  return typeof value.totals.total_inc_vat !== "undefined";
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const statusLabel = (status: string) => publicDocumentStatusLabel(status, "quote");

const statusTone = (status: string): StatusTone => {
  if (status === "accepted" || status === "invoiced") return "paid";
  if (status === "sent") return "sent";
  if (status === "rejected" || status === "expired") return "overdue";
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
  const Icon = tone === "paid" ? CheckCircle2 : tone === "overdue" ? Info : Info;

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

export default function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [loading, setLoading] = useState(true);
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"none" | "accept" | "reject">("none");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpExpiresAt, setOtpExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<"otp" | "accept" | "reject" | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const portalBaseHref = `/q/${encodeURIComponent(token)}`;
  const previewHtmlHref = `${portalBaseHref}/preview.html`;
  const pdfHref = `${portalBaseHref}/pdf`;
  const bundleHref = `${portalBaseHref}/bundle`;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/quotes/${token}`), {
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) {
        throw new Error(await portalResponseMessage(res, PORTAL_DOCUMENT_UNAVAILABLE));
      }
      const data = await res.json();
      if (!isPublicQuotePayload(data)) {
        throw new Error(PORTAL_DOCUMENT_UNAVAILABLE);
      }
      setQuote(data);
      setDecision("none");
    } catch (e: any) {
      setQuote(null);
      setError(portalErrorMessage(e?.message, PORTAL_DOCUMENT_UNAVAILABLE));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const canDecide = useMemo(() => {
    if (!quote) return false;
    return String(quote.status || "") === "sent";
  }, [quote]);

  const requiresOtp = useMemo(() => {
    return (quote?.acceptance_mode || "simple").toLowerCase() === "otp";
  }, [quote]);

  const termsUrl = useMemo(() => String(quote?.terms_url || "").trim(), [quote?.terms_url]);
  const termsHref = termsUrl || DEFAULT_TERMS_URL;

  const currency = quote?.currency || "EUR";
  const money = (value: number) => formatCurrencyFr(Number(value || 0), currency);

  const supportEmail = useMemo(() => {
    const emailValue = String(quote?.supplier?.portal_support_email || "").trim();
    return emailValue || null;
  }, [quote?.supplier?.portal_support_email]);
  const isPublisherSupplier = useMemo(
    () => /entreprise-exemple/i.test(String(quote?.supplier?.name || "")),
    [quote?.supplier?.name],
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

  const normalizedNote = useMemo(() => normalizeDocumentText(quote?.note), [quote?.note]);
  const normalizedLegalNotice = useMemo(() => normalizeDocumentText(quote?.legal_notice), [quote?.legal_notice]);
  const normalizedDeliveryAddress = useMemo(
    () => normalizeDocumentText(quote?.delivery_address),
    [quote?.delivery_address],
  );
  const supplierAddress = useMemo(
    () => normalizeDocumentText(quote?.supplier?.address) || normalizeDocumentText(supplierFallbackAddress),
    [quote?.supplier?.address, supplierFallbackAddress],
  );
  const customerAddress = useMemo(() => normalizeDocumentText(quote?.customer?.address), [quote?.customer?.address]);

  const supplierName = quote?.supplier?.name || "Entreprise";
  const customerName = quote?.customer?.name || "Client";
  const quoteNumber = quote?.number || "Brouillon";
  const supplierContactEmail = quote?.supplier?.email || supplierFallbackEmail || supportEmail || null;
  const supplierAddressLines = splitAddressLines(supplierAddress);
  const customerAddressLines = splitAddressLines(customerAddress);
  const isDomesticFrenchDocument =
    hasFrenchPostalLine(supplierAddressLines) && hasFrenchPostalLine(customerAddressLines);
  const supplierLines = isDomesticFrenchDocument ? stripDomesticFranceLine(supplierAddressLines) : supplierAddressLines;
  const customerLines = isDomesticFrenchDocument ? stripDomesticFranceLine(customerAddressLines) : customerAddressLines;
  const deliveryAddressLines = useMemo(() => {
    const rawLines = splitAddressLines(normalizedDeliveryAddress);
    if (!rawLines.length) return [] as string[];
    return isDomesticFrenchDocument ? stripDomesticFranceLine(rawLines) : rawLines;
  }, [isDomesticFrenchDocument, normalizedDeliveryAddress]);
  const showDeliveryAddress = Boolean(quote?.delivery_address_differs || normalizedDeliveryAddress);
  const showDistinctDeliveryAddress = useMemo(() => {
    const delivery = normalizedDeliveryAddress.trim();
    const customerValue = customerAddress.trim();
    return Boolean(quote?.delivery_address_differs) || Boolean(delivery && delivery !== customerValue);
  }, [customerAddress, normalizedDeliveryAddress, quote?.delivery_address_differs]);
  const operationLabel = useMemo(() => operationNatureLabel(quote?.operation_nature), [quote?.operation_nature]);
  const supplierLegalLine = useMemo(() => {
    const parts: string[] = [];
    const legalForm = String(quote?.supplier?.legal_form || "").trim();
    const shareCapital = String(quote?.supplier?.share_capital || "").trim();
    const rcs = String(quote?.supplier?.rcs || "").trim();
    if (legalForm) parts.push(legalForm);
    if (shareCapital) parts.push(legalForm ? `au capital de ${shareCapital}` : `Capital : ${shareCapital}`);
    if (rcs) parts.push(`RCS ${rcs}`);
    return parts.join(" · ");
  }, [quote?.supplier?.legal_form, quote?.supplier?.rcs, quote?.supplier?.share_capital]);
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
    if (quote?.supplier?.siret) parts.push(`SIRET ${quote.supplier.siret}`);
    if (quote?.supplier?.vat_number) parts.push(`TVA ${quote.supplier.vat_number}`);
    return parts.join(" — ");
  }, [quote?.supplier?.siret, quote?.supplier?.vat_number, supplierName]);
  const paymentSupportItems = useMemo(() => {
    const items: Array<{ label: string; lines: string[] }> = [];
    if (showDeliveryAddress) {
      items.push({
        label: "Adresse de livraison",
        lines:
          showDistinctDeliveryAddress && deliveryAddressLines.length
            ? deliveryAddressLines
            : ["identique à la facturation"],
      });
    }
    if (quote?.payment_iban) items.push({ label: "IBAN", lines: [quote.payment_iban] });
    if (quote?.payment_bic) items.push({ label: "BIC", lines: [quote.payment_bic] });
    if (operationLabel) items.push({ label: "Nature de l’opération", lines: [operationLabel] });
    return items;
  }, [
    deliveryAddressLines,
    operationLabel,
    quote?.payment_bic,
    quote?.payment_iban,
    showDeliveryAddress,
    showDistinctDeliveryAddress,
  ]);
  const legalSupportItems = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];
    const vatSupportLabel =
      documentVatLegalLabel(quote?.lines || [], quote?.supplier).replace(/[.!?]+$/, "") ||
      "TVA exigible à l'encaissement";
    if (vatSupportLabel) {
      items.push({ label: "TVA", value: vatSupportLabel });
    }
    if (quote?.purchase_order_number) {
      items.push({ label: "Commande", value: String(quote.purchase_order_number) });
    }
    items.push({ label: "Escompte", value: String(quote?.supplier?.discount_terms || "Néant") });
    items.push({
      label: "Pénalités de retard",
      value: String(quote?.supplier?.late_payment_interest || "Non renseigné"),
    });
    items.push({
      label: "Indemnité forfaitaire",
      value: formatCurrencyFr(Number(quote?.supplier?.recovery_fee_eur ?? 40), currency),
    });
    return items;
  }, [currency, quote?.lines, quote?.purchase_order_number, quote?.supplier]);
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
      setInfo("Lien copié.");
      window.setTimeout(() => setCopied(false), 2400);
      window.setTimeout(() => setInfo(null), 1800);
    } catch {
      setCopied(false);
      setInfo("Impossible de copier le lien.");
    }
  };

  const printDocument = () => {
    if (typeof window === "undefined") return;
    const opened = window.open(pdfHref, "_blank");
    if (opened) opened.opener = null;
    if (!opened) window.location.href = pdfHref;
  };

  async function requestOtp() {
    if (!email.trim()) {
      setInfo("Veuillez saisir votre email pour recevoir un code.");
      return;
    }
    setInfo(null);
    setBusy("otp");
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/quotes/${token}/otp`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(PORTAL_ACTION_UNAVAILABLE);
      }
      setOtpSent(true);
      setOtpExpiresAt(data?.expires_at || null);
      setInfo(
        data?.delivery === "log_only"
          ? "Code préparé. Si vous ne le recevez pas, contactez l'émetteur du devis."
          : "Code envoyé. Vérifiez vos emails.",
      );
    } catch (e: any) {
      setInfo(PORTAL_ACTION_UNAVAILABLE);
    } finally {
      setBusy(null);
    }
  }

  async function accept() {
    if (!name.trim()) {
      setInfo("Veuillez saisir votre nom.");
      return;
    }
    if (!termsAccepted) {
      setInfo("Vous devez accepter les conditions de vente.");
      return;
    }
    if (requiresOtp) {
      if (!email.trim()) {
        setInfo("Une adresse email est nécessaire pour recevoir le code de confirmation.");
        return;
      }
      if (!otpCode.trim() || otpCode.trim().length !== 6) {
        setInfo("Veuillez saisir le code de confirmation à 6 chiffres.");
        return;
      }
    }
    setInfo(null);
    setBusy("accept");
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/quotes/${token}/accept`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
          otp_code: requiresOtp ? otpCode.trim() : null,
          terms_accepted: termsAccepted,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(PORTAL_ACTION_UNAVAILABLE);
      }
      setQuote(data);
      setDecision("none");
      setInfo("Merci. Votre acceptation a été enregistrée.");
    } catch (e: any) {
      setInfo(PORTAL_ACTION_UNAVAILABLE);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!name.trim()) {
      setInfo("Veuillez saisir votre nom.");
      return;
    }
    setInfo(null);
    setBusy("reject");
    try {
      const res = await fetchWithTimeout(apiUrl(`/api/public/quotes/${token}/reject`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ name: name.trim(), reason: reason.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(PORTAL_ACTION_UNAVAILABLE);
      }
      setQuote(data);
      setDecision("none");
      setInfo("Le refus a été enregistré.");
    } catch (e: any) {
      setInfo(PORTAL_ACTION_UNAVAILABLE);
    } finally {
      setBusy(null);
    }
  }

  const issueDateLabel = quote?.issue_date ? formatDateFr(quote.issue_date) : "—";
  const serviceDateLabel = quote?.service_date ? formatDateFr(quote.service_date) : "Non précisée";
  const validUntilLabel = quote?.valid_until ? formatDateFr(quote.valid_until) : "À définir";
  const paymentTermsLabel = String(quote?.payment_terms || "").trim() || "Non renseignées";

  return (
    <div className={cx(styles.page, styles.pageQuote)} style={pageStyle}>
      <h1 className="sr-only">{quote ? `Devis ${quoteNumber}` : "Consultation du devis"}</h1>
      {loading ? (
        <div className={styles.stateCard}>Chargement…</div>
      ) : error ? (
        <div className={styles.stateCard}>{error}</div>
      ) : !quote ? (
        <div className={styles.stateCard}>Devis introuvable</div>
      ) : (
        <>
          <PdfViewerModal
            open={previewOpen}
            title={`Devis ${quoteNumber}`.trim()}
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
                <button
                  type="button"
                  className={cx(styles.actionButton, copied && styles.actionSuccess, styles.desktopOnlyButton)}
                  onClick={copyLink}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? "Lien copié" : "Copier le lien"}</span>
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

                    <a className={styles.menuItem} href={bundleHref} target="_blank" rel="noreferrer">
                      <div className={styles.menuIcon}>
                        <Archive size={15} />
                      </div>
                      <div>
                        <p className={styles.menuLabel}>Dossier ZIP client</p>
                        <p className={styles.menuDesc}>PDF et pièces jointes</p>
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
                      <CheckCircle2 size={13} />
                      <p>Lien personnel de consultation</p>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </header>

          <main className={styles.main}>
            <div
              className={cx(
                styles.documentPresentationGrid,
                !canDecide && !info && !quote.attachments?.length && styles.documentPresentationGridSolo,
              )}
            >
              <div className={styles.documentPresentationMain}>
                <PortalDocumentFrame
                  src={previewHtmlHref}
                  title={`Devis ${quoteNumber}`.trim()}
                  viewportClassName={styles.serverDocumentViewport}
                  shellClassName={styles.serverDocumentFrameShell}
                  frameClassName={styles.serverDocumentFrame}
                  data-testid="public-quote-document"
                />

                <div className={styles.legacyDocumentFallback} aria-hidden="true">
                  <article className={styles.document}>
                    <div className={styles.documentAccent} />
                    <div className={styles.documentWatermark}>{quoteNumber}</div>
                    {quote.status === "accepted" ? <div className={styles.documentStamp}>ACCEPTÉ</div> : null}

                    <div className={styles.documentHeader}>
                      <div className={styles.documentCompany}>
                        <VisualAvatar name={supplierName} logoUrl={quote.supplier.logo_url} hero />
                        <div>
                          <p className={styles.documentCompanyName}>{supplierName}</p>
                          {supplierLines.length ? (
                            <div className={styles.documentCompanyLines}>
                              {supplierLines.map((line, index) => (
                                <p key={`supplier-${index}`}>{line}</p>
                              ))}
                            </div>
                          ) : null}
                          {supplierContactEmail ? (
                            <p className={styles.documentCompanyEmail}>{supplierContactEmail}</p>
                          ) : null}
                        </div>
                      </div>

                      <div className={styles.documentTitleBlock}>
                        <p className={styles.overline}>Devis</p>
                        <p className={styles.documentReference}>{quoteNumber}</p>
                        <div className={styles.documentStatus}>
                          <StatusBadge status={quote.status} />
                        </div>
                      </div>
                    </div>

                    <div className={styles.documentDivider} />

                    <div className={styles.metaGrid}>
                      <div className={styles.metaCard}>
                        <div className={styles.metaCardLabel}>
                          <Calendar size={12} />
                          <span>Date du devis</span>
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
                          <span>Valable jusqu&apos;au</span>
                        </div>
                        <p className={styles.metaCardValue}>{validUntilLabel}</p>
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
                        siren={quote.supplier?.siren}
                        siret={quote.supplier?.siret}
                        vat={quote.supplier?.vat_number}
                        email={supplierContactEmail}
                        phone={quote.supplier?.phone}
                      />

                      <div className={styles.partiesArrow}>
                        <div className={styles.partiesLine} />
                        <div className={styles.partiesBubble}>
                          <ArrowRight size={15} />
                        </div>
                        <div className={styles.partiesLine} />
                      </div>

                      <PartyCard
                        role="Devis pour"
                        name={customerName}
                        lines={customerLines}
                        siren={quote.customer?.siren}
                        siret={quote.customer?.siret}
                        vat={quote.customer?.vat_number}
                        email={quote.customer?.email}
                        phone={quote.customer?.phone}
                        clientType={quote.customer?.client_type}
                        accent
                      />
                    </div>

                    <section className={styles.section}>
                      <p className={cx(styles.overline, styles.overlineMuted)}>Détail des prestations</p>

                      <div className={cx(styles.tableWrap, styles.tableDesktop)}>
                        <table className={styles.table}>
                          <colgroup>
                            <col className={styles.colIndex} />
                            <col className={styles.colProduct} />
                            <col className={styles.colQty} />
                            <col className={styles.colUnitPrice} />
                            <col className={styles.colVat} />
                            <col className={styles.colAmount} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th className={cx(styles.isNarrow, styles.isCenter)}>#</th>
                              <th>Produit / Service</th>
                              <th className={styles.isCenter}>Qté</th>
                              <th className={styles.isRight}>PU HT</th>
                              <th className={styles.isRight}>TVA</th>
                              <th className={styles.isRight}>Montant HT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {quote.lines.map((line, index) => {
                              const lineKind = String(line.line_type || "item").toLowerCase();
                              const detail = String(line.detail || "").trim();
                              const productName = line.product_name || `Ligne ${index + 1}`;
                              if (lineKind === "comment" || lineKind === "section" || lineKind === "title") {
                                return (
                                  <tr key={`${productName}-${index}`} className={styles.tableSpecialRow}>
                                    <td colSpan={6}>
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
                              const itemNumber = quote.lines.slice(0, index + 1).filter((candidate) => {
                                const kind = String(candidate.line_type || "item").toLowerCase();
                                return kind !== "comment" && kind !== "section" && kind !== "title";
                              }).length;
                              return (
                                <tr key={`${productName}-${index}`}>
                                  <td className={styles.isCenter}>
                                    <span className={styles.tableIndex}>{itemNumber}</span>
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
                                    {vatLineReasonLabel(line, quote.supplier) ? (
                                      <span className={styles.tableDetail}>
                                        {vatLineReasonLabel(line, quote.supplier)}
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
                        {quote.lines.map((line, index) => {
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
                                {vatLineReasonLabel(line, quote.supplier) ? (
                                  <span>
                                    Motif : <strong>{vatLineReasonLabel(line, quote.supplier)}</strong>
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
                            <span>Sous-total HT</span>
                            <strong>{money(quote.totals.total_ex_vat)}</strong>
                          </div>
                          <div className={styles.totalsRow}>
                            <span>TVA ({formatPercentCompactFr(quote.lines[0]?.vat_rate || 0)})</span>
                            <strong>{money(quote.totals.total_vat)}</strong>
                          </div>
                          <div className={cx(styles.totalsRow, styles.totalsRowTotal)}>
                            <div className={styles.totalsAccent} />
                            <span>Total TTC</span>
                            <strong>{money(quote.totals.total_inc_vat)}</strong>
                          </div>
                          {Number(quote.requested_advance?.amount_ttc || 0) > 0 ? (
                            <>
                              <div className={styles.totalsRow}>
                                <span>{quote.requested_advance?.label || "Acompte demandé"}</span>
                                <strong>{money(Number(quote.requested_advance?.amount_ttc || 0))}</strong>
                              </div>
                              {Number(quote.requested_advance?.amount_vat || 0) > 0 ? (
                                <div className={styles.totalsRow}>
                                  <span>TVA estimée sur acompte</span>
                                  <strong>{money(Number(quote.requested_advance?.amount_vat || 0))}</strong>
                                </div>
                              ) : null}
                            </>
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
                        <p className={cx(styles.overline, styles.overlineMuted)}>Note</p>
                        <div className={styles.noteText}>
                          {normalizedNote.split("\n").map((line, index) => (
                            <p key={`note-${index}`}>{line}</p>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className={styles.legalNoticeCard}>
                      <p className={styles.legalNoticeTitle}>Mention légale imprimée</p>
                      {supplierLegalLine ? <p>{supplierLegalLine}</p> : null}
                      {legalNoticeLines.map((line, index) => (
                        <p key={`legal-notice-${index}`}>{line}</p>
                      ))}
                      <p className={styles.documentFooterMeta}>{supplierMetaLine}</p>
                    </div>
                  </article>
                </div>
              </div>

              {quote.attachments?.length || info || canDecide ? (
                <aside className={styles.documentSideRail}>
                  {quote.attachments?.length ? (
                    <section className={styles.supportCard}>
                      <p className={cx(styles.overline, styles.overlineMuted)}>Documents associés au devis</p>
                      <div className="mt-10">
                        <PortalAttachments attachments={quote.attachments || []} />
                      </div>
                    </section>
                  ) : null}

                  {info && (!canDecide || decision === "none") ? (
                    <section className={styles.supportCard}>
                      <p className={cx(styles.overline, styles.overlineMuted)}>Information</p>
                      <div className={styles.supportCopy}>
                        <p>{info}</p>
                      </div>
                    </section>
                  ) : null}

                  {canDecide ? (
                    <QuoteResponsePanel
                      decision={decision}
                      summary={[
                        { label: "Devis", value: quoteNumber },
                        { label: "Client", value: customerName },
                        { label: "Total TTC", value: money(quote.totals.total_inc_vat) },
                        { label: "Valable jusqu'au", value: validUntilLabel },
                      ]}
                      busy={busy}
                      name={name}
                      email={email}
                      reason={reason}
                      termsAccepted={termsAccepted}
                      otpCode={otpCode}
                      otpSent={otpSent}
                      otpExpiresLabel={otpExpiresAt ? formatDateTimeFr(otpExpiresAt) : null}
                      requiresOtp={requiresOtp}
                      termsHref={termsHref}
                      statusMessage={info}
                      onStartAccept={() => {
                        setInfo(null);
                        setDecision("accept");
                      }}
                      onStartReject={() => {
                        setInfo(null);
                        setDecision("reject");
                      }}
                      onReset={() => {
                        setDecision("none");
                        setInfo(null);
                      }}
                      onNameChange={setName}
                      onEmailChange={setEmail}
                      onReasonChange={setReason}
                      onTermsAcceptedChange={setTermsAccepted}
                      onOtpCodeChange={setOtpCode}
                      onRequestOtp={requestOtp}
                      onAccept={accept}
                      onReject={reject}
                    />
                  ) : null}
                </aside>
              ) : null}
            </div>
          </main>
        </>
      )}
    </div>
  );
}
