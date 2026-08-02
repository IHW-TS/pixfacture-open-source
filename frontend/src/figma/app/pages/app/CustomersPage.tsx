"use client";

import {
  useEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Link, useNavigate, useParams } from "@/figma/react-router-compat";
import { api, apiUpload, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";
import { formatDateTimeFr } from "@/lib/dateFormat";
import { useCockpit } from "@/lib/useCockpit";
import { useHydrated } from "@/lib/useHydrated";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";
import {
  deriveSirenFromSiret,
  formatBicInput,
  formatIbanInput,
  formatPostalCodeInput,
  formatSirenInput,
  formatSiretInput,
  formatVatNumberInput,
  isValidFrenchVatNumber,
  isValidSiren,
  isValidSiret,
  normalizeVatNumber,
} from "@/lib/businessRules";
import {
  ActionMenu,
  ActionMenuButton,
  ActionMenuLink,
  AppPageHeader,
  Card,
  DataTable,
  PrimaryButton,
  SecondaryButton,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { GuidanceTooltip } from "../../components/app/GuidanceTooltip";
import { type ModuleOverviewStat } from "../../components/app/ModuleOverview";
import { SalesPeriodControl } from "../../components/app/SalesModuleLayout";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CheckCircle2,
  ExternalLink,
  FileDown,
  FileUp,
  FileText,
  Mail,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";

const countryFlags: Record<string, string> = {
  FR: "🇫🇷",
  DE: "🇩🇪",
  BE: "🇧🇪",
  CH: "🇨🇭",
  LU: "🇱🇺",
  ES: "🇪🇸",
  IT: "🇮🇹",
  GB: "🇬🇧",
  US: "🇺🇸",
};

const isCsvFile = (file: File) => /\.csv$/i.test(file.name || "");

const EMPTY_CUSTOMER = {
  name: "",
  email: "",
  phone: "",
  contact_name: "",
  address: "",
  address_line1: "",
  address_line2: "",
  postal_code: "",
  city: "",
  country: "FR",
  country_code: "FR",
  siret: "",
  siren: "",
  vat_number: "",
  endpoint_id: "",
  pdp_name: "",
  public_service_code: "",
  public_commitment_reference: "",
  client_type: "business",
  payment_terms_default: "30 jours fin de mois",
  payment_method_default: "virement",
  default_vat_rate: 20,
  iban: "",
  bic: "",
  internal_note: "",
};

const CUSTOMER_PAYMENT_METHOD_OPTIONS = [
  { value: "virement", label: "Virement bancaire" },
  { value: "carte", label: "Carte bancaire" },
  { value: "prelevement", label: "Prélèvement bancaire" },
  { value: "cheque", label: "Chèque" },
  { value: "especes", label: "Espèces" },
];

const CUSTOMER_PERIOD_OPTIONS = [
  { value: "30", label: "30 derniers jours" },
  { value: "today", label: "Aujourd'hui" },
  { value: "7", label: "7 derniers jours" },
  { value: "month", label: "Mois en cours" },
  { value: "90", label: "90 derniers jours" },
  { value: "all", label: "Tout l'historique" },
];

function normalizeCustomerPaymentMethodDefault(value: any) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  const aliases: Record<string, string> = {
    bank_transfer: "virement",
    transfer: "virement",
    virement_bancaire: "virement",
    virement: "virement",
    card: "carte",
    carte_bancaire: "carte",
    cb: "carte",
    carte: "carte",
    direct_debit: "prelevement",
    prélèvement: "prelevement",
    prelevement: "prelevement",
    cheque: "cheque",
    chèque: "cheque",
    check: "cheque",
    cash: "especes",
    espèces: "especes",
    especes: "especes",
  };
  const normalized = aliases[raw] || raw;
  return CUSTOMER_PAYMENT_METHOD_OPTIONS.some((option) => option.value === normalized) ? normalized : "virement";
}

const CUSTOMER_NEW_DRAFT_KEY = "pixfacture.customer.new.draft.v2";
const CUSTOMER_LEGACY_DRAFT_KEYS = ["pixfacture.customer.new.draft.v1"];
const CUSTOMER_DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24;

function customerFormHasUserInput(form: any) {
  const merged = { ...EMPTY_CUSTOMER, ...form };
  const textFields = [
    "name",
    "email",
    "phone",
    "contact_name",
    "address",
    "address_line1",
    "address_line2",
    "postal_code",
    "city",
    "siret",
    "siren",
    "vat_number",
    "endpoint_id",
    "pdp_name",
    "public_service_code",
    "public_commitment_reference",
    "iban",
    "bic",
    "internal_note",
  ];
  if (textFields.some((field) => String(merged[field] || "").trim())) return true;
  if (String(merged.client_type || "business") !== EMPTY_CUSTOMER.client_type) return true;
  if (String(merged.payment_terms_default || "") !== EMPTY_CUSTOMER.payment_terms_default) return true;
  if (String(merged.payment_method_default || "") !== EMPTY_CUSTOMER.payment_method_default) return true;
  if (Number(merged.default_vat_rate ?? EMPTY_CUSTOMER.default_vat_rate) !== EMPTY_CUSTOMER.default_vat_rate)
    return true;
  return false;
}

function sanitizeCustomerForType(form: any) {
  const next = { ...EMPTY_CUSTOMER, ...form };
  const clientType = String(next.client_type || "business").toLowerCase();
  const country = String(next.country || next.country_code || "FR")
    .toUpperCase()
    .slice(0, 2);
  next.client_type = ["business", "individual", "public"].includes(clientType) ? clientType : "business";
  next.country = country || "FR";
  next.country_code = next.country;

  if (next.client_type === "individual") {
    next.siret = "";
    next.siren = "";
    next.vat_number = "";
    next.endpoint_id = "";
    next.pdp_name = "";
  }

  if (next.client_type !== "public") {
    next.public_service_code = "";
    next.public_commitment_reference = "";
  }

  return next;
}

function applyCustomerType(form: any, clientType: string) {
  return sanitizeCustomerForType({ ...form, client_type: clientType });
}

function loadCustomerDraftState() {
  if (typeof window === "undefined") return { form: EMPTY_CUSTOMER, restored: false };
  try {
    CUSTOMER_LEGACY_DRAFT_KEYS.forEach((key) => window.sessionStorage.removeItem(key));
    const raw = window.sessionStorage.getItem(CUSTOMER_NEW_DRAFT_KEY);
    if (!raw) return { form: EMPTY_CUSTOMER, restored: false };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { form: EMPTY_CUSTOMER, restored: false };
    const savedAt = Number(parsed.saved_at || 0);
    const storedForm = parsed.form && typeof parsed.form === "object" ? parsed.form : parsed;
    const form = sanitizeCustomerForType({ ...EMPTY_CUSTOMER, ...storedForm });
    const isFresh = savedAt > 0 && Date.now() - savedAt <= CUSTOMER_DRAFT_MAX_AGE_MS;
    if (!isFresh || !customerFormHasUserInput(form)) {
      window.sessionStorage.removeItem(CUSTOMER_NEW_DRAFT_KEY);
      return { form: EMPTY_CUSTOMER, restored: false };
    }
    return { form, restored: true };
  } catch {
    return { form: EMPTY_CUSTOMER, restored: false };
  }
}

function saveCustomerDraft(form: any) {
  if (typeof window === "undefined") return;
  try {
    const sanitized = sanitizeCustomerForType(form);
    if (!customerFormHasUserInput(sanitized)) {
      window.sessionStorage.removeItem(CUSTOMER_NEW_DRAFT_KEY);
      return;
    }
    window.sessionStorage.setItem(CUSTOMER_NEW_DRAFT_KEY, JSON.stringify({ saved_at: Date.now(), form: sanitized }));
  } catch {
    // The draft is a convenience only; form submission must not depend on storage.
  }
}

function clearCustomerDraft() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(CUSTOMER_NEW_DRAFT_KEY);
    CUSTOMER_LEGACY_DRAFT_KEYS.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // ignore storage failures
  }
}

function readRequestedClientType() {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("client_type");
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (["business", "individual", "public"].includes(normalized)) return normalized;
  return null;
}

function customerTypeCreationTitle(clientType: string | null | undefined) {
  if (clientType === "individual") return "Nouveau client particulier";
  if (clientType === "public") return "Nouveau client public";
  return "Nouveau client";
}

type CustomerModuleFocus = {
  tone: "ok" | "warn" | "danger" | "info" | "purple" | "muted";
  label: string;
  title: string;
  description: string;
};

function composeStructuredCustomerAddress(form: any, country: string) {
  const postalCity = [formatPostalCodeInput(form.postal_code, country), form.city]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  return [form.address_line1, form.address_line2, postalCity]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeCustomerPayload(form: any) {
  const trim = (value: any) => (typeof value === "string" ? value.trim() : value);
  const orNull = (value: any) => {
    const trimmed = trim(value);
    return trimmed === "" || trimmed == null ? null : trimmed;
  };
  const country = (trim(form.country) || trim(form.country_code) || "FR").toUpperCase();
  const clientType = trim(form.client_type) || "business";
  const isBusinessLike = ["business", "public"].includes(String(clientType).toLowerCase());
  const isPublic = String(clientType).toLowerCase() === "public";
  const defaultVatRate =
    form.default_vat_rate === "" || form.default_vat_rate == null ? null : Number(form.default_vat_rate);
  const structuredAddress = composeStructuredCustomerAddress(form, country);
  return {
    name: trim(form.name) || "",
    email: orNull(form.email),
    phone: orNull(form.phone),
    contact_name: orNull(form.contact_name),
    address: orNull(structuredAddress || form.address),
    address_line1: orNull(form.address_line1),
    address_line2: orNull(form.address_line2),
    postal_code: orNull(formatPostalCodeInput(form.postal_code, country)),
    city: orNull(form.city),
    country,
    country_code: (trim(form.country_code) || country).toUpperCase(),
    siret: isBusinessLike ? orNull(String(form.siret || "").replace(/\D+/g, "")) : null,
    siren: isBusinessLike ? orNull(String(form.siren || deriveSirenFromSiret(form.siret)).replace(/\D+/g, "")) : null,
    vat_number: isBusinessLike ? orNull(normalizeVatNumber(form.vat_number)) : null,
    endpoint_id: isBusinessLike ? orNull(form.endpoint_id) : null,
    pdp_name: isBusinessLike ? orNull(form.pdp_name) : null,
    public_service_code: isPublic ? orNull(form.public_service_code) : null,
    public_commitment_reference: isPublic ? orNull(form.public_commitment_reference) : null,
    client_type: clientType,
    payment_terms_default: orNull(form.payment_terms_default),
    payment_method_default: orNull(normalizeCustomerPaymentMethodDefault(form.payment_method_default)),
    default_vat_rate: Number.isFinite(defaultVatRate) ? defaultVatRate : null,
    iban: orNull(formatIbanInput(form.iban)),
    bic: orNull(formatBicInput(form.bic)),
    internal_note: orNull(form.internal_note),
  };
}

function customerTypeLabel(customer: any) {
  const t = (customer.client_type || "").toLowerCase();
  if (t === "individual") return "Particulier";
  if (t === "public") return "Public";
  if (t === "business") return customer.country === "FR" ? "Entreprise FR" : "Entreprise";
  if (customer.siret || customer.vat_number) return customer.country === "FR" ? "Entreprise FR" : "Entreprise";
  return "À compléter";
}

function customerShowsLegalIdentity(customer: any) {
  const t = String(customer?.client_type || "").toLowerCase();
  if (t === "individual") return false;
  if (t === "business" || t === "public") return true;
  return Boolean(customer?.siret || customer?.siren || customer?.vat_number);
}

function customerDisplayAddress(customer: any) {
  const postalCity = [customer?.postal_code, customer?.city]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const structuredAddress = [customer?.address_line1, customer?.address_line2, postalCity]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
  if (structuredAddress) return structuredAddress;
  return String(customer?.address || "")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(", ");
}

function customerCreationReadiness(form: any) {
  const country = (form.country || form.country_code || "FR").toUpperCase();
  const clientType = String(form.client_type || "business").toLowerCase();
  const isBusiness = ["business", "public"].includes(clientType);
  const isPublic = clientType === "public";
  const isIndividual = clientType === "individual";
  const siretOk = !form.siret || isValidSiret(form.siret);
  const sirenOk = !form.siren || isValidSiren(form.siren);
  const vatOk = !form.vat_number || country !== "FR" || isValidFrenchVatNumber(form.vat_number);

  const checks = [
    {
      label: "Nom",
      ok: Boolean(String(form.name || "").trim()),
      hint: "Nom ou raison sociale.",
    },
    {
      label: isIndividual ? "Contact" : "Email ou contact",
      ok: Boolean(String(form.email || "").trim() || String(form.contact_name || "").trim()),
      hint: isIndividual ? "Email ou nom du contact." : "Pratique pour l'envoi du devis ou de la facture.",
    },
    {
      label: "Adresse",
      ok: Boolean(String(form.address_line1 || "").trim() && String(form.city || "").trim()),
      hint: "Adresse ligne 1 et ville.",
    },
    {
      label: isIndividual ? "Type client" : "Identifiant entreprise",
      ok: isIndividual
        ? true
        : country === "FR"
          ? Boolean(form.siret || form.siren) && siretOk && sirenOk
          : Boolean(form.vat_number) && vatOk,
      hint: isIndividual
        ? "Le particulier reste simple à créer."
        : country === "FR"
          ? "SIREN ou SIRET pour sécuriser la facturation."
          : "TVA utile pour le B2B hors France.",
    },
    {
      label: "Préférences",
      ok: Boolean(String(form.payment_terms_default || "").trim() || String(form.payment_method_default || "").trim()),
      hint: "Conditions de paiement ou moyen favori.",
    },
  ];

  const score = Math.round((checks.filter((item) => item.ok).length / checks.length) * 100);
  const typeLabel = isIndividual ? "Particulier" : isPublic ? "Client public" : "Entreprise";
  const identifierLabel = isIndividual ? "Profil" : country === "FR" ? "SIREN / SIRET" : "TVA";
  const identityValue = isIndividual
    ? "Profil particulier"
    : country === "FR"
      ? formatSiretInput(form.siret || "") || formatSirenInput(form.siren || "") || "À renseigner"
      : formatVatNumberInput(form.vat_number || "") || "À renseigner";

  return {
    country,
    clientType,
    isBusiness,
    isPublic,
    isIndividual,
    siretOk,
    sirenOk,
    vatOk,
    checks,
    score,
    tone: score >= 85 ? "ok" : score >= 60 ? "warn" : "danger",
    nextHint: checks.find((item) => !item.ok)?.hint || "Client prêt pour devis, facture et portail.",
    typeLabel,
    identifierLabel,
    identityValue,
    identityReady: checks[3]?.ok ?? false,
  };
}

function customerCreationBlockingIssue(form: any) {
  const readiness = customerCreationReadiness(form);
  const hasName = Boolean(String(form?.name || "").trim());
  const hasEmail = Boolean(String(form?.email || "").trim());
  const hasAddress = Boolean(String(form?.address_line1 || "").trim() && String(form?.city || "").trim());

  if (!hasName) return "Renseignez le nom ou la raison sociale avant d'enregistrer.";
  if (readiness.isIndividual && !hasEmail && !hasAddress) {
    return "Pour un particulier, ajoutez au moins un email ou une adresse.";
  }
  if (!readiness.isIndividual && readiness.country === "FR") {
    if (!form?.siret && !form?.siren) return "Pour une entreprise française, ajoutez un SIREN ou un SIRET.";
    if (!readiness.siretOk || !readiness.sirenOk) return "Le SIREN ou SIRET saisi n'est pas valide.";
  }
  if (!readiness.isIndividual && readiness.country !== "FR" && form?.vat_number && !readiness.vatOk) {
    return "Le numéro de TVA semble incohérent.";
  }
  return null;
}

function customerDuplicateCheckParams(form: any) {
  const payload = normalizeCustomerPayload(form);
  const params = new URLSearchParams();
  const email = String(payload.email || "").trim();
  const siret = String(payload.siret || "").replace(/\D+/g, "");
  const siren = String(payload.siren || deriveSirenFromSiret(payload.siret)).replace(/\D+/g, "");
  const vatNumber = normalizeVatNumber(payload.vat_number || "");
  const name = String(payload.name || "").trim();
  if (email.includes("@")) params.set("email", email);
  if (siret.length === 14) params.set("siret", siret);
  if (siren.length === 9) params.set("siren", siren);
  if (vatNumber.length >= 5) params.set("vat_number", vatNumber);
  if (name.length >= 4) params.set("name", name);
  return params;
}

function customerDuplicateReasonLabel(reason: string | null | undefined) {
  const labels: Record<string, string> = {
    email_identique: "email identique",
    siret_identique: "SIRET identique",
    siren_identique: "SIREN identique",
    tva_identique: "TVA identique",
    nom_proche: "nom proche",
  };
  return labels[String(reason || "")] || "doublon possible";
}

function complianceStatus(customer: any) {
  if (customer.country === "FR" && (customer.siret || customer.siren)) {
    return { label: "Identifié", color: "ok" as const };
  }
  if (customer.country !== "FR" && customer.vat_number) {
    return { label: "TVA fournie", color: "ok" as const };
  }
  if (customer.email || customer.address || customer.address_line1) {
    return { label: "Partiel", color: "warn" as const };
  }
  return { label: "À compléter", color: "muted" as const };
}

function money(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function customerDateValue(customer: any) {
  const raw =
    customer?.created_at ||
    customer?.createdAt ||
    customer?.created ||
    customer?.updated_at ||
    customer?.updatedAt ||
    customer?.last_activity_at ||
    customer?.lastActivityAt ||
    null;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function customerMatchesPeriod(customer: any, period: string) {
  if (period === "all") return true;
  const time = customerDateValue(customer);
  if (time == null) return true;
  const now = new Date();
  const start = new Date(now);
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    return time >= start.getTime();
  }
  if (period === "7" || period === "30" || period === "90") {
    start.setDate(start.getDate() - (Number(period) - 1));
    start.setHours(0, 0, 0, 0);
    return time >= start.getTime();
  }
  if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return time >= start.getTime();
  }
  return true;
}

function portfolioHealthTone(score: number | null | undefined) {
  const value = Number(score || 0);
  if (value >= 85) return { status: "ok", color: "#059669" };
  if (value >= 70) return { status: "info", color: "#2563eb" };
  if (value >= 55) return { status: "warn", color: "#d97706" };
  if (value >= 35) return { status: "warn", color: "#c2410c" };
  return { status: "danger", color: "#dc2626" };
}

function portfolioSegmentPill(item: any) {
  return {
    status: item?.segment_tone || "muted",
    label: item?.segment_label || "Segment",
  };
}

function portfolioRiskPill(item: any) {
  return {
    status: item?.risk_tone || "muted",
    label: item?.risk_label || "Risque",
  };
}

function ownerRoleLabel(value: string | null | undefined) {
  switch ((value || "").toLowerCase()) {
    case "owner":
      return "Direction";
    case "admin":
      return "Admin";
    case "viewer":
      return "Lecture";
    case "accountant":
    default:
      return "Compta";
  }
}

const customerFieldLabelClass = "mb-1.5 block text-[#374151]";
const customerFieldLabelStyle: CSSProperties = { fontSize: "0.8125rem", fontWeight: 500 };
const customerFieldControlClass =
  "w-full rounded-xl border border-[#e2e8f0] bg-white px-3.5 py-2.5 text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20";
const customerFieldControlStyle: CSSProperties = { fontSize: "0.875rem" };
const customerFieldHintClass = "mt-1 text-[#94a3b8]";
const customerFieldHintStyle: CSSProperties = { fontSize: "0.75rem" };

function CustomerSectionHeader({ title, badge }: { title: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[0.9375rem] font-semibold text-[#0f172a]">{title}</h2>
      {badge ? <div className="text-[0.6875rem] font-bold text-[#94a3b8]">{badge}</div> : null}
    </div>
  );
}

function normalizePhoneInput(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasInternationalPrefix = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "").slice(0, 15);
  if (!digits) return "";
  if (digits.length === 10 && digits.startsWith("0")) return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  if (hasInternationalPrefix) return `+${digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim()}`;
  return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

function CustomerInputField({
  label,
  required,
  hint,
  className = "",
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  const generatedId = useId();
  const inputId = props.id || `customer-input-${generatedId.replace(/:/g, "")}`;

  return (
    <div>
      <label htmlFor={inputId} className={customerFieldLabelClass} style={customerFieldLabelStyle}>
        {label}
        {required ? <span className="ml-0.5 text-[#ef4444]">*</span> : null}
      </label>
      <input
        id={inputId}
        className={`${customerFieldControlClass} ${className}`}
        style={{ ...customerFieldControlStyle, ...style }}
        {...props}
      />
      {hint ? (
        <p className={customerFieldHintClass} style={customerFieldHintStyle}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CustomerSelectField({
  label,
  required,
  children,
  className = "",
  style,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const generatedId = useId();
  const selectId = props.id || `customer-select-${generatedId.replace(/:/g, "")}`;

  return (
    <div>
      <label htmlFor={selectId} className={customerFieldLabelClass} style={customerFieldLabelStyle}>
        {label}
        {required ? <span className="ml-0.5 text-[#ef4444]">*</span> : null}
      </label>
      <select
        id={selectId}
        className={`${customerFieldControlClass} cursor-pointer appearance-none ${className}`}
        style={{ ...customerFieldControlStyle, ...style }}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

function CustomerTypeSelector({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const isPublic = value === "public";
  const selectedValue = isPublic ? "business" : value;
  const options = [
    { value: "business", label: "Professionnel", icon: Building2, detail: "Entreprise, indépendant ou association" },
    { value: "individual", label: "Particulier", icon: Users, detail: "Sans identifiant entreprise" },
  ];

  return (
    <div className="rounded-2xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="mb-3">
        <div className="text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#64748b]">Identification</div>
        <div className="mt-0.5 text-[0.85rem] font-bold text-[#0f172a]">Type de client</div>
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px]">
        {options.map((option) => {
          const Icon = option.icon;
          const active = selectedValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(option.value)}
              className={`flex min-h-[3.35rem] w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 text-left transition ${
                active
                  ? "border-[#fb923c] bg-[#fff7ed] text-[#9a3412] shadow-[0_8px_18px_rgba(251,146,60,0.1)]"
                  : "border-[#e2e8f0] bg-[#f8fafc] text-[#475569] hover:border-[#fed7aa] hover:bg-white"
              } disabled:cursor-default disabled:opacity-80`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  active ? "bg-[#ffedd5] text-[#ea580c]" : "bg-white text-[#64748b]"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[0.82rem] font-semibold text-[#0f172a]">{option.label}</span>
                <span className="block truncate text-[0.68rem] text-[#64748b]">{option.detail}</span>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={readOnly || selectedValue !== "business"}
          onClick={() => onChange(isPublic ? "business" : "public")}
          className={`flex min-h-[3.35rem] w-full items-center justify-between gap-2 rounded-xl border px-3 transition ${
            isPublic
              ? "border-[#fb923c] bg-[#fff7ed] text-[#9a3412]"
              : selectedValue === "business"
                ? "border-[#e2e8f0] bg-[#f8fafc] text-[#64748b] hover:border-[#fed7aa] hover:bg-white hover:text-[#9a3412]"
                : "border-[#e2e8f0] bg-[#f8fafc] text-[#94a3b8]"
          } disabled:cursor-default disabled:opacity-60`}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            <ReceiptText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-[0.75rem] font-bold">Client public</span>
          </span>
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${isPublic ? "bg-[#f97316]" : "bg-[#cbd5e1]"}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

type ChorusDirectoryLookupResult = {
  siret?: string | null;
  platform_slug?: string | null;
  billing_address_active?: boolean | null;
  service_code_required?: boolean | null;
  commitment_required?: boolean | null;
  service_or_commitment_required?: boolean | null;
  raw_payload?: {
    services?: unknown;
    selected_service?: Record<string, unknown> | null;
    service_rules_complete?: boolean | null;
  } | null;
  source?: string | null;
  last_synced_at?: string | null;
  updated_at?: string | null;
};

const chorusRequirementLabel = (value: boolean | null | undefined, requiredLabel = "Requis") => {
  if (value === true) return requiredLabel;
  if (value === false) return "Non requis";
  return "Non précisé par Chorus Pro";
};

function CustomerFormFields({
  form,
  setForm,
  showLookup = true,
  readOnly = false,
}: {
  form: any;
  setForm: (updater: any) => void;
  showLookup?: boolean;
  readOnly?: boolean;
}) {
  const { capabilities } = useSession({ autoRefresh: false });
  const einvoicingAvailable = Boolean(capabilities?.einvoicing_available_by_plan);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupNotice, setLookupNotice] = useState<string | null>(null);
  const [chorusDirectoryBusy, setChorusDirectoryBusy] = useState(false);
  const [chorusDirectoryError, setChorusDirectoryError] = useState<string | null>(null);
  const [chorusDirectoryResult, setChorusDirectoryResult] = useState<ChorusDirectoryLookupResult | null>(null);

  const update = (field: string, value: any) => {
    if (field === "siret" || field === "public_service_code") {
      setChorusDirectoryError(null);
      setChorusDirectoryResult(null);
    }
    setForm((prev: any) => {
      if (field === "siret") {
        const formatted = formatSiretInput(value);
        const derivedSiren = deriveSirenFromSiret(formatted);
        return {
          ...prev,
          siret: formatted,
          ...(derivedSiren ? { siren: formatSirenInput(derivedSiren) } : {}),
        };
      }
      if (field === "siren") {
        return { ...prev, siren: formatSirenInput(value) };
      }
      if (field === "vat_number") {
        return { ...prev, vat_number: formatVatNumberInput(value) };
      }
      if (field === "iban") {
        return { ...prev, iban: formatIbanInput(value) };
      }
      if (field === "bic") {
        return { ...prev, bic: formatBicInput(value) };
      }
      if (field === "postal_code") {
        return { ...prev, postal_code: formatPostalCodeInput(value, prev.country || prev.country_code || "FR") };
      }
      if (field === "country") {
        const next = String(value || "FR").toUpperCase();
        return { ...prev, country: next, country_code: next };
      }
      if (field === "country_code") {
        const next = String(value || "FR")
          .toUpperCase()
          .slice(0, 2);
        return { ...prev, country_code: next, country: next };
      }
      return {
        ...prev,
        [field]: value,
      };
    });
  };

  const prefillCompany = async () => {
    const country = (form.country || form.country_code || "FR").toUpperCase();
    const siret = String(form.siret || "").replace(/\D+/g, "");
    const siren = String(form.siren || "").replace(/\D+/g, "") || deriveSirenFromSiret(siret);
    if (lookupBusy || country !== "FR" || (!siret && !siren)) return;
    setLookupBusy(true);
    setLookupError(null);
    setLookupNotice(null);
    try {
      const params = new URLSearchParams();
      if (siret.length === 14) params.set("siret", siret);
      else if (siren.length === 9) params.set("siren", siren);
      const res = await rawApi(`/api/customers/company-lookup?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Recherche entreprise impossible."));
      }
      const payload = await res.json().catch(() => null);
      const inferredClientType = String(payload?.client_type || "").toLowerCase();
      const hasInferredClientType = inferredClientType === "business" || inferredClientType === "public";
      setForm((prev: any) =>
        sanitizeCustomerForType({
          ...prev,
          name: payload?.name || prev.name,
          address_line1: payload?.address_line1 || prev.address_line1,
          address_line2: payload?.address_line2 || prev.address_line2,
          postal_code: payload?.postal_code || prev.postal_code,
          city: payload?.city || prev.city,
          country: (payload?.country || prev.country || "FR").toUpperCase(),
          country_code: (payload?.country || prev.country_code || "FR").toUpperCase(),
          siret: formatSiretInput(payload?.siret || prev.siret),
          siren: formatSirenInput(payload?.siren || prev.siren || deriveSirenFromSiret(payload?.siret || prev.siret)),
          endpoint_id: payload?.endpoint_id || payload?.billing_address || prev.endpoint_id,
          pdp_name: payload?.pdp_name || payload?.platform_slug || prev.pdp_name,
          public_service_code: payload?.public_service_code || prev.public_service_code,
          public_commitment_reference: payload?.public_commitment_reference || prev.public_commitment_reference,
          ...(hasInferredClientType ? { client_type: inferredClientType } : {}),
        }),
      );
      setLookupNotice(
        hasInferredClientType
          ? `Fiche préremplie depuis l'annuaire entreprise. Type détecté : ${
              inferredClientType === "public" ? "public" : "privé"
            }.`
          : "Fiche préremplie depuis l'annuaire entreprise.",
      );
    } catch (err) {
      setLookupError(formatApiError(err, "Préremplissage annuaire impossible."));
    } finally {
      setLookupBusy(false);
    }
  };

  const readiness = customerCreationReadiness(form);
  const { country, isBusiness, isIndividual, isPublic, siretOk, sirenOk, vatOk } = readiness;
  const lookupIdentifier = form.siret || form.siren || "";
  const lookupDigits = String(lookupIdentifier || "").replace(/\D+/g, "");
  const showBusinessLookup = Boolean(showLookup && isBusiness && country === "FR");
  const canLookup = isBusiness && country === "FR" && (lookupDigits.length === 9 || lookupDigits.length === 14);
  const chorusSiret = String(form.siret || "").replace(/\D+/g, "");
  const canVerifyChorus = isPublic && country === "FR" && chorusSiret.length === 14;
  const lookupDone = Boolean(
    !lookupError && (lookupNotice || ((siretOk || sirenOk) && (form.name || form.address_line1 || form.address))),
  );
  const chorusActiveServices = useMemo(() => {
    const rawServices = chorusDirectoryResult?.raw_payload?.services;
    if (!Array.isArray(rawServices)) return [];
    const seen = new Set<string>();
    return rawServices.flatMap((rawService) => {
      if (!rawService || typeof rawService !== "object") return [];
      const service = rawService as Record<string, unknown>;
      const activeValue = service.active ?? service.actif ?? service.is_active;
      const status = String(service.status ?? service.statut ?? "")
        .trim()
        .toLowerCase();
      if (
        activeValue === false ||
        String(activeValue).toLowerCase() === "false" ||
        ["inactive", "inactif", "disabled", "fermé", "closed"].includes(status)
      ) {
        return [];
      }
      const code = String(service.codeService ?? service.code_service ?? service.code ?? "").trim();
      const label = String(
        service.libelleService ?? service.libelle_service ?? service.label ?? service.name ?? "",
      ).trim();
      if (!code && !label) return [];
      const key = `${code}|${label}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, code, label }];
    });
  }, [chorusDirectoryResult]);
  const chorusServiceCode = String(form.public_service_code || "").trim();
  const publicServiceCodeMissing = !chorusServiceCode;
  const publicCommitmentMissing = !String(form.public_commitment_reference || "").trim();
  const publicServiceCodeTooLong = String(form.public_service_code || "").length > 100;
  const publicCommitmentTooLong = String(form.public_commitment_reference || "").length > 10;
  const chorusSelectedService = chorusDirectoryResult?.raw_payload?.selected_service || null;
  const chorusSelectedServiceCode = chorusSelectedService
    ? String(
        chorusSelectedService.codeService ??
          chorusSelectedService.code_service ??
          chorusSelectedService.code ??
          chorusServiceCode,
      ).trim()
    : "";
  const chorusSelectedServiceLabel = chorusSelectedService
    ? String(
        chorusSelectedService.libelleService ??
          chorusSelectedService.libelle_service ??
          chorusSelectedService.label ??
          chorusSelectedService.name ??
          "",
      ).trim()
    : "";
  const chorusSelectedServiceRequiresCommitment = Boolean(
    chorusDirectoryResult?.commitment_required === true ||
    chorusSelectedService?.commitment_required === true ||
    chorusSelectedService?.engagementJuridique === true,
  );
  const chorusMissingRequirements = chorusDirectoryResult
    ? [
        chorusDirectoryResult.service_code_required === true && publicServiceCodeMissing
          ? "Le code service est requis par Chorus Pro."
          : null,
        chorusDirectoryResult.commitment_required === true && publicCommitmentMissing
          ? "Le numéro d’engagement juridique est requis par Chorus Pro."
          : null,
        chorusDirectoryResult.service_or_commitment_required === true &&
        publicServiceCodeMissing &&
        publicCommitmentMissing
          ? "Renseignez au moins un code service ou un numéro d’engagement juridique."
          : null,
      ].filter((message): message is string => Boolean(message))
    : [];

  const verifyChorusRecipient = async () => {
    if (chorusDirectoryBusy || !einvoicingAvailable || !canVerifyChorus) return;
    setChorusDirectoryBusy(true);
    setChorusDirectoryError(null);
    setChorusDirectoryResult(null);
    try {
      const lookupPayload = chorusServiceCode
        ? { siret: chorusSiret, service_code: chorusServiceCode }
        : { siret: chorusSiret };
      const result: ChorusDirectoryLookupResult = await api("/api/directory/chorus/lookup", {
        method: "POST",
        body: JSON.stringify(lookupPayload),
      });
      const responseSiret = String(result?.siret || "").replace(/\D+/g, "");
      const sourceConfirmed = [result?.source, result?.platform_slug]
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase(),
        )
        .includes("choruspro");
      if (responseSiret !== chorusSiret || !sourceConfirmed) {
        throw new Error("La réponse ne confirme pas ce destinataire dans l’annuaire officiel Chorus Pro.");
      }
      setChorusDirectoryResult(result);
    } catch (err) {
      setChorusDirectoryError(formatApiError(err, "Vérification dans l’annuaire Chorus Pro impossible."));
    } finally {
      setChorusDirectoryBusy(false);
    }
  };

  const selectCustomerType = (value: string) => {
    setLookupError(null);
    setLookupNotice(null);
    setChorusDirectoryError(null);
    setChorusDirectoryResult(null);
    setForm((prev: any) => applyCustomerType(prev, value));
  };

  const updateLookupIdentifier = (value: string) => {
    setLookupError(null);
    setLookupNotice(null);
    const digits = String(value || "").replace(/\D+/g, "");
    if (!digits) {
      setForm((prev: any) => ({ ...prev, siren: "", siret: "" }));
      return;
    }
    if (digits.length > 9) {
      const formattedSiret = formatSiretInput(value);
      const derivedSiren = deriveSirenFromSiret(formattedSiret);
      setForm((prev: any) => ({
        ...prev,
        siret: formattedSiret,
        ...(derivedSiren ? { siren: formatSirenInput(derivedSiren) } : {}),
      }));
    } else {
      setForm((prev: any) => ({
        ...prev,
        siren: formatSirenInput(value),
        siret: "",
      }));
    }
  };

  return (
    <div id="customer-form-main" className="space-y-4 text-sm text-[#0f172a]">
      <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-100">
        {showBusinessLookup ? (
          <div className="rounded-2xl border border-[#dbeafe] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_160px] lg:items-center">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dbeafe] text-[#1d4ed8]">
                  <Search className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-[0.82rem] font-bold text-[#0f172a]">Recherche entreprise</div>
                  <div className="text-[0.7rem] font-semibold text-[#64748b]">SIREN ou SIRET</div>
                </div>
              </div>

              <label className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] px-3 transition-all focus-within:border-[#1d4ed8] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#1d4ed8]/20">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.07em] ${
                    lookupDone
                      ? "bg-[#dcfce7] text-[#15803d]"
                      : canLookup
                        ? "bg-[#dbeafe] text-[#1d4ed8]"
                        : "bg-white text-[#64748b]"
                  }`}
                >
                  {lookupDone ? "Validé" : canLookup ? "Prêt" : "9 ou 14"}
                </span>
                <input
                  aria-label="SIREN ou SIRET pour autocomplétion"
                  value={lookupIdentifier}
                  onChange={(event) => updateLookupIdentifier(event.target.value)}
                  placeholder="123 456 789 ou 123 456 789 00012"
                  inputMode="numeric"
                  maxLength={18}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:outline-none focus:ring-0 focus:shadow-none"
                  style={{ ...customerFieldControlStyle, outline: "none" }}
                />
              </label>

              <GuidanceTooltip content="Récupère les informations publiques de l'entreprise pour limiter les erreurs de saisie.">
                <button
                  type="button"
                  aria-label="Autocompléter / Préremplir depuis le SIREN ou SIRET"
                  onClick={prefillCompany}
                  disabled={lookupBusy || !canLookup}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#1d4ed8] px-5 text-[0.875rem] font-bold text-white shadow-[0_10px_20px_rgba(29,78,216,0.18)] transition-all hover:-translate-y-[1px] hover:bg-[#1b46c2] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Search className="h-4 w-4" />
                  {lookupBusy ? "Recherche…" : lookupDone ? "Mettre à jour" : "Rechercher"}
                </button>
              </GuidanceTooltip>
            </div>
            {isPublic || lookupNotice || lookupError ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {isPublic ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#ffedd5] px-2 py-1 text-[0.65rem] font-bold text-[#9a3412]">
                    <ReceiptText className="h-3 w-3" /> Public activé
                  </span>
                ) : null}
                {lookupNotice || lookupError ? (
                  <span
                    className={`inline-flex rounded-full border px-2 py-1 text-[0.7rem] font-semibold ${
                      lookupError
                        ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]"
                        : "border-[#bbf7d0] bg-white text-[#047857]"
                    }`}
                  >
                    {lookupError || lookupNotice}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <CustomerTypeSelector value={readiness.clientType} onChange={selectCustomerType} readOnly={readOnly} />

        <div className="space-y-4">
          <Card>
            <CustomerSectionHeader title="Informations principales" badge={readiness.typeLabel} />

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CustomerInputField
                label={isIndividual ? "Nom complet" : "Nom / Raison sociale"}
                required
                value={form.name || ""}
                onChange={(event) => update("name", event.target.value)}
                placeholder={isIndividual ? "Ex. Marie Dupont" : "Ex. Acme Corp"}
                autoComplete={isIndividual ? "name" : "organization"}
              />
              <CustomerInputField
                label="Email principal"
                type="email"
                value={form.email || ""}
                onChange={(event) => update("email", event.target.value)}
                placeholder="compta@client.fr"
                autoComplete="email"
              />
              <CustomerInputField
                label="Téléphone"
                value={form.phone || ""}
                onChange={(event) => update("phone", normalizePhoneInput(event.target.value))}
                placeholder="+33 1 23 45 67 89"
                autoComplete="tel"
                maxLength={24}
              />
              <CustomerInputField
                label="Contact"
                value={form.contact_name || ""}
                onChange={(event) => update("contact_name", event.target.value)}
                placeholder="Nom du contact"
                autoComplete="name"
              />
              <CustomerSelectField
                label="Pays"
                value={country}
                onChange={(event) => update("country", event.target.value)}
              >
                <option value="FR">France</option>
                <option value="BE">Belgique</option>
                <option value="DE">Allemagne</option>
                <option value="LU">Luxembourg</option>
                <option value="CH">Suisse</option>
                <option value="ES">Espagne</option>
                <option value="IT">Italie</option>
                <option value="GB">Royaume-Uni</option>
                <option value="US">États-Unis</option>
              </CustomerSelectField>
            </div>
          </Card>

          <Card>
            <CustomerSectionHeader title="Adresse & conformité" badge={country} />

            <div className="mt-3 space-y-3">
              <CustomerInputField
                label="Adresse ligne 1"
                aria-label="Adresse (ligne 1)"
                value={form.address_line1 || ""}
                onChange={(event) => update("address_line1", event.target.value)}
                placeholder="12 rue Exemple"
                autoComplete="address-line1"
              />
              <CustomerInputField
                label="Adresse ligne 2"
                value={form.address_line2 || ""}
                onChange={(event) => update("address_line2", event.target.value)}
                placeholder="Bâtiment / étage"
                autoComplete="address-line2"
              />
              <div className="grid grid-cols-2 gap-3">
                <CustomerInputField
                  label="Code postal"
                  value={form.postal_code || ""}
                  onChange={(event) => update("postal_code", event.target.value)}
                  placeholder="75001"
                  maxLength={country === "FR" ? 5 : 12}
                  inputMode={country === "FR" ? "numeric" : undefined}
                  autoComplete="postal-code"
                />
                <CustomerInputField
                  label="Ville"
                  value={form.city || ""}
                  onChange={(event) => update("city", event.target.value)}
                  placeholder="Paris"
                  autoComplete="address-level2"
                />
              </div>
            </div>

            {!isIndividual ? (
              <div className="mt-4 border-t border-[#e8eef5] pt-4">
                <CustomerSectionHeader title="Identifiants" badge="SIREN / SIRET" />

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {!showBusinessLookup ? (
                    <>
                      <CustomerInputField
                        label="SIRET"
                        aria-label="SIRET (FR)"
                        value={form.siret || ""}
                        onChange={(event) => update("siret", event.target.value)}
                        placeholder="123 456 789 00011"
                        hint="14 chiffres, espaces auto."
                        maxLength={18}
                        inputMode="numeric"
                      />
                      <CustomerInputField
                        label="SIREN"
                        aria-label="SIREN (FR)"
                        value={form.siren || ""}
                        onChange={(event) => update("siren", event.target.value)}
                        placeholder="123 456 789"
                        hint="9 chiffres."
                        maxLength={11}
                        inputMode="numeric"
                      />
                    </>
                  ) : null}
                  <CustomerInputField
                    label="N° TVA intracommunautaire"
                    value={form.vat_number || ""}
                    onChange={(event) => update("vat_number", event.target.value)}
                    placeholder="FR 00 000 000 000"
                    hint="Format auto : FR 00 000 000 000."
                    maxLength={24}
                    autoComplete="off"
                  />
                  <CustomerInputField
                    label="Code pays"
                    value={(form.country_code || country).toUpperCase()}
                    onChange={(event) => update("country_code", event.target.value)}
                    placeholder="FR"
                    maxLength={2}
                    autoComplete="country"
                  />
                  {isPublic && einvoicingAvailable ? (
                    <>
                      <CustomerInputField
                        label="Code service Chorus Pro"
                        value={form.public_service_code || ""}
                        onChange={(event) => update("public_service_code", event.target.value)}
                        placeholder="Ex. SERVICE-FACTURES"
                        hint="À renseigner lorsque le destinataire public l’exige · 100 caractères maximum."
                        maxLength={100}
                        autoComplete="off"
                      />
                      <CustomerInputField
                        label="N° d’engagement juridique / bon de commande"
                        value={form.public_commitment_reference || ""}
                        onChange={(event) => update("public_commitment_reference", event.target.value)}
                        placeholder="Référence fournie par le client public"
                        hint="Référence par défaut · 10 caractères maximum selon Chorus Pro."
                        maxLength={10}
                        autoComplete="off"
                      />
                    </>
                  ) : null}
                </div>
                {isPublic && einvoicingAvailable && (publicServiceCodeTooLong || publicCommitmentTooLong) ? (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[0.75rem] font-semibold text-[#b91c1c]"
                  >
                    {publicServiceCodeTooLong
                      ? "Le code service dépasse la limite Chorus Pro de 100 caractères."
                      : "Le numéro d’engagement juridique dépasse la limite Chorus Pro de 10 caractères."}
                  </div>
                ) : null}
                {isPublic && einvoicingAvailable ? (
                  <div className="mt-3 rounded-xl border border-[#bfdbfe] bg-[#f8fbff] p-4" aria-live="polite">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[0.8125rem] font-bold text-[#1e3a8a]">
                          Qualification officielle Chorus Pro
                        </div>
                        <p className="mt-1 text-[0.72rem] leading-relaxed text-[#64748b]">
                          Contrôle manuel en lecture seule. Cette action ne transmet aucune facture.
                        </p>
                      </div>
                      <SecondaryButton
                        type="button"
                        onClick={() => void verifyChorusRecipient()}
                        disabled={chorusDirectoryBusy || !canVerifyChorus}
                      >
                        <Search className="h-3.5 w-3.5" />
                        {chorusDirectoryBusy ? "Vérification…" : "Vérifier dans l’annuaire Chorus Pro"}
                      </SecondaryButton>
                    </div>

                    {!canVerifyChorus ? (
                      <p className="mt-2 text-[0.72rem] font-semibold text-[#92400e]">
                        Renseignez un SIRET français de 14 chiffres pour lancer la vérification.
                      </p>
                    ) : null}
                    {chorusDirectoryError ? (
                      <div
                        role="alert"
                        className="mt-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[0.75rem] font-semibold text-[#b91c1c]"
                      >
                        {chorusDirectoryError}
                      </div>
                    ) : null}

                    {chorusDirectoryResult ? (
                      <div className="mt-3 space-y-3 border-t border-[#dbeafe] pt-3">
                        <div
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-bold ${
                            chorusDirectoryResult.billing_address_active === true
                              ? "bg-[#dcfce7] text-[#15803d]"
                              : chorusDirectoryResult.billing_address_active === false
                                ? "bg-[#fee2e2] text-[#b91c1c]"
                                : "bg-[#dbeafe] text-[#1d4ed8]"
                          }`}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {chorusDirectoryResult.billing_address_active === true
                            ? "Adresse de facturation active dans Chorus Pro"
                            : chorusDirectoryResult.billing_address_active === false
                              ? "Adresse de facturation inactive dans Chorus Pro"
                              : "Destinataire public trouvé dans Chorus Pro"}
                        </div>

                        <div className="grid gap-2 text-[0.72rem] text-[#475569] md:grid-cols-3">
                          <div className="rounded-lg bg-white px-3 py-2">
                            <span className="block text-[#94a3b8]">Source officielle</span>
                            <strong className="text-[#0f172a]">Chorus Pro</strong>
                          </div>
                          <div className="rounded-lg bg-white px-3 py-2">
                            <span className="block text-[#94a3b8]">État de l’adresse</span>
                            <strong className="text-[#0f172a]">
                              {chorusDirectoryResult.billing_address_active === true
                                ? "Active"
                                : chorusDirectoryResult.billing_address_active === false
                                  ? "Inactive"
                                  : "Non précisé"}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-white px-3 py-2">
                            <span className="block text-[#94a3b8]">Vérifiée le</span>
                            <strong className="text-[#0f172a]">
                              {formatDateTimeFr(
                                chorusDirectoryResult.last_synced_at || chorusDirectoryResult.updated_at,
                                "Date indisponible",
                              )}
                            </strong>
                          </div>
                        </div>

                        <div className="grid gap-2 text-[0.72rem] md:grid-cols-3">
                          <div className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-2">
                            <span className="block text-[#64748b]">Code service</span>
                            <strong className="text-[#0f172a]">
                              {chorusRequirementLabel(chorusDirectoryResult.service_code_required)}
                            </strong>
                          </div>
                          <div className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-2">
                            <span className="block text-[#64748b]">Engagement juridique</span>
                            <strong className="text-[#0f172a]">
                              {chorusRequirementLabel(chorusDirectoryResult.commitment_required)}
                            </strong>
                          </div>
                          <div className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-2">
                            <span className="block text-[#64748b]">Code service ou engagement</span>
                            <strong className="text-[#0f172a]">
                              {chorusRequirementLabel(
                                chorusDirectoryResult.service_or_commitment_required,
                                "Au moins l’un des deux requis",
                              )}
                            </strong>
                          </div>
                        </div>

                        {chorusSelectedService ? (
                          <div className="rounded-lg border border-[#bfdbfe] bg-white px-3 py-2 text-[0.72rem] text-[#1e3a8a]">
                            <span className="block font-bold">
                              Service sélectionné : {chorusSelectedServiceCode || "Code non communiqué"}
                              {chorusSelectedServiceLabel ? ` — ${chorusSelectedServiceLabel}` : ""}
                            </span>
                            <span className="mt-1 block">
                              {chorusSelectedServiceRequiresCommitment
                                ? "Ce service impose un numéro d’engagement juridique."
                                : chorusDirectoryResult.raw_payload?.service_rules_complete === true
                                  ? "Aucun engagement juridique obligatoire n’est signalé pour ce service."
                                  : "La règle d’engagement de ce service n’est pas confirmée."}
                            </span>
                          </div>
                        ) : null}

                        {chorusMissingRequirements.length > 0 ? (
                          <div
                            role="alert"
                            className="rounded-lg border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-[0.72rem] font-semibold text-[#92400e]"
                          >
                            {chorusMissingRequirements.map((message) => (
                              <div key={message}>• {message}</div>
                            ))}
                          </div>
                        ) : null}

                        <div>
                          <div className="text-[0.72rem] font-bold text-[#334155]">Services actifs rattachés</div>
                          {chorusActiveServices.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {chorusActiveServices.map((service) => (
                                <span
                                  key={service.key}
                                  className="rounded-full border border-[#bbf7d0] bg-white px-2.5 py-1 text-[0.7rem] font-semibold text-[#047857]"
                                >
                                  {service.code || "Sans code"}
                                  {service.label ? ` — ${service.label}` : ""}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-1 text-[0.72rem] text-[#64748b]">Aucun service actif renvoyé.</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {(!siretOk || !sirenOk || !vatOk) && !isIndividual ? (
                  <div className="mt-3 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-[0.75rem] leading-relaxed text-[#92400e]">
                    {!siretOk
                      ? "Le SIRET saisi semble invalide."
                      : !sirenOk
                        ? "Le SIREN saisi semble invalide."
                        : "Le numéro de TVA semble incohérent."}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card>
            <CustomerSectionHeader title="Réglages" badge={<StatusPill status="muted" label="Optionnel" />} />

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CustomerInputField
                label="Conditions de paiement"
                value={form.payment_terms_default || ""}
                onChange={(event) => update("payment_terms_default", event.target.value)}
                placeholder="30 jours fin de mois"
              />
              <CustomerSelectField
                label="Moyen de paiement"
                value={normalizeCustomerPaymentMethodDefault(form.payment_method_default) || "virement"}
                onChange={(event) => update("payment_method_default", event.target.value)}
              >
                {CUSTOMER_PAYMENT_METHOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </CustomerSelectField>
              <CustomerInputField
                label="TVA par défaut (%)"
                type="number"
                min="0"
                step="0.01"
                value={form.default_vat_rate ?? ""}
                onChange={(event) => update("default_vat_rate", event.target.value)}
                placeholder="20"
              />
              {isBusiness && einvoicingAvailable ? (
                <>
                  <CustomerInputField
                    label="Identifiant de routage e-facturation"
                    value={form.endpoint_id || ""}
                    onChange={(event) => update("endpoint_id", event.target.value)}
                    placeholder="Identifiant communiqué par la PA"
                    hint="Champ de préparation Pro. Il n'active aucun connecteur à lui seul."
                    autoComplete="off"
                  />
                  <CustomerInputField
                    label="Plateforme agréée (PA) déclarée"
                    value={form.pdp_name || ""}
                    onChange={(event) => update("pdp_name", event.target.value)}
                    placeholder="Nom de la plateforme agréée"
                    autoComplete="off"
                  />
                </>
              ) : null}
            </div>
          </Card>
        </div>
      </fieldset>
    </div>
  );
}

export function CustomersListPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const customerFiltersRef = useRef<HTMLDivElement | null>(null);
  const { overview } = useCockpit();
  const { user } = useSession();
  const canWriteCustomers = can(user, "customers:write");
  const canExportCustomers = can(user, "customers:export");
  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [subscriptionGate, setSubscriptionGate] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [portfolioByCustomerId, setPortfolioByCustomerId] = useState<Record<string, any>>({});
  const [customerPeriod, setCustomerPeriod] = useState("30");
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);
  const [customerTypeFilter, setCustomerTypeFilter] = useState("all");
  const [customerCountryFilter, setCustomerCountryFilter] = useState("all");
  const [customerComplianceFilter, setCustomerComplianceFilter] = useState("all");

  const loadCustomers = async (query = search) => {
    setLoading(true);
    setError(null);
    setSubscriptionGate(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", "200");
      params.set("offset", "0");
      if ((query || "").trim()) params.set("q", query.trim());
      const res = await rawApi(`/api/customers?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const detail = payload?.detail;
        const code = typeof detail === "object" ? detail?.code : payload?.code;
        if (res.status === 402 || code === "subscription_required") {
          const message = extractUserFacingApiMessage(payload, res.status, "Cette page nécessite un abonnement actif.");
          setItems([]);
          setTotalCount(0);
          setSubscriptionGate(
            /^abonnement requis\.?$/i.test(String(message).trim())
              ? "Choisissez un abonnement pour réactiver l'accès aux clients."
              : message,
          );
          return;
        }
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger les clients."));
      }
      const data = await res.json().catch(() => []);
      setItems(Array.isArray(data) ? data : []);
      const header = Number(res.headers.get("x-total-count") || "0");
      setTotalCount(Number.isFinite(header) && header > 0 ? header : null);
    } catch (err) {
      setItems([]);
      setSubscriptionGate(null);
      setError(formatApiError(err, "Impossible de charger les clients."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const loadPortfolioSummary = async () => {
      try {
        const res = await rawApi("/api/ops/customer-portfolio");
        const data = await res.json().catch(() => null);
        if (!res.ok) throw data || new Error("Portefeuille indisponible.");
        if (!cancelled) {
          const map: Record<string, any> = {};
          (Array.isArray(data?.items) ? data.items : []).forEach((item: any) => {
            if (item?.customer_id) map[item.customer_id] = item;
          });
          setPortfolioByCustomerId(map);
        }
      } catch {
        if (!cancelled) {
          setPortfolioByCustomerId({});
        }
      }
    };
    void loadPortfolioSummary();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!customerFilterOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && customerFiltersRef.current?.contains(target)) return;
      setCustomerFilterOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [customerFilterOpen]);

  const stats = useMemo(() => {
    const withEmail = items.filter((item) => item.email).length;
    const withBusinessIds = items.filter((item) => item.siret || item.vat_number).length;
    const frCustomers = items.filter((item) => (item.country || "").toUpperCase() === "FR").length;
    return { withEmail, withBusinessIds, frCustomers };
  }, [items]);
  const customerModule = overview?.modules?.customers;
  const customerSummary = customerModule?.summary;
  const customerFocus = customerModule?.focus || null;
  const customerOverviewStats = useMemo<ModuleOverviewStat[]>(
    () => [
      {
        label: "Base clients",
        value: customerSummary?.total_count ?? totalCount ?? items.length,
        detail: `${customerSummary?.active_count ?? totalCount ?? items.length} actif(s) dans cet espace`,
        icon: <Users className="w-4 h-4" />,
        tone: "blue",
      },
      {
        label: "Joignables",
        value: customerSummary?.with_email_count ?? stats.withEmail,
        detail: "Comptes avec email exploitable",
        icon: <Mail className="w-4 h-4" />,
        tone: "green",
      },
      {
        label: "Identifiés",
        value: customerSummary?.with_business_ids_count ?? stats.withBusinessIds,
        detail: "SIRET ou TVA renseignés",
        icon: <ReceiptText className="w-4 h-4" />,
        tone: "purple",
      },
      {
        label: "À surveiller",
        value: customerSummary?.risk_count ?? 0,
        detail: `${customerSummary?.top_accounts_count ?? 0} compte(s) clé(s) suivis`,
        icon: <ArrowUpRight className="w-4 h-4" />,
        tone: (customerSummary?.risk_count ?? 0) > 0 ? "red" : "cyan",
      },
    ],
    [customerSummary, items.length, stats.withBusinessIds, stats.withEmail, totalCount],
  );
  const customerTableItems = useMemo(
    () =>
      items.filter((customer) => {
        if (!customerMatchesPeriod(customer, customerPeriod)) return false;
        const customerType = String(customer?.client_type || "business").toLowerCase();
        if (customerTypeFilter !== "all" && customerType !== customerTypeFilter) return false;
        if (customerCountryFilter === "fr" && String(customer?.country || "").toUpperCase() !== "FR") return false;
        if (customerCountryFilter === "foreign" && String(customer?.country || "").toUpperCase() === "FR") return false;
        if (customerComplianceFilter !== "all") {
          const status = complianceStatus(customer).color;
          if (customerComplianceFilter === "complete" && status !== "ok") return false;
          if (customerComplianceFilter === "partial" && status !== "warn") return false;
          if (customerComplianceFilter === "missing" && status !== "muted") return false;
        }
        return true;
      }),
    [customerComplianceFilter, customerCountryFilter, customerPeriod, customerTypeFilter, items],
  );
  const customerHasActiveTableFilters =
    customerPeriod !== "30" ||
    customerTypeFilter !== "all" ||
    customerCountryFilter !== "all" ||
    customerComplianceFilter !== "all";

  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await downloadProtectedFile("/api/customers/export.csv", "clients.csv");
      setNotice("Export de tous les clients lancé.");
    } catch (err) {
      setError(formatApiError(err, "Export de tous les clients impossible."));
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isCsvFile(file)) {
      setNotice(null);
      setError("Import CSV impossible : sélectionnez un fichier .csv.");
      event.target.value = "";
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result: any = await apiUpload("/api/customers/import", formData);
      const imported = Number(result?.imported || 0);
      const skipped = Number(result?.skipped || 0);
      setNotice(`Import terminé : ${imported} créé(s), ${skipped} ignoré(s).`);
      await loadCustomers();
    } catch (err) {
      setError(formatApiError(err, "Import CSV impossible."));
    } finally {
      setBusy(false);
      if (event.target) event.target.value = "";
    }
  };

  const customerVisibleCount = customerTableItems.length;
  const customerLoadedCount = items.length;
  const customerReachableCount = Number(customerSummary?.with_email_count ?? stats.withEmail ?? 0);
  const customerQualifiedCount = Number(customerSummary?.with_business_ids_count ?? stats.withBusinessIds ?? 0);
  const customerRiskCount = Number(customerSummary?.risk_count ?? 0);
  const customerPulse = [
    {
      label: "Joignables",
      value: customerReachableCount,
      tone: customerReachableCount > 0 ? "ok" : "muted",
    },
    {
      label: "Identifiés",
      value: customerQualifiedCount,
      tone: customerQualifiedCount > 0 ? "info" : "muted",
    },
    {
      label: "Sous tension",
      value: customerRiskCount,
      tone: customerRiskCount > 0 ? "warn" : "muted",
    },
  ] as const;

  return (
    <div>
      <AppPageHeader
        title="Clients"
        breadcrumb="CRM"
        description="Clients : création, import CSV, édition, portail et historique documentaire."
        actions={
          <div className="flex flex-wrap gap-2 justify-end">
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={importCsv} />
            <ActionMenu label="Outils">
              {canWriteCustomers ? (
                <ActionMenuButton icon={FileUp} onClick={() => fileInputRef.current?.click()} disabled={busy}>
                  Import CSV
                </ActionMenuButton>
              ) : null}
              {canExportCustomers ? (
                <ActionMenuButton icon={FileDown} onClick={exportCsv} disabled={busy}>
                  Exporter tous les clients
                </ActionMenuButton>
              ) : null}
              <ActionMenuLink to="/app/portfolio" icon={ArrowUpRight}>
                Portefeuille client
              </ActionMenuLink>
            </ActionMenu>
            {canWriteCustomers ? (
              <Link
                to="/app/customers/new"
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#1d4ed8] px-4 py-2 text-white transition-all hover:bg-[#1b46c2]"
                style={{ fontSize: "0.8125rem", fontWeight: 700, boxShadow: "0 1px 2px rgba(29,78,216,0.18)" }}
              >
                <Plus className="w-3.5 h-3.5" /> Créer un client
              </Link>
            ) : null}
          </div>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-5">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {subscriptionGate ? (
          <NoticeBanner
            tone="warning"
            title="Abonnement requis"
            action={
              <Link
                to="/app/billing/paywall"
                className="inline-flex items-center justify-center rounded-lg bg-[#92400e] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#78350f]"
              >
                Choisir un abonnement
              </Link>
            }
          >
            {subscriptionGate}
          </NoticeBanner>
        ) : null}
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

        <Card padding={false} className="overflow-hidden border border-[#dce5ef] bg-white/96">
          <div className="grid gap-5 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.12),transparent_30%),linear-gradient(180deg,#fbfdff_0%,#f7fbff_100%)] p-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-6">
            <div>
              <div className="inline-flex rounded-full border border-[#d9e5f0] bg-white/92 px-2.5 py-1 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#6f8298]">
                Base clients
              </div>
              <h2 className="mt-3 text-[1.3rem] font-[780] tracking-[-0.04em] text-[#0f172a]">
                Travaille la base comme un vrai poste de pilotage commercial.
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#607389]">
                Joignabilité, identifiants métier et signaux portefeuille remontent ensemble pour éviter les fiches
                muettes ou trop faibles.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {customerPulse.map((item) => (
                  <StatusPill key={item.label} status={item.tone} label={`${item.label} · ${item.value}`} />
                ))}
                <StatusPill status="info" label={`${totalCount ?? customerLoadedCount} client(s) base totale`} />
              </div>
            </div>

            <div className="rounded-[22px] border border-[#dce5ef] bg-white/92 p-4 shadow-[0_16px_28px_-26px_rgba(15,23,42,0.35)]">
              {customerFocus ? (
                <>
                  <StatusPill status={customerFocus.tone} label={customerFocus.label} />
                  <div className="mt-3 text-[1rem] font-[760] tracking-[-0.03em] text-[#0f172a]">
                    {customerFocus.title}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-[#607389]">{customerFocus.description}</p>
                  {customerFocus.href ? (
                    <Link
                      to={customerFocus.href}
                      className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
                    >
                      Ouvrir le dossier prioritaire
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  ) : null}
                </>
              ) : (
                <>
                  <StatusPill status="ok" label="Base exploitable" />
                  <div className="mt-3 text-[1rem] font-[760] tracking-[-0.03em] text-[#0f172a]">
                    La base est prête pour les devis, factures et actions portefeuille.
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-[#607389]">
                    Passez par le portefeuille pour prioriser les comptes à surveiller, ou ouvrez une fiche pour
                    enrichir le dossier client.
                  </p>
                  <Link
                    to="/app/portfolio"
                    className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
                  >
                    Ouvrir le portefeuille clients
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </>
              )}
            </div>
          </div>
        </Card>

        {loading ? (
          <LoadingCard label="Chargement des clients…" />
        ) : items.length === 0 ? (
          <EmptyCard
            title="Aucun client trouvé"
            description={
              canWriteCustomers
                ? "Créez votre premier client ou importez un CSV pour démarrer vos devis et factures."
                : "Aucun client à afficher pour le moment."
            }
            action={
              canWriteCustomers ? (
                <Link
                  to="/app/customers/new"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white transition-all shadow-sm"
                  style={{
                    fontSize: "0.8125rem",
                    fontWeight: 500,
                    background: "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
                  }}
                >
                  <Plus className="w-3.5 h-3.5" /> Créer un client
                </Link>
              ) : null
            }
          />
        ) : (
          <Card padding={false} className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eef2f7] px-4 py-4 lg:px-5">
              <div>
                <div className="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-[#8ea0b5]">
                  Workbench client
                </div>
                <div className="mt-1 text-[1rem] font-[760] tracking-[-0.03em] text-[#0f172a]">
                  Base synchronisée avec le portefeuille
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill status="info" label={`${customerVisibleCount} résultat(s)`} />
                <StatusPill
                  status={customerRiskCount > 0 ? "warn" : "ok"}
                  label={customerRiskCount > 0 ? `${customerRiskCount} à revoir` : "Base stable"}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2 border-b border-[#eef2f7] px-4 py-3 sm:flex-row sm:items-center sm:justify-end lg:px-5">
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[#fed7aa] bg-white px-3 py-2 transition-colors focus-within:border-[#f97316] sm:w-[20rem]">
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-[#fb923c]" />
                <input
                  placeholder="Nom, email, SIRET, TVA..."
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#334155] placeholder:text-[#94a3b8] outline-none"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Rechercher un client"
                />
              </div>
              <SalesPeriodControl
                tone="clients"
                value={customerPeriod}
                onChange={(nextValue) => setCustomerPeriod(nextValue)}
                options={CUSTOMER_PERIOD_OPTIONS}
                ariaLabel="Période des clients"
              />
              <div ref={customerFiltersRef} className="relative">
                <button
                  type="button"
                  className="pf-filter-button inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 transition-all"
                  data-active={customerFilterOpen || customerHasActiveTableFilters ? "true" : undefined}
                  aria-pressed={customerFilterOpen || customerHasActiveTableFilters}
                  aria-label="Filtres clients"
                  onClick={() => setCustomerFilterOpen((current) => !current)}
                  style={
                    {
                      "--pf-module-soft": "#fff7ed",
                      "--pf-module-strong": "#ea580c",
                      "--pf-module-border": "#fdba74",
                      "--tw-ring-color": "#fdba74",
                      fontSize: "var(--pf-app-text-body)",
                      fontWeight: 800,
                    } as CSSProperties
                  }
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>Filtres</span>
                </button>
                {customerFilterOpen ? (
                  <div
                    role="dialog"
                    aria-label="Filtres clients avancés"
                    className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-[#fdba74] bg-white p-4 text-left shadow-[0_18px_42px_-24px_rgba(154,52,18,0.7)]"
                  >
                    <div
                      className="mb-3 flex items-center gap-2 uppercase tracking-[0.08em] text-[#ea580c]"
                      style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" /> Filtres clients
                    </div>
                    <div className="grid gap-3">
                      <label
                        className="grid gap-1 text-[#9a3412]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                      >
                        Type
                        <select
                          value={customerTypeFilter}
                          onChange={(event) => setCustomerTypeFilter(event.target.value)}
                          className="h-10 rounded-xl border border-[#fed7aa] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#f97316] focus:ring-2 focus:ring-[#f97316]/20"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="all">Tous</option>
                          <option value="business">Entreprises</option>
                          <option value="individual">Particuliers</option>
                          <option value="public">Public</option>
                        </select>
                      </label>
                      <label
                        className="grid gap-1 text-[#9a3412]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                      >
                        Pays
                        <select
                          value={customerCountryFilter}
                          onChange={(event) => setCustomerCountryFilter(event.target.value)}
                          className="h-10 rounded-xl border border-[#fed7aa] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#f97316] focus:ring-2 focus:ring-[#f97316]/20"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="all">Tous les pays</option>
                          <option value="fr">France</option>
                          <option value="foreign">Hors France</option>
                        </select>
                      </label>
                      <label
                        className="grid gap-1 text-[#9a3412]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                      >
                        Conformité
                        <select
                          value={customerComplianceFilter}
                          onChange={(event) => setCustomerComplianceFilter(event.target.value)}
                          className="h-10 rounded-xl border border-[#fed7aa] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#f97316] focus:ring-2 focus:ring-[#f97316]/20"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="all">Tous les statuts</option>
                          <option value="complete">Identifiés</option>
                          <option value="partial">Partiels</option>
                          <option value="missing">À compléter</option>
                        </select>
                      </label>
                    </div>
                    {customerHasActiveTableFilters ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomerPeriod("30");
                          setCustomerTypeFilter("all");
                          setCustomerCountryFilter("all");
                          setCustomerComplianceFilter("all");
                        }}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[#ea580c] transition-colors hover:bg-[#fff7ed]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                      >
                        <Check className="h-3.5 w-3.5" /> Revenir aux filtres par défaut
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <DataTable headers={["Client", "Pays", "Portefeuille", "Identifiants", "Conformité", ""]}>
              {customerTableItems.map((customer) => {
                const status = complianceStatus(customer);
                const signal = portfolioByCustomerId[customer.id];
                const signalTone = portfolioHealthTone(signal?.health_score);
                return (
                  <tr key={customer.id} className="hover:bg-[#f8fafc] transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1d4ed8]/10 to-[#7c3aed]/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-[#1d4ed8]" style={{ fontSize: "0.6875rem", fontWeight: 700 }}>
                            {(customer.name || "?").charAt(0)}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <Link
                            to={`/app/customers/${customer.id}`}
                            className="text-sm font-semibold text-[#0f172a] transition-colors hover:text-[#1d4ed8]"
                          >
                            {customer.name}
                          </Link>
                          <div className="text-[0.6875rem] text-[#8ca0b3]">
                            {customer.email || "Sans email"} · {customerTypeLabel(customer)}
                          </div>
                          <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                            <StatusPill color={status.color} label={status.label} />
                            {signal ? (
                              <>
                                <StatusPill {...portfolioRiskPill(signal)} />
                                <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#475569]">
                                  Encours {money(signal.open_balance || 0)}
                                </span>
                              </>
                            ) : (
                              <StatusPill status="muted" label="Portefeuille…" />
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <span>{countryFlags[(customer.country || "").toUpperCase()] || "🌍"}</span>
                        <span className="text-sm text-[#475569]">{(customer.country || "—").toUpperCase()}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {!signal ? (
                        <StatusPill status="muted" label="Calcul portefeuille…" />
                      ) : (
                        <div className="space-y-1.5 min-w-[180px]">
                          <div className="flex flex-wrap gap-1.5">
                            <StatusPill {...portfolioSegmentPill(signal)} />
                            <StatusPill {...portfolioRiskPill(signal)} />
                          </div>
                          <div className="text-xs text-[#475569]">
                            Santé {signal.health_score}/100 · encours {money(signal.open_balance || 0)}
                          </div>
                          <div className="flex items-center gap-1.5 text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                            <span
                              className={`inline-block w-1.5 h-1.5 rounded-full ${signalTone.status === "danger" ? "bg-[#ef4444]" : signalTone.status === "warn" ? "bg-[#f59e0b]" : signalTone.status === "info" ? "bg-[#3b82f6]" : "bg-[#10b981]"}`}
                            />
                            {signal.next_step_title || "Suivi portefeuille"}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {customerShowsLegalIdentity(customer) ? (
                        <div className="space-y-1 text-xs">
                          <div className="font-mono text-[#64748b]">{customer.siret || "SIRET —"}</div>
                          <div className="font-mono text-[#94a3b8]">{customer.vat_number || "TVA —"}</div>
                        </div>
                      ) : (
                        <div className="text-xs font-semibold text-[#64748b]">Profil particulier</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1.5">
                        <StatusPill color={status.color} label={status.label} />
                        <div className="text-[0.6875rem] text-[#94a3b8]">
                          {customer.phone || "Téléphone non renseigné"}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/customers/${customer.id}`}
                        className="pf-action-icon pf-action-icon--customer"
                        aria-label={`Ouvrir ${customer.name || "client"}`}
                        title="Ouvrir"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
            <div className="px-4 pb-4 pt-3 text-xs text-[#94a3b8] lg:px-5">
              {customerVisibleCount} affiché(s) sur {totalCount ?? customerLoadedCount} client(s) · base synchronisée
              avec le portefeuille
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function customerInitials(name?: string | null, email?: string | null) {
  const source = String(name || email || "?").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function CustomerPanelStat({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  tone?: "slate" | "green";
}) {
  const palette =
    tone === "green"
      ? { bg: "#ecfdf5", border: "#bbf7d0", text: "#059669" }
      : { bg: "#f8fafc", border: "#e2e8f0", text: "#0f172a" };
  return (
    <div
      className="rounded-xl border px-3 py-3 text-center"
      style={{ background: palette.bg, borderColor: palette.border }}
    >
      <div
        className="text-[#94a3b8]"
        style={{ fontSize: "0.62rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
      >
        {label}
      </div>
      <div className="mt-1 tabular-nums" style={{ color: palette.text, fontSize: "0.95rem", fontWeight: 850 }}>
        {value}
      </div>
    </div>
  );
}

function CustomerPanelSection({
  title,
  icon: Icon,
  tone = "slate",
  rightSlot,
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone?: "green" | "blue" | "amber" | "slate";
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  const palette = {
    green: { bg: "#ecfdf5", text: "#059669" },
    blue: { bg: "#eff6ff", text: "#2563eb" },
    amber: { bg: "#fffbeb", text: "#d97706" },
    slate: { bg: "#f1f5f9", text: "#64748b" },
  }[tone];
  return (
    <section className="border-t border-[#e2e8f0] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ background: palette.bg }}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: palette.text }} />
          </span>
          <h3 className="truncate text-[#0f172a]" style={{ fontSize: "0.82rem", fontWeight: 800 }}>
            {title}
          </h3>
        </div>
        {rightSlot ? <span className="flex shrink-0 items-center gap-2">{rightSlot}</span> : null}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function CustomerPanelRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-[#475569]" style={{ fontSize: "0.78rem" }}>
      <span className="text-[#94a3b8]">{label}</span>
      <span className="max-w-[62%] text-right font-semibold text-[#0f172a]">{value}</span>
    </div>
  );
}

function cleanCustomerIdentifier(value: any) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

function customerSupplierSearchTerm(customer: any) {
  return (
    cleanCustomerIdentifier(customer?.siret) ||
    cleanCustomerIdentifier(customer?.siren) ||
    cleanCustomerIdentifier(customer?.vat_number) ||
    String(customer?.name || "").trim()
  );
}

function purchaseSupplierMatchesCustomer(customer: any, supplier: any) {
  const customerSiret = cleanCustomerIdentifier(customer?.siret);
  const customerSiren = cleanCustomerIdentifier(customer?.siren || deriveSirenFromSiret(customer?.siret || ""));
  const customerVat = cleanCustomerIdentifier(customer?.vat_number);
  const supplierSiret = cleanCustomerIdentifier(supplier?.supplier_siret);
  const supplierSiren = cleanCustomerIdentifier(supplier?.supplier_siren);
  const supplierVat = cleanCustomerIdentifier(supplier?.vat_number);
  if (customerSiret && supplierSiret && customerSiret === supplierSiret) return true;
  if (customerSiren && supplierSiren && customerSiren === supplierSiren) return true;
  if (customerVat && supplierVat && customerVat === supplierVat) return true;
  return false;
}

function supplierRelationMissingLabel(value: string) {
  const labels: Record<string, string> = {
    siren_client: "SIREN client",
    siret_client: "SIRET client",
    tva_client: "TVA client",
    compte_achat_fournisseur: "compte achat",
    nature_achat_fournisseur: "nature achat",
  };
  return labels[value] || value;
}

function customerSupplierMergeDirectionLabel(value: string) {
  const labels: Record<string, string> = {
    keep: "Garder",
    supplier_to_customer: "Reprendre achat",
    customer_to_supplier: "Envoyer côté achat",
  };
  return labels[value] || value;
}

function CustomerDetailSidebar({
  customer,
  stats,
  supplierMatches = [],
  supplierRelation,
  onOpenSupplierMerge,
  onConfirmSupplierRelation,
  confirmingSupplierRelationId,
  onCustomerUpdated,
  canWriteCustomer = false,
}: {
  customer: any;
  stats: any;
  supplierMatches?: any[];
  supplierRelation?: any;
  onOpenSupplierMerge?: (supplierId: string) => void;
  onConfirmSupplierRelation?: (supplierId: string) => void;
  confirmingSupplierRelationId?: string | null;
  onCustomerUpdated?: (customer: any) => void;
  canWriteCustomer?: boolean;
}) {
  const invoiceCount = Number(stats?.invoice_count ?? customer?.invoice_count ?? 0);
  const totalRevenue = stats?.total_revenue ?? customer?.total_revenue ?? 0;
  const initials = customerInitials(customer?.name, customer?.email);
  const supplierSearch = encodeURIComponent(customerSupplierSearchTerm(customer));
  const relationItems = Array.isArray(supplierRelation?.items) ? supplierRelation.items : supplierMatches;
  const relationSummary = supplierRelation?.summary || null;
  const firstSupplierMatch = relationItems[0];
  const supplierInvoiceCount =
    Number(relationSummary?.invoice_count ?? 0) ||
    relationItems.reduce((total: number, item: any) => total + Number(item?.invoice_count || 0), 0);
  const supplierTotalTtc =
    Number(relationSummary?.total_ttc ?? 0) ||
    relationItems.reduce((total: number, item: any) => total + Number(item?.total_ttc || 0), 0);
  const supplierReviewCount =
    Number(relationSummary?.needs_review_count ?? 0) ||
    relationItems.filter((item: any) => Array.isArray(item?.missing_fields) && item.missing_fields.length).length;
  const supplierMissingLabels = Array.isArray(firstSupplierMatch?.missing_fields)
    ? firstSupplierMatch.missing_fields.map((field: string) => supplierRelationMissingLabel(field)).slice(0, 3)
    : [];
  const supplierRelationConfirmed = firstSupplierMatch?.relation_status === "confirmed";
  const quoteCount = Number(stats?.quote_count ?? customer?.quote_count ?? customer?.quotes_count ?? 0);
  const totalRevenueNumber = Number(totalRevenue || 0);
  const country = String(customer?.country || customer?.country_code || "FR").toUpperCase();
  const readiness = customerCreationReadiness({
    ...EMPTY_CUSTOMER,
    ...customer,
    country,
    country_code: country,
  });
  const address = customerDisplayAddress(customer);
  const businessId = customerShowsLegalIdentity(customer)
    ? formatSiretInput(customer?.siret || "") || formatSirenInput(customer?.siren || "") || "À renseigner"
    : "Profil particulier";
  const paymentMethod = normalizeCustomerPaymentMethodDefault(customer?.payment_method_default);
  const paymentMethodLabel =
    CUSTOMER_PAYMENT_METHOD_OPTIONS.find((option) => option.value === paymentMethod)?.label || "À renseigner";
  const preparationStatus = [
    { label: "Fiche", ok: readiness.score >= 80 },
    { label: "Devis", ok: quoteCount > 0 },
    { label: "Facture", ok: invoiceCount > 0 },
    { label: "Paiement", ok: totalRevenueNumber > 0 },
  ];
  const readinessPillTone = readiness.score >= 85 ? "ok" : readiness.score >= 60 ? "warn" : "danger";

  return (
    <aside className="h-fit overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_12px_28px_-24px_rgba(15,23,42,0.5)] xl:sticky xl:top-4">
      <section className="border-b border-[#eef2f7] p-4">
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#10b981] text-white"
            style={{ fontSize: "0.75rem", fontWeight: 850 }}
          >
            {initials}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.92rem", fontWeight: 850 }}>
              {customer?.name || "Client à compléter"}
            </div>
            <div className="truncate text-[#2563eb]" style={{ fontSize: "0.75rem", fontWeight: 620 }}>
              {customer?.email || businessId}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <CustomerPanelStat label="Profil" value={`${readiness.score}%`} />
          <CustomerPanelStat label="Pays" value={country} />
        </div>
      </section>

      <CustomerPanelSection
        title="Préparation"
        icon={CheckCircle2}
        tone="blue"
        rightSlot={<StatusPill color={readinessPillTone} label={`${readiness.score}%`} />}
      >
        {preparationStatus.map((item) => (
          <div
            key={item.label}
            className={`rounded-xl px-3 py-2 ${
              item.ok ? "border border-[#dcfce7] bg-[#f0fdf4]" : "border border-[#eef2f7] bg-[#f8fafc]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.75rem] font-bold text-[#0f172a]">{item.label}</span>
              <span className={`text-[0.7rem] font-bold ${item.ok ? "text-[#059669]" : "text-[#d97706]"}`}>
                {item.ok ? "Prêt" : "À finaliser"}
              </span>
            </div>
          </div>
        ))}
      </CustomerPanelSection>

      <CustomerPanelSection title="Document" icon={FileText} tone="green">
        <CustomerPanelRow
          label="Statut"
          value={<StatusPill color={complianceStatus(customer).color} label={complianceStatus(customer).label} />}
        />
        <CustomerPanelRow label="Type" value={customerTypeLabel(customer)} />
        <CustomerPanelRow label="Email" value={customer?.email || "À renseigner"} />
        <CustomerPanelRow label="Téléphone" value={customer?.phone || "À renseigner"} />
        {customerShowsLegalIdentity(customer) ? (
          <>
            <CustomerPanelRow
              label="SIREN"
              value={formatSirenInput(customer?.siren || deriveSirenFromSiret(customer?.siret || "")) || "—"}
            />
            <CustomerPanelRow label="SIRET" value={formatSiretInput(customer?.siret || "") || "—"} />
            <CustomerPanelRow label="TVA" value={formatVatNumberInput(customer?.vat_number || "") || "—"} />
          </>
        ) : null}
        <CustomerPanelRow label="Adresse" value={address || "À renseigner"} />
      </CustomerPanelSection>

      <CustomerPanelSection title="Paiement" icon={ReceiptText} tone="amber">
        <CustomerPanelRow label="Conditions" value={customer?.payment_terms_default || "À renseigner"} />
        <CustomerPanelRow label="Moyen" value={paymentMethodLabel} />
        <CustomerPanelRow label="Factures" value={`${invoiceCount} document${invoiceCount > 1 ? "s" : ""}`} />
        <CustomerPanelRow label="CA total" value={money(totalRevenueNumber)} />
        <div className="pt-3">
          <Link
            to={`/app/invoices?customer_id=${customer?.id || ""}`}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-[#bfdbfe] bg-[#eff6ff]/60 text-[#1d4ed8] transition hover:bg-[#dbeafe]"
            style={{ fontSize: "0.75rem", fontWeight: 800 }}
          >
            <FileText className="h-3.5 w-3.5" /> Voir les factures
          </Link>
        </div>
      </CustomerPanelSection>

      {relationItems.length ? (
        <CustomerPanelSection
          title="Relation achats"
          icon={Building2}
          tone="blue"
          rightSlot={
            <StatusPill
              color={supplierRelationConfirmed ? "ok" : "info"}
              label={supplierRelationConfirmed ? "Lien confirmé" : "Aussi fournisseur"}
            />
          }
        >
          <div className="rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-3 py-2 text-[#1e3a8a]">
            <div className="text-[#0f172a]" style={{ fontSize: "0.78rem", fontWeight: 850 }}>
              {firstSupplierMatch?.supplier_name || firstSupplierMatch?.name || customer?.name}
            </div>
            <div className="mt-1 text-[#475569]" style={{ fontSize: "0.72rem", lineHeight: 1.35 }}>
              {relationItems.length} fiche{relationItems.length > 1 ? "s" : ""} fournisseur achat correspondent a ce
              client.
            </div>
          </div>
          <CustomerPanelRow
            label="Achats"
            value={`${supplierInvoiceCount} document${supplierInvoiceCount > 1 ? "s" : ""}`}
          />
          <CustomerPanelRow label="Total achat TTC" value={money(supplierTotalTtc)} />
          <CustomerPanelRow
            label="Dernier achat"
            value={
              firstSupplierMatch?.last_used_at ||
              firstSupplierMatch?.last_received_at ||
              firstSupplierMatch?.last_issue_date
                ? formatDateTimeFr(
                    firstSupplierMatch.last_used_at ||
                      firstSupplierMatch.last_received_at ||
                      firstSupplierMatch.last_issue_date,
                    "—",
                  )
                : "—"
            }
          />
          <CustomerPanelRow
            label="Catégorie compta achat"
            value={firstSupplierMatch?.default_accounting_account || "Non renseigné"}
          />
          {firstSupplierMatch?.establishment_warning ? (
            <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-[#9a3412]">
              <div style={{ fontSize: "0.74rem", fontWeight: 850 }}>Établissement à vérifier</div>
              <div className="mt-1" style={{ fontSize: "0.7rem", lineHeight: 1.35 }}>
                Même SIREN, mais SIRET différent. Vérifiez que c'est le bon établissement avant d'harmoniser.
              </div>
            </div>
          ) : null}
          {supplierReviewCount ? (
            <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-[#9a3412]">
              <div style={{ fontSize: "0.74rem", fontWeight: 850 }}>{supplierReviewCount} point(s) à harmoniser</div>
              <div className="mt-1" style={{ fontSize: "0.7rem", lineHeight: 1.35 }}>
                {supplierMissingLabels.length
                  ? supplierMissingLabels.join(" · ")
                  : "Compléter la fiche fournisseur ou client."}
              </div>
            </div>
          ) : null}
          <Link
            to={`/app/purchases?q=${supplierSearch}`}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-white text-[#0f4cc9] ring-1 ring-[#bfdbfe] transition hover:bg-[#dbeafe]"
            style={{ fontSize: "0.74rem", fontWeight: 850 }}
          >
            Voir les achats
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          {canWriteCustomer && firstSupplierMatch?.id && onOpenSupplierMerge ? (
            <button
              type="button"
              onClick={() => onOpenSupplierMerge(firstSupplierMatch.id)}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-[#0f4cc9] px-3 text-white transition hover:bg-[#0b3aa0]"
              style={{ fontSize: "0.74rem", fontWeight: 850 }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Harmoniser
            </button>
          ) : null}
          {canWriteCustomer && firstSupplierMatch?.id && onConfirmSupplierRelation ? (
            <button
              type="button"
              disabled={supplierRelationConfirmed || confirmingSupplierRelationId === firstSupplierMatch.id}
              onClick={() => onConfirmSupplierRelation(firstSupplierMatch.id)}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-white px-3 text-[#0f4cc9] ring-1 ring-[#bfdbfe] transition hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:text-[#64748b] disabled:opacity-75"
              style={{ fontSize: "0.74rem", fontWeight: 850 }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {supplierRelationConfirmed
                ? "Lien enregistré"
                : confirmingSupplierRelationId === firstSupplierMatch.id
                  ? "Confirmation..."
                  : "Confirmer le lien"}
            </button>
          ) : null}
        </CustomerPanelSection>
      ) : null}
    </aside>
  );
}

function CustomerSupplierMergeModal({
  preview,
  choices,
  onChoice,
  onClose,
  onApply,
  saving,
  error,
  notice,
}: {
  preview: any;
  choices: Record<string, string>;
  onChoice: (field: string, direction: string) => void;
  onClose: () => void;
  onApply: () => void;
  saving: boolean;
  error: string | null;
  notice: string | null;
}) {
  if (!preview) return null;
  const fields = Array.isArray(preview.fields) ? preview.fields : [];
  const supplier = preview.supplier || {};
  const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
  const hasAction = Object.values(choices || {}).some((value) => value && value !== "keep");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Harmoniser client et fournisseur"
    >
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-[0_24px_80px_rgba(15,23,42,0.24)]">
        <div className="border-b border-[#dbe4f0] px-5 py-4">
          <div
            className="text-[#94a3b8]"
            style={{ fontSize: "0.68rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            Relation client / fournisseur
          </div>
          <div className="mt-1 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 850 }}>
            Harmoniser les informations de référence
          </div>
          <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8rem", lineHeight: 1.45 }}>
            Choisissez champ par champ ce qui doit être repris. L'historique des factures et des achats n'est pas
            déplacé.
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">
          {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
          {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
          <div className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
            <div className="text-[#0f172a]" style={{ fontSize: "0.82rem", fontWeight: 850 }}>
              {supplier.name || "Fournisseur achat"}
            </div>
            <div className="mt-1 text-[#475569]" style={{ fontSize: "0.75rem" }}>
              Harmonisation non destructive : seuls les champs sélectionnés seront mis à jour.
            </div>
          </div>
          {warnings.length ? (
            <div className="rounded-2xl border border-[#fed7aa] bg-[#fff7ed] px-4 py-3 text-[#9a3412]">
              {warnings.map((warning: string) => (
                <div
                  key={warning}
                  style={{
                    fontSize: "0.75rem",
                    lineHeight: 1.45,
                    fontWeight: preview.establishment_warning ? 760 : 520,
                  }}
                >
                  {warning}
                </div>
              ))}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-[#dbe4f0]">
            <div
              className="grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_220px] bg-[#f8fafc] px-3 py-2 text-[#64748b]"
              style={{ fontSize: "0.72rem", fontWeight: 850 }}
            >
              <div>Champ</div>
              <div>Client</div>
              <div>Fournisseur achat</div>
              <div>Choix</div>
            </div>
            {fields.map((field: any) => {
              const fieldName = String(field.field || "");
              const selected = choices[fieldName] || "keep";
              const customerValue = field.customer_value || "—";
              const supplierValue = field.supplier_value || "—";
              const options = [
                { key: "keep", disabled: false },
                { key: "supplier_to_customer", disabled: !field.supplier_value },
                { key: "customer_to_supplier", disabled: !field.customer_value },
              ];
              return (
                <div
                  key={fieldName}
                  className="grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_220px] items-center gap-3 border-t border-[#edf2f7] px-3 py-2"
                >
                  <div className="text-[#0f172a]" style={{ fontSize: "0.78rem", fontWeight: 850 }}>
                    {field.label || fieldName}
                    {field.conflict ? (
                      <div className="mt-0.5 text-[#f97316]" style={{ fontSize: "0.68rem", fontWeight: 800 }}>
                        Conflit
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="truncate text-[#475569]"
                    style={{ fontSize: "0.78rem" }}
                    title={String(customerValue)}
                  >
                    {customerValue}
                  </div>
                  <div
                    className="truncate text-[#475569]"
                    style={{ fontSize: "0.78rem" }}
                    title={String(supplierValue)}
                  >
                    {supplierValue}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {options.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        disabled={option.disabled || saving}
                        onClick={() => onChoice(fieldName, option.key)}
                        className={`rounded-full px-2.5 py-1 transition ${
                          selected === option.key
                            ? "bg-[#0f4cc9] text-white"
                            : "bg-white text-[#475569] ring-1 ring-[#dbe4f0] hover:bg-[#f8fafc]"
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                        style={{ fontSize: "0.68rem", fontWeight: 850 }}
                      >
                        {customerSupplierMergeDirectionLabel(option.key)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#dbe4f0] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[#475569] ring-1 ring-[#dbe4f0] transition hover:bg-[#f8fafc]"
            style={{ fontSize: "0.78rem", fontWeight: 850 }}
          >
            Fermer
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={saving || !hasAction}
            className="inline-flex h-9 items-center justify-center rounded-full bg-[#0f4cc9] px-4 text-white transition hover:bg-[#0b3aa0] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontSize: "0.78rem", fontWeight: 850 }}
          >
            {saving ? "Application…" : "Appliquer les choix"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomerNewSidebar({ form }: { form: any }) {
  const readiness = customerCreationReadiness(form);
  const displayName = String(form?.name || "").trim() || "Nouveau client";
  const displayEmail = String(form?.email || "").trim() || "Email non renseigné";
  const initials = customerInitials(displayName, displayEmail);
  const status =
    readiness.score >= 85
      ? { tone: "ok" as const, label: "Prêt" }
      : readiness.score >= 60
        ? { tone: "warn" as const, label: "À compléter" }
        : { tone: "muted" as const, label: "Brouillon" };
  const addressLabel =
    String(form?.address || "").trim() ||
    [form?.address_line1, form?.postal_code, form?.city].filter(Boolean).join(" ") ||
    "À renseigner";

  return (
    <aside className="overflow-hidden bg-white shadow-[0_10px_24px_rgba(15,23,42,0.06)] xl:sticky xl:top-4">
      <section className="px-4 py-5">
        <div className="flex items-center justify-between gap-3">
          <div
            className="text-[#94a3b8]"
            style={{ fontSize: "0.68rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            Aperçu client
          </div>
          <StatusPill status={status.tone} label={status.label} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#10b981] text-white"
            style={{ fontSize: "0.75rem", fontWeight: 850 }}
          >
            {initials}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.92rem", fontWeight: 850 }}>
              {displayName}
            </div>
            <div className="truncate text-[#4f46e5]" style={{ fontSize: "0.75rem", fontWeight: 520 }}>
              {displayEmail}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <CustomerPanelStat label="Type" value={readiness.typeLabel} />
          <CustomerPanelStat
            label="Profil"
            value={`${readiness.score}%`}
            tone={readiness.score >= 85 ? "green" : "slate"}
          />
        </div>
      </section>

      <CustomerPanelSection
        title="Préparation"
        icon={CheckCircle2}
        tone={readiness.score >= 85 ? "green" : "blue"}
        rightSlot={<StatusPill status={status.tone} label={`${readiness.score}%`} />}
      >
        <div className="space-y-2">
          {readiness.checks.map((item) => (
            <div key={item.label} className="flex items-start gap-2 rounded-xl bg-[#f8fafc] px-3 py-2">
              <CheckCircle2
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                style={{ color: item.ok ? "#16a34a" : "#cbd5e1" }}
              />
              <div className="min-w-0">
                <div className="text-[#0f172a]" style={{ fontSize: "0.76rem", fontWeight: 760 }}>
                  {item.label}
                </div>
                {!item.ok ? (
                  <div className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.7rem", lineHeight: 1.35 }}>
                    {item.hint}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <div
          className="rounded-xl border px-3 py-2 text-[#475569]"
          style={{ borderColor: "#dbeafe", background: "#eff6ff", fontSize: "0.74rem", lineHeight: 1.4 }}
        >
          {readiness.nextHint}
        </div>
      </CustomerPanelSection>

      <CustomerPanelSection title="Document" icon={FileText} tone="green">
        <CustomerPanelRow label="Statut" value="Brouillon local" />
        <CustomerPanelRow label="Pays" value={readiness.country} />
        <CustomerPanelRow label={readiness.identifierLabel} value={readiness.identityValue} />
        <CustomerPanelRow label="Adresse" value={addressLabel} />
      </CustomerPanelSection>

      <section className="border-t border-[#e2e8f0] px-4 py-4">
        <div
          className="text-[#94a3b8]"
          style={{ fontSize: "0.68rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
        >
          Après enregistrement
        </div>
        <p className="mt-2 text-[#64748b]" style={{ fontSize: "0.76rem", lineHeight: 1.45 }}>
          Le client sera disponible dans les devis, factures et exports.
        </p>
      </section>
    </aside>
  );
}

export function CustomerDetailPage() {
  const hydrated = useHydrated();
  const { id } = useParams();
  const { user, capabilities } = useSession();
  const canWriteCustomers = can(user, "customers:write");
  const purchasesEnabled = Boolean(capabilities?.purchases_enabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [customer, setCustomer] = useState<any>(null);
  const [form, setForm] = useState<any>(EMPTY_CUSTOMER);
  const [savedForm, setSavedForm] = useState<any>(EMPTY_CUSTOMER);
  const [summary, setSummary] = useState<any>(null);
  const [supplierMatches, setSupplierMatches] = useState<any[]>([]);
  const [supplierRelation, setSupplierRelation] = useState<any>(null);
  const [mergePreview, setMergePreview] = useState<any>(null);
  const [mergeChoices, setMergeChoices] = useState<Record<string, string>>({});
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const [relationConfirmingId, setRelationConfirmingId] = useState<string | null>(null);

  const loadDetail = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const detailRes = await rawApi(`/api/cockpit/customers/${id}`);

      if (!detailRes.ok) {
        const payload = await detailRes.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, detailRes.status, "Client introuvable."));
      }

      const payload = await detailRes.json().catch(() => null);
      const customerData = payload?.customer;
      let matchedSuppliers: any[] = [];
      let relationPayload: any = null;
      if (purchasesEnabled) {
        const supplierQuery = customerSupplierSearchTerm(customerData);
        const relationRes = await rawApi(`/api/customers/${id}/supplier-relation`).catch(() => null);
        if (relationRes?.ok) {
          relationPayload = await relationRes.json().catch(() => null);
          matchedSuppliers = Array.isArray(relationPayload?.items) ? relationPayload.items : [];
        } else if (supplierQuery) {
          const suppliersRes = await rawApi(
            `/api/inbox/suppliers?q=${encodeURIComponent(supplierQuery)}&limit=5`,
          ).catch(() => null);
          if (suppliersRes?.ok) {
            const suppliersPayload = await suppliersRes.json().catch(() => null);
            matchedSuppliers = (Array.isArray(suppliersPayload?.items) ? suppliersPayload.items : []).filter(
              (supplier: any) => purchaseSupplierMatchesCustomer(customerData, supplier),
            );
          }
        }
      }
      setCustomer(customerData);
      setSummary(payload?.summary?.stats || payload?.summary || null);
      setSupplierMatches(matchedSuppliers);
      setSupplierRelation(relationPayload);
      const nextForm = {
        ...EMPTY_CUSTOMER,
        ...customerData,
        country: (customerData.country || "FR").toUpperCase(),
        country_code: (customerData.country_code || customerData.country || "FR").toUpperCase(),
        siret: formatSiretInput(customerData.siret || ""),
        siren: formatSirenInput(customerData.siren || deriveSirenFromSiret(customerData.siret || "")),
        vat_number: formatVatNumberInput(customerData.vat_number || ""),
        iban: formatIbanInput(customerData.iban || ""),
        bic: formatBicInput(customerData.bic || ""),
        postal_code: formatPostalCodeInput(
          customerData.postal_code || "",
          customerData.country_code || customerData.country || "FR",
        ),
      };
      setForm(nextForm);
      setSavedForm(nextForm);
      setEditing(false);
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger le client."));
      setSupplierMatches([]);
      setSupplierRelation(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, purchasesEnabled]);

  const applyCustomerUpdateLocally = useCallback((updatedCustomer: any) => {
    if (!updatedCustomer) return;
    setCustomer((current: any) => (current ? { ...current, ...updatedCustomer } : updatedCustomer));
    setForm((current: any) => ({ ...current, ...updatedCustomer }));
  }, []);

  const saveCustomerDetail = async () => {
    if (!canWriteCustomers || !id || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated: any = await api(`/api/customers/${id}`, {
        method: "PATCH",
        body: JSON.stringify(normalizeCustomerPayload(form)),
      });
      const nextCustomer = updated?.id ? updated : { ...customer, ...normalizeCustomerPayload(form) };
      setCustomer(nextCustomer);
      const nextForm = {
        ...EMPTY_CUSTOMER,
        ...nextCustomer,
        country: (nextCustomer.country || "FR").toUpperCase(),
        country_code: (nextCustomer.country_code || nextCustomer.country || "FR").toUpperCase(),
        siret: formatSiretInput(nextCustomer.siret || ""),
        siren: formatSirenInput(nextCustomer.siren || deriveSirenFromSiret(nextCustomer.siret || "")),
        vat_number: formatVatNumberInput(nextCustomer.vat_number || ""),
        iban: formatIbanInput(nextCustomer.iban || ""),
        bic: formatBicInput(nextCustomer.bic || ""),
        postal_code: formatPostalCodeInput(
          nextCustomer.postal_code || "",
          nextCustomer.country_code || nextCustomer.country || "FR",
        ),
      };
      setForm(nextForm);
      setSavedForm(nextForm);
      setEditing(false);
      setNotice("Fiche client enregistrée.");
    } catch (err) {
      setError(formatApiError(err, "Enregistrement du client impossible."));
    } finally {
      setSaving(false);
    }
  };

  const openSupplierMerge = async (supplierId: string) => {
    if (!canWriteCustomers) return;
    if (!id || !supplierId) return;
    setMergeLoading(true);
    setMergeError(null);
    setMergeNotice(null);
    try {
      const res = await rawApi(`/api/customers/${id}/supplier-relation/${supplierId}/merge-preview`);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Assistant indisponible."));
      }
      const initialChoices: Record<string, string> = {};
      for (const field of Array.isArray(payload?.fields) ? payload.fields : []) {
        initialChoices[String(field.field || "")] = String(field.recommended_direction || "keep");
      }
      setMergePreview(payload);
      setMergeChoices(initialChoices);
    } catch (err) {
      setMergeError(formatApiError(err, "Impossible d'ouvrir l'assistant relation client/fournisseur."));
    } finally {
      setMergeLoading(false);
    }
  };

  const applySupplierMerge = async () => {
    if (!canWriteCustomers) return;
    if (!id || !mergePreview?.supplier?.id) return;
    setMergeSaving(true);
    setMergeError(null);
    setMergeNotice(null);
    try {
      const actions = Object.entries(mergeChoices)
        .filter(([, direction]) => direction && direction !== "keep")
        .map(([field, direction]) => ({ field, direction }));
      const payload: any = await api(`/api/customers/${id}/supplier-relation/${mergePreview.supplier.id}/harmonize`, {
        method: "POST",
        body: JSON.stringify({ actions }),
      });
      setMergePreview(payload?.preview || mergePreview);
      setMergeNotice(payload?.changed ? "Informations harmonisées." : "Aucune modification appliquée.");
      await loadDetail();
    } catch (err) {
      setMergeError(formatApiError(err, "Harmonisation impossible."));
    } finally {
      setMergeSaving(false);
    }
  };

  const confirmSupplierRelation = async (supplierId: string) => {
    if (!canWriteCustomers) return;
    if (!id || !supplierId) return;
    setRelationConfirmingId(supplierId);
    setMergeError(null);
    try {
      await api(`/api/customers/${id}/supplier-relation/${supplierId}/confirm`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadDetail();
    } catch (err) {
      setMergeError(formatApiError(err, "Confirmation de la relation impossible."));
    } finally {
      setRelationConfirmingId(null);
    }
  };

  return (
    <div>
      <AppPageHeader
        title={customer?.name || "Client"}
        breadcrumb={customer?.name ? `CRM · ${customer.name}` : "CRM"}
        backHref="/app/customers"
        actions={
          canWriteCustomers && customer ? (
            editing ? (
              <>
                <SecondaryButton
                  onClick={() => {
                    setForm(savedForm);
                    setError(null);
                    setEditing(false);
                  }}
                  disabled={saving}
                >
                  Annuler
                </SecondaryButton>
                <PrimaryButton onClick={() => void saveCustomerDetail()} disabled={saving}>
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </PrimaryButton>
              </>
            ) : (
              <PrimaryButton onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" /> Modifier
              </PrimaryButton>
            )
          ) : null
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {mergeError && !mergePreview ? <NoticeBanner tone="danger">{mergeError}</NoticeBanner> : null}

        {!hydrated && loading ? (
          <EmptyCard title="Fiche client" description="Ouverture du dossier client." />
        ) : loading ? (
          <LoadingCard label="Chargement de la fiche client…" />
        ) : !customer ? (
          <EmptyCard title="Client introuvable" description="Cette fiche n’a pas pu être chargée pour cet espace." />
        ) : (
          <>
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
              <CustomerFormFields
                form={form}
                setForm={setForm}
                showLookup
                readOnly={!editing || !canWriteCustomers || saving}
              />

              <CustomerDetailSidebar
                customer={customer}
                stats={summary}
                supplierMatches={supplierMatches}
                supplierRelation={supplierRelation}
                onOpenSupplierMerge={openSupplierMerge}
                onConfirmSupplierRelation={confirmSupplierRelation}
                confirmingSupplierRelationId={relationConfirmingId}
                onCustomerUpdated={applyCustomerUpdateLocally}
                canWriteCustomer={canWriteCustomers}
              />
            </div>
          </>
        )}
      </div>
      {mergeLoading ? <LoadingCard label="Ouverture de l'assistant relation…" /> : null}
      <CustomerSupplierMergeModal
        preview={mergePreview}
        choices={mergeChoices}
        onChoice={(field, direction) => setMergeChoices((current) => ({ ...current, [field]: direction }))}
        onClose={() => {
          setMergePreview(null);
          setMergeError(null);
          setMergeNotice(null);
        }}
        onApply={applySupplierMerge}
        saving={mergeSaving}
        error={mergeError}
        notice={mergeNotice}
      />
    </div>
  );
}

export function CustomerNewPage() {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const { user } = useSession();
  const canWriteCustomers = can(user, "customers:write");
  const [initialDraft] = useState(() => loadCustomerDraftState());
  const [form, setForm] = useState<any>(() => initialDraft.form);
  const [restoredDraft, setRestoredDraft] = useState(initialDraft.restored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicateProbe, setDuplicateProbe] = useState<any[]>([]);
  const [duplicateProbeLoading, setDuplicateProbeLoading] = useState(false);
  const duplicateCheckParams = useMemo(() => customerDuplicateCheckParams(form), [form]);

  useEffect(() => {
    const requestedType = readRequestedClientType();
    if (!requestedType) return;
    setForm((current: any) =>
      current.client_type === requestedType ? current : applyCustomerType(current, requestedType),
    );
  }, []);

  useEffect(() => {
    saveCustomerDraft(form);
  }, [form]);

  useEffect(() => {
    if (!hydrated) return;
    if (!Array.from(duplicateCheckParams.keys()).length) {
      setDuplicateProbe([]);
      setDuplicateProbeLoading(false);
      return;
    }
    let cancelled = false;
    setDuplicateProbeLoading(true);
    const timer = window.setTimeout(() => {
      rawApi(`/api/customers/duplicate-check?${duplicateCheckParams.toString()}`)
        .then(async (res) => {
          const payload = await res.json().catch(() => null);
          if (!cancelled) setDuplicateProbe(res.ok && Array.isArray(payload?.items) ? payload.items : []);
        })
        .catch(() => {
          if (!cancelled) setDuplicateProbe([]);
        })
        .finally(() => {
          if (!cancelled) setDuplicateProbeLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [duplicateCheckParams, hydrated]);

  const submit = async () => {
    if (!canWriteCustomers) {
      setError("Création client réservée aux administrateurs ou commerciaux.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const blockingIssue = customerCreationBlockingIssue(form);
      if (blockingIssue) {
        throw new Error(blockingIssue);
      }
      const created: any = await api("/api/customers", {
        method: "POST",
        body: JSON.stringify(normalizeCustomerPayload(form)),
      });
      if (!created?.id) {
        throw new Error("Client créé mais identifiant introuvable.");
      }
      clearCustomerDraft();
      setRestoredDraft(false);
      const detailPath = `/app/customers/${created.id}`;
      setNotice("Client créé.");
      navigate(detailPath);
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          if (window.location.pathname !== detailPath) {
            window.location.assign(detailPath);
          }
        }, 250);
      }
    } catch (err) {
      setError(formatApiError(err, "Création du client impossible."));
    } finally {
      setSaving(false);
    }
  };

  const resetDraft = () => {
    clearCustomerDraft();
    setForm(EMPTY_CUSTOMER);
    setRestoredDraft(false);
    setError(null);
    setNotice("Fiche client vierge.");
  };

  const blockingDuplicates = duplicateProbe.filter((item) => item?.field && item.field !== "name");
  const suggestionDuplicates = duplicateProbe.filter((item) => item?.field === "name");
  const blockingIssue =
    customerCreationBlockingIssue(form) ||
    (blockingDuplicates.length
      ? "Une fiche client existe déjà avec le même email, SIREN, SIRET ou numéro de TVA."
      : null);

  return (
    <div data-testid="customer-new-page" data-hydrated={hydrated ? "true" : "false"}>
      <AppPageHeader
        title={customerTypeCreationTitle(form.client_type)}
        breadcrumb="CRM · Nouveau client"
        backHref="/app/customers"
        description="Renseignez les informations du client, puis enregistrez-le."
        actions={
          canWriteCustomers ? (
            <GuidanceTooltip content="Enregistre la fiche client pour pouvoir la réutiliser dans les devis, factures et le portail.">
              <span className="inline-flex">
                <PrimaryButton
                  className="h-10 px-4"
                  onClick={submit}
                  disabled={saving || !hydrated || Boolean(blockingIssue)}
                >
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </PrimaryButton>
              </span>
            </GuidanceTooltip>
          ) : null
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!canWriteCustomers ? (
          <NoticeBanner tone="warning">Création client réservée aux administrateurs ou commerciaux.</NoticeBanner>
        ) : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {duplicateProbe.length ? (
          <NoticeBanner
            tone={blockingDuplicates.length ? "warning" : "info"}
            title={blockingDuplicates.length ? "Doublon client détecté" : "Client proche trouvé"}
          >
            {blockingDuplicates.length
              ? "Ouvrez la fiche existante au lieu de recréer le même client."
              : "Vérifiez rapidement que ce n'est pas le même client avec un nom légèrement différent."}
            <span className="mt-2 block space-y-1">
              {duplicateProbe.slice(0, 3).map((item) => (
                <Link
                  key={item.id}
                  to={`/app/customers/${item.id}`}
                  className="block text-[#1d4ed8] underline underline-offset-2"
                >
                  {item.name || "Client"} · {customerDuplicateReasonLabel(item.reason)}
                </Link>
              ))}
            </span>
          </NoticeBanner>
        ) : null}
        {restoredDraft ? (
          <NoticeBanner tone="info">
            Brouillon local repris dans cet onglet.
            <button type="button" className="ml-2 font-bold text-[#1d4ed8]" onClick={resetDraft}>
              Repartir de zéro
            </button>
          </NoticeBanner>
        ) : null}
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
          <CustomerFormFields form={form} setForm={setForm} />
          <CustomerNewSidebar form={form} />
        </div>
      </div>
    </div>
  );
}
