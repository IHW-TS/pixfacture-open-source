"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { api, apiUpload, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { TRIAL_DAYS } from "@/lib/billingConstants";
import {
  deriveFrenchVatNumberFromSiren,
  detectFrenchBusinessIdKind,
  digitsOnly,
  formatBicInput,
  formatFrenchBusinessIdInput,
  formatIbanInput,
  formatPostalCodeInput,
  formatSirenInput,
  formatSiretInput,
  formatVatNumberInput,
  isValidBic,
  isValidSiren,
  isValidFrenchVatNumber,
  isValidIban,
  isValidSiret,
  normalizeBic,
  normalizeIban,
  normalizeVatNumber,
} from "@/lib/businessRules";
import {
  AppPageHeader,
  Card,
  DisclosureCard,
  PrimaryButton,
  SecondaryButton,
} from "../../components/app/AppPageHeader";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  FileText,
  Hash,
  Image as ImageIcon,
  Lock,
  Pencil,
  Search,
  Trash2,
  Unlock,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/lib/useSession";

const inputCls =
  "w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-xl text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
const labelCls = "block text-[#374151] mb-1.5";
const VAT_FRANCHISE_NOTICE = "TVA non applicable, art. 293 B du CGI";
const SALES_VAT_RATE_OPTIONS = ["20", "10", "5.5", "2.1", "0"] as const;

function isVatFranchiseRegime(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return [
    "franchise",
    "franchise_base",
    "franchise_en_base",
    "micro",
    "micro_entreprise",
    "microentreprise",
    "auto_entrepreneur",
    "autoentrepreneur",
  ].includes(normalized);
}

const defaultForm = {
  name: "",
  siret: "",
  vat_number: "",
  legal_form: "",
  share_capital: "",
  address_line1: "",
  address_line2: "",
  postal_code: "",
  city: "",
  country_code: "FR",
  phone: "",
  email_reply_to: "",
  logo_url: "",
  iban: "",
  bic: "",
  vat_regime: "real_normal_monthly",
  vat_on_debits: false,
  default_sales_vat_rate: "20",
  vat_exemption_notice: "",
  transaction_periodicity: "",
  late_payment_interest: "Taux légal en vigueur",
  legal_mentions: "",
};

const defaultNumbering = {
  invoice_prefix: "F-",
  invoice_year: new Date().getFullYear(),
  invoice_next_number: 1,
  quote_prefix: "D-",
  quote_year: new Date().getFullYear(),
  quote_next_number: 1,
};

const NUMBERING_KEYS = [
  "invoice_prefix",
  "invoice_year",
  "invoice_next_number",
  "quote_prefix",
  "quote_year",
  "quote_next_number",
] as const;

function normalizeNumberInput(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCompanyNumbering(payload: any) {
  return {
    invoice_prefix: String(payload?.invoice_prefix || defaultNumbering.invoice_prefix).slice(0, 16),
    invoice_year: normalizeNumberInput(payload?.invoice_year, defaultNumbering.invoice_year),
    invoice_next_number: normalizeNumberInput(payload?.invoice_next_number, defaultNumbering.invoice_next_number),
    quote_prefix: String(payload?.quote_prefix || defaultNumbering.quote_prefix).slice(0, 16),
    quote_year: normalizeNumberInput(payload?.quote_year, defaultNumbering.quote_year),
    quote_next_number: normalizeNumberInput(payload?.quote_next_number, defaultNumbering.quote_next_number),
  };
}

function formatNumberingPreview(prefix: string, year: number, nextNumber: number) {
  return `${prefix || ""}${year || new Date().getFullYear()}-${String(nextNumber || 1).padStart(4, "0")}`;
}

function normalizeDefaultSalesVatRateInput(value: unknown, fallback = "20") {
  const parsed = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  const normalized = String(parsed).replace(/\.0$/, "");
  return SALES_VAT_RATE_OPTIONS.includes(normalized as any) ? normalized : fallback;
}

function nextNumberingPreview(prefix: string, year: number, nextNumber: number) {
  return formatNumberingPreview(prefix, year, normalizeNumberInput(nextNumber, 1) + 1);
}

function hasCompanyNumberingChanged(current: typeof defaultNumbering, saved: typeof defaultNumbering) {
  return NUMBERING_KEYS.some((key) => String(current[key] ?? "") !== String(saved[key] ?? ""));
}

function confirmCompanyNumberingChange(current: typeof defaultNumbering, saved: typeof defaultNumbering) {
  if (!hasCompanyNumberingChanged(current, saved) || typeof window === "undefined") return true;
  const lines = [
    "Confirmer la modification de la numérotation ?",
    "",
    "Les factures doivent garder une séquence unique, chronologique et continue. Modifiez ces valeurs seulement pour corriger le prochain index ou ouvrir une série justifiée.",
    "",
  ];
  const invoiceChanged =
    current.invoice_prefix !== saved.invoice_prefix ||
    current.invoice_year !== saved.invoice_year ||
    current.invoice_next_number !== saved.invoice_next_number;
  const quoteChanged =
    current.quote_prefix !== saved.quote_prefix ||
    current.quote_year !== saved.quote_year ||
    current.quote_next_number !== saved.quote_next_number;
  if (invoiceChanged) {
    lines.push(
      `Factures : ${formatNumberingPreview(
        saved.invoice_prefix,
        saved.invoice_year,
        saved.invoice_next_number,
      )} -> ${formatNumberingPreview(current.invoice_prefix, current.invoice_year, current.invoice_next_number)}`,
    );
  }
  if (quoteChanged) {
    lines.push(
      `Devis : ${formatNumberingPreview(saved.quote_prefix, saved.quote_year, saved.quote_next_number)} -> ${formatNumberingPreview(
        current.quote_prefix,
        current.quote_year,
        current.quote_next_number,
      )}`,
    );
  }
  return window.confirm(lines.join("\n"));
}

function normalizeCompanyPhoneInput(value: string) {
  return String(value || "")
    .replace(/[^\d+().\-\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

export function CompanyPage() {
  const { user, tenant, subscriptionStatus } = useSession();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupModalOpen, setLookupModalOpen] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [deletingLogo, setDeletingLogo] = useState(false);
  const [lookupSeed, setLookupSeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ ...defaultForm });
  const [savedForm, setSavedForm] = useState({ ...defaultForm });
  const [numbering, setNumbering] = useState({ ...defaultNumbering });
  const [savedNumbering, setSavedNumbering] = useState({ ...defaultNumbering });
  const [editing, setEditing] = useState(false);
  const [numberingUnlocked, setNumberingUnlocked] = useState(false);
  const [professionalUseConfirmed, setProfessionalUseConfirmed] = useState(false);
  const [professionalUseAcknowledged, setProfessionalUseAcknowledged] = useState(false);
  const [trialNoticeVisible, setTrialNoticeVisible] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const trialNoticeStorageKey = `pixfacture:company:trial-notice:dismissed:v1:${tenant || "tenant"}:${user?.id || "user"}`;
  const isTrial = ["trial", "trialing"].includes(
    String(subscriptionStatus || "")
      .trim()
      .toLowerCase(),
  );

  useEffect(() => {
    if (!isTrial || !user?.id) {
      setTrialNoticeVisible(false);
      return;
    }
    try {
      setTrialNoticeVisible(window.localStorage.getItem(trialNoticeStorageKey) !== "1");
    } catch {
      setTrialNoticeVisible(true);
    }
  }, [isTrial, trialNoticeStorageKey, user?.id]);

  const dismissTrialNotice = () => {
    setTrialNoticeVisible(false);
    try {
      window.localStorage.setItem(trialNoticeStorageKey, "1");
    } catch {
      // La fermeture reste effective pour la page courante si le stockage local est indisponible.
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [profileRes, numberingRes] = await Promise.all([
          rawApi("/api/company/profile"),
          rawApi("/api/company/numbering"),
        ]);
        if (!profileRes.ok) {
          const payload = await profileRes.json().catch(() => null);
          throw new Error(
            extractUserFacingApiMessage(payload, profileRes.status, "Impossible de charger le profil entreprise."),
          );
        }
        const profile = await profileRes.json().catch(() => null);
        const numberingPayload = numberingRes.ok ? await numberingRes.json().catch(() => null) : null;
        if (!cancelled && profile) {
          const nextSiret = formatSiretInput(profile.siret || "");
          const nextForm = {
            name: profile.name || "",
            siret: nextSiret,
            vat_number: formatVatNumberInput(profile.vat_number || ""),
            legal_form: profile.legal_form || "",
            share_capital: profile.share_capital || "",
            address_line1: profile.address_line1 || profile.address || "",
            address_line2: profile.address_line2 || "",
            postal_code: profile.postal_code || "",
            city: profile.city || "",
            country_code: (profile.country_code || profile.country || "FR").toUpperCase(),
            phone: normalizeCompanyPhoneInput(profile.phone || ""),
            email_reply_to: profile.email_reply_to || "",
            logo_url: profile.logo_url || "",
            iban: formatIbanInput(profile.iban || ""),
            bic: formatBicInput(profile.bic || ""),
            vat_regime: isVatFranchiseRegime(profile.vat_regime)
              ? "franchise"
              : profile.vat_regime || "real_normal_monthly",
            vat_on_debits: Boolean(profile.vat_on_debits),
            default_sales_vat_rate: isVatFranchiseRegime(profile.vat_regime)
              ? "0"
              : normalizeDefaultSalesVatRateInput(profile.default_sales_vat_rate, "20"),
            vat_exemption_notice: profile.vat_exemption_notice || "",
            transaction_periodicity: profile.transaction_periodicity || "",
            late_payment_interest: profile.late_payment_interest || "Taux légal en vigueur",
            legal_mentions: profile.legal_mentions || "",
          };
          const nextNumbering = normalizeCompanyNumbering(numberingPayload);
          setForm(nextForm);
          setSavedForm(nextForm);
          setNumbering(nextNumbering);
          setSavedNumbering(nextNumbering);
          const confirmed = Boolean(profile.professional_use_confirmed_at);
          setProfessionalUseConfirmed(confirmed);
          setProfessionalUseAcknowledged(confirmed);
          setEditing(
            !(
              String(nextForm.name || "").trim() &&
              isValidSiret(nextForm.siret) &&
              String(nextForm.address_line1 || "").trim()
            ),
          );
          setLookupSeed(nextSiret);
        } else if (!cancelled) {
          setEditing(true);
        }
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Impossible de charger le profil entreprise."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const vatReady = isVatFranchiseRegime(form.vat_regime)
    ? Boolean(form.vat_exemption_notice.trim())
    : Boolean(isValidFrenchVatNumber(form.vat_number));

  const lookupDigits = digitsOnly(lookupSeed || form.siret);
  const lookupKind = detectFrenchBusinessIdKind(lookupDigits);
  const lookupReady = form.country_code === "FR" && (lookupDigits.length === 9 || lookupDigits.length === 14);
  const vatCollectionLabel = form.vat_on_debits ? "TVA sur les débits" : "TVA sur les encaissements";
  const vatRegimeLabel = isVatFranchiseRegime(form.vat_regime)
    ? "Franchise en base"
    : form.vat_regime === "simplified"
      ? "Régime simplifié"
      : form.vat_regime === "real_normal_quarterly"
        ? "Réel normal trimestriel"
        : "Réel normal mensuel";
  const sirenSnapshot = formatSirenInput(form.siret);
  const readinessStatus = [
    {
      label: "Devis",
      ok: Boolean(
        form.name.trim() && (isValidSiret(form.siret) || isValidSiren(form.siret)) && form.address_line1.trim(),
      ),
    },
    {
      label: "Facture",
      ok: Boolean(isValidSiret(form.siret) && vatReady && form.late_payment_interest.trim()),
    },
    { label: "Paiement", ok: Boolean(form.iban.trim() && isValidIban(form.iban)) },
  ];
  const setField = (key: string, value: string) => {
    setForm((prev) => {
      if (key === "siret") {
        const formatted = formatSiretInput(value);
        setLookupSeed(formatted);
        return { ...prev, siret: formatted };
      }
      if (key === "vat_number") {
        return { ...prev, vat_number: formatVatNumberInput(value) };
      }
      if (key === "vat_regime") {
        const vatRegime = String(value || "");
        const isFranchise = isVatFranchiseRegime(vatRegime);
        return {
          ...prev,
          vat_regime: isFranchise ? "franchise" : vatRegime,
          ...(isFranchise
            ? {
                vat_on_debits: false,
                default_sales_vat_rate: "0",
                vat_exemption_notice: prev.vat_exemption_notice || VAT_FRANCHISE_NOTICE,
              }
            : prev.default_sales_vat_rate === "0"
              ? { default_sales_vat_rate: "20" }
              : {}),
        };
      }
      if (key === "postal_code") {
        return { ...prev, postal_code: formatPostalCodeInput(value, prev.country_code || "FR") };
      }
      if (key === "country_code") {
        return {
          ...prev,
          country_code: String(value || "FR")
            .toUpperCase()
            .slice(0, 2),
        };
      }
      if (key === "iban") {
        return { ...prev, iban: formatIbanInput(value) };
      }
      if (key === "bic") {
        return { ...prev, bic: formatBicInput(value) };
      }
      if (key === "phone") {
        return { ...prev, phone: normalizeCompanyPhoneInput(value) };
      }
      return { ...prev, [key]: value };
    });
  };

  const setNumberingField = (key: keyof typeof defaultNumbering, value: string) => {
    setNumbering((prev) => {
      if (key.endsWith("_next_number") || key.endsWith("_year")) {
        return { ...prev, [key]: normalizeNumberInput(value, Number(prev[key]) || 1) };
      }
      return { ...prev, [key]: value.toUpperCase().slice(0, 16) };
    });
  };

  const uploadLogo = async (file?: File | null) => {
    if (!file || uploadingLogo) return;
    setUploadingLogo(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result: any = await apiUpload("/api/company/logo", body);
      const logoUrl = result?.logo_url || "";
      setForm((prev) => ({ ...prev, logo_url: logoUrl }));
      setSavedForm((prev) => ({ ...prev, logo_url: logoUrl }));
      setNotice("Logo entreprise mis à jour.");
    } catch (err) {
      setError(formatApiError(err, "Impossible d'envoyer le logo."));
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const removeLogo = async () => {
    if (!form.logo_url || deletingLogo) return;
    setDeletingLogo(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify({ logo_url: null }),
      });
      setForm((prev) => ({ ...prev, logo_url: "" }));
      setSavedForm((prev) => ({ ...prev, logo_url: "" }));
      setNotice("Logo entreprise supprimé.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de supprimer le logo."));
    } finally {
      setDeletingLogo(false);
    }
  };

  const applySirenePrefill = async () => {
    if (!lookupReady || lookupBusy) return false;
    setLookupBusy(true);
    setError(null);
    setNotice(null);
    try {
      const seed = digitsOnly(lookupSeed || form.siret);
      const siret = seed.length === 14 ? seed : "";
      const siren = siret.length >= 9 ? siret.slice(0, 9) : undefined;
      const fallbackSiren = seed.length === 9 ? seed : siren;
      const params = new URLSearchParams();
      if (siret.length === 14) params.set("siret", siret);
      else if (fallbackSiren) params.set("siren", fallbackSiren);
      const res = await rawApi(`/api/lookup/sirene?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Recherche SIRENE impossible."));
      }
      const payload = await res.json().catch(() => null);
      setForm((prev) => ({
        ...prev,
        name: payload?.name || prev.name,
        address_line1: payload?.address_line1 || prev.address_line1,
        address_line2: payload?.address_line2 || prev.address_line2,
        postal_code: payload?.postal_code || prev.postal_code,
        city: payload?.city || prev.city,
        country_code: (payload?.country || prev.country_code || "FR").toUpperCase(),
        siret: formatSiretInput(payload?.siret || siret || prev.siret),
        vat_number: formatVatNumberInput(
          payload?.vat_number ||
            deriveFrenchVatNumberFromSiren(payload?.siren || payload?.siret || siret || fallbackSiren || prev.siret),
        ),
      }));
      setLookupSeed(formatFrenchBusinessIdInput(payload?.siret || fallbackSiren || siret || ""));
      setNotice("Entreprise préremplie depuis l'annuaire, TVA incluse.");
      return true;
    } catch (err) {
      setError(formatApiError(err, "Préremplissage SIRENE impossible."));
      return false;
    } finally {
      setLookupBusy(false);
    }
  };

  const save = async () => {
    if (saving) return;
    const normalizedNumbering = normalizeCompanyNumbering(numbering);
    const normalizedSavedNumbering = normalizeCompanyNumbering(savedNumbering);
    if (!confirmCompanyNumberingChange(normalizedNumbering, normalizedSavedNumbering)) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: form.name.trim() || null,
        siret: form.siret.replace(/\D+/g, "") || null,
        vat_number: normalizeVatNumber(form.vat_number) || null,
        legal_form: form.legal_form.trim() || null,
        share_capital: form.share_capital.trim() || null,
        address_line1: form.address_line1.trim() || null,
        address_line2: form.address_line2.trim() || null,
        address: [form.address_line1.trim(), form.address_line2.trim()].filter(Boolean).join(" ") || null,
        postal_code: form.postal_code.trim() || null,
        city: form.city.trim() || null,
        country_code: form.country_code.trim().toUpperCase() || null,
        country: form.country_code.trim().toUpperCase() || null,
        phone: form.phone.trim() || null,
        email_reply_to: form.email_reply_to.trim() || null,
        iban: normalizeIban(form.iban) || null,
        bic: normalizeBic(form.bic) || null,
        vat_regime: form.vat_regime || null,
        vat_on_debits: isVatFranchiseRegime(form.vat_regime) ? false : Boolean(form.vat_on_debits),
        default_sales_vat_rate: isVatFranchiseRegime(form.vat_regime)
          ? 0
          : Number(normalizeDefaultSalesVatRateInput(form.default_sales_vat_rate)),
        vat_exemption_notice: isVatFranchiseRegime(form.vat_regime)
          ? form.vat_exemption_notice.trim() || VAT_FRANCHISE_NOTICE
          : form.vat_exemption_notice.trim() || null,
        transaction_periodicity: form.transaction_periodicity || null,
        late_payment_interest: form.late_payment_interest.trim() || "Taux légal en vigueur",
        legal_mentions: form.legal_mentions.trim() || null,
        ...(!professionalUseConfirmed && professionalUseAcknowledged ? { professional_use_confirmed: true } : {}),
      };

      const updatedProfile: any = await api("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const numberingResult = await api("/api/company/numbering", {
        method: "PATCH",
        body: JSON.stringify(normalizedNumbering),
      });
      const nextNumbering = normalizeCompanyNumbering(numberingResult);
      setSavedForm({ ...form });
      setNumbering(nextNumbering);
      setSavedNumbering(nextNumbering);
      const confirmed = Boolean(updatedProfile?.professional_use_confirmed_at || professionalUseConfirmed);
      setProfessionalUseConfirmed(confirmed);
      setProfessionalUseAcknowledged(confirmed);
      setNumberingUnlocked(false);
      setEditing(false);
      setNotice("Dossier entreprise enregistré.");
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Mon entreprise"
        breadcrumb="Paramètres · Entreprise"
        actions={
          editing ? (
            <>
              <SecondaryButton
                onClick={() => {
                  setForm(savedForm);
                  setNumbering(savedNumbering);
                  setLookupSeed(savedForm.siret || "");
                  setError(null);
                  setProfessionalUseAcknowledged(professionalUseConfirmed);
                  setNumberingUnlocked(false);
                  setEditing(false);
                }}
                disabled={saving || loading}
              >
                Annuler
              </SecondaryButton>
              <PrimaryButton onClick={save} disabled={saving || loading}>
                {saving ? "Enregistrement…" : "Enregistrer"}
              </PrimaryButton>
            </>
          ) : (
            <PrimaryButton onClick={() => setEditing(true)} disabled={loading}>
              <Pencil className="w-3.5 h-3.5" /> Modifier
            </PrimaryButton>
          )
        }
      />
      <div className="w-full space-y-5 p-5 lg:p-6">
        {trialNoticeVisible ? (
          <div
            className="flex items-start gap-3 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3 text-[#1e3a8a]"
            role="status"
            aria-live="polite"
          >
            <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#2563eb]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">Essai Pro de {TRIAL_DAYS} jours</p>
              <p className="mt-0.5 text-xs leading-5 text-[#475569]">
                Vos documents restent des simulations : aucune émission définitive, aucun email client et aucune
                transmission réelle. Choisissez un abonnement pour facturer vos clients.
              </p>
            </div>
            <button
              type="button"
              onClick={dismissTrialNotice}
              className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[#64748b] transition-colors hover:bg-white hover:text-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]"
              aria-label="Masquer les informations sur l’essai"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {error && (
          <div
            className="flex items-center gap-2 text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-lg px-3 py-2 text-xs"
            role="alert"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}
        {notice && (
          <div
            className="flex items-center gap-2 text-[#059669] bg-[#ecfdf5] border border-[#bbf7d0] rounded-lg px-3 py-2 text-xs"
            role="status"
            aria-live="polite"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {notice}
          </div>
        )}

        {lookupModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
            <button
              type="button"
              className="absolute inset-0 bg-[#0f172a]/35"
              aria-label="Fermer la recherche SIREN"
              onClick={() => setLookupModalOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="company-sirene-dialog-title"
              className="relative w-full max-w-xl rounded-2xl border border-[#dbeafe] bg-white p-5 shadow-[0_24px_70px_-30px_rgba(15,23,42,0.45)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div
                    id="company-sirene-dialog-title"
                    className="text-[1rem] font-extrabold tracking-normal text-[#0f172a]"
                  >
                    Recherche SIREN / SIRET
                  </div>
                  <p className="mt-1 text-sm font-medium leading-6 text-[#64748b]">
                    Renseignez un SIREN ou SIRET pour préremplir l'entreprise depuis l'annuaire.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setLookupModalOpen(false)}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#dbe4ef] bg-white text-[#64748b] transition-colors hover:bg-[#f8fafc]"
                  aria-label="Fermer"
                >
                  ×
                </button>
              </div>

              <label className="mt-5 flex min-h-12 min-w-0 items-center gap-2 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] px-3 transition-all focus-within:border-[#1d4ed8] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#1d4ed8]/20">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.07em] ${
                    lookupReady ? "bg-[#dbeafe] text-[#1d4ed8]" : "bg-white text-[#64748b]"
                  }`}
                >
                  {lookupReady ? "Prêt" : "9 ou 14"}
                </span>
                <input
                  aria-label="SIREN ou SIRET de l'entreprise"
                  value={lookupSeed}
                  onChange={(e) => setLookupSeed(formatFrenchBusinessIdInput(e.target.value))}
                  className="h-12 min-w-0 flex-1 border-0 bg-transparent px-1 font-mono text-sm font-bold text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:outline-none focus:ring-0 focus:shadow-none"
                  maxLength={18}
                  inputMode="numeric"
                  placeholder="123 456 789 ou 123 456 789 00011"
                  autoFocus
                />
              </label>
              <div className="mt-2 flex flex-wrap gap-2 text-[0.7rem] font-semibold">
                <span className="text-[#94a3b8]">
                  {lookupKind === "siret"
                    ? "14 chiffres détectés"
                    : lookupKind === "siren"
                      ? "9 chiffres détectés"
                      : "Saisie guidée"}
                </span>
                {lookupDigits.length === 9 ? (
                  <span className={isValidSiren(lookupDigits) ? "text-[#059669]" : "text-[#d97706]"}>
                    {isValidSiren(lookupDigits) ? "SIREN cohérent" : "SIREN à vérifier"}
                  </span>
                ) : null}
                {lookupDigits.length === 14 ? (
                  <span className={isValidSiret(lookupDigits) ? "text-[#059669]" : "text-[#d97706]"}>
                    {isValidSiret(lookupDigits) ? "SIRET cohérent" : "SIRET à vérifier"}
                  </span>
                ) : null}
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setLookupModalOpen(false)}
                  className="inline-flex h-10 items-center justify-center rounded-xl border border-[#dbe4ef] bg-white px-4 text-sm font-bold text-[#475569] transition-colors hover:bg-[#f8fafc]"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await applySirenePrefill();
                    if (ok) setLookupModalOpen(false);
                  }}
                  disabled={!lookupReady || lookupBusy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#1d4ed8] px-4 text-sm font-bold text-white shadow-[0_10px_20px_rgba(29,78,216,0.18)] transition-colors hover:bg-[#1b46c2] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Search className="h-4 w-4" /> {lookupBusy ? "Recherche…" : "Préremplir"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-5">
            <fieldset disabled={loading || !editing} className="space-y-5 disabled:opacity-100">
              <Card>
                <CompanySectionHeader title="Identité de l'entreprise" badge="Entreprise" />

                <div className="mt-4 grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
                  <div className="rounded-2xl border border-[#dbe4ef] bg-[#f8fafc] p-3">
                    <div
                      role="button"
                      tabIndex={loading || uploadingLogo || !editing ? -1 : 0}
                      onClick={() => {
                        if (loading || uploadingLogo || !editing) return;
                        logoInputRef.current?.click();
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        if (loading || uploadingLogo || !editing) return;
                        event.preventDefault();
                        logoInputRef.current?.click();
                      }}
                      className={`relative flex h-[128px] w-full items-center justify-center overflow-hidden rounded-xl border border-[#dbe4ef] bg-white transition-colors hover:border-[#bfdbfe] ${
                        loading || uploadingLogo || !editing ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                      }`}
                      aria-label={form.logo_url ? "Changer le logo de la société" : "Ajouter le logo de la société"}
                    >
                      {form.logo_url ? (
                        <Image
                          src={form.logo_url}
                          alt=""
                          width={240}
                          height={128}
                          className="h-full w-full object-contain p-4"
                          unoptimized
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-[#64748b]">
                          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff6ff] text-[#2563eb] shadow-sm">
                            <ImageIcon className="h-4 w-4" />
                          </span>
                          <span className="text-[0.72rem] font-bold">Aucun logo</span>
                        </div>
                      )}
                      {form.logo_url ? (
                        <button
                          type="button"
                          aria-label="Supprimer le logo"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void removeLogo();
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            void removeLogo();
                          }}
                          disabled={loading || deletingLogo || !editing}
                          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#fecaca] bg-white/95 text-[#dc2626] shadow-[0_6px_16px_rgba(220,38,38,0.12)] transition-colors hover:bg-[#fef2f2]"
                          title={deletingLogo ? "Suppression…" : "Supprimer le logo"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      disabled={loading || uploadingLogo}
                      onChange={(event) => void uploadLogo(event.target.files?.[0])}
                    />
                    <div className="mt-3">
                      <div className="text-sm font-bold text-[#0f172a]">Logo de la société</div>
                      <p className="mt-1 text-xs leading-5 text-[#64748b]">PNG ou JPG, 2 Mo maximum.</p>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label
                        htmlFor="company-name"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Nom / Raison sociale <span className="text-[#ef4444]">*</span>
                      </label>
                      <input
                        id="company-name"
                        value={form.name}
                        onChange={(e) => setField("name", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        autoComplete="organization"
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-legal-form"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Forme juridique
                      </label>
                      <input
                        id="company-legal-form"
                        value={form.legal_form}
                        onChange={(e) => setField("legal_form", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        placeholder="SARL, SAS, SASU…"
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-email-reply-to"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Email de contact
                      </label>
                      <input
                        id="company-email-reply-to"
                        value={form.email_reply_to}
                        onChange={(e) => setField("email_reply_to", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        type="email"
                        placeholder="contact@entreprise.fr"
                        autoComplete="email"
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-phone"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Téléphone
                      </label>
                      <input
                        id="company-phone"
                        value={form.phone}
                        onChange={(e) => setField("phone", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        type="tel"
                        placeholder="+33 1 23 45 67 89"
                        autoComplete="tel"
                        maxLength={24}
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-share-capital"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Capital social
                      </label>
                      <input
                        id="company-share-capital"
                        value={form.share_capital}
                        onChange={(e) => setField("share_capital", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        placeholder="10 000 €"
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-country-code"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Pays
                      </label>
                      <input
                        id="company-country-code"
                        value={form.country_code}
                        onChange={(e) => setField("country_code", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        maxLength={2}
                        autoComplete="country"
                        disabled={loading}
                      />
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <CompanySectionHeader
                  title="Usage professionnel"
                  badge={professionalUseConfirmed ? "Confirmé" : "À confirmer"}
                />
                {professionalUseConfirmed ? (
                  <p className="mt-3 text-sm leading-6 text-[#475569]" role="status">
                    Cet espace est enregistré pour une entreprise ou une activité professionnelle.
                  </p>
                ) : (
                  <label
                    htmlFor="company-professional-use"
                    className="mt-3 flex items-start gap-3 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] p-4 text-sm leading-6 text-[#334155]"
                  >
                    <input
                      id="company-professional-use"
                      type="checkbox"
                      checked={professionalUseAcknowledged}
                      onChange={(event) => setProfessionalUseAcknowledged(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-[#94a3b8] accent-[#1d4ed8]"
                      disabled={loading || !editing}
                    />
                    <span>
                      Je confirme que cet espace est utilisé au nom d'une entreprise ou d'une activité professionnelle
                      et que je ne souscris pas en qualité de consommateur. Un SIRET ou identifiant professionnel doit
                      être renseigné avant l'enregistrement.
                    </span>
                  </label>
                )}
              </Card>

              <Card>
                <CompanySectionHeader title="Adresse & conformité" badge={form.country_code || "FR"} />

                <div className="mt-3 space-y-3">
                  <div>
                    <label
                      htmlFor="company-address-line1"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Adresse ligne 1 <span className="text-[#ef4444]">*</span>
                    </label>
                    <input
                      id="company-address-line1"
                      value={form.address_line1}
                      onChange={(e) => setField("address_line1", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      autoComplete="address-line1"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="company-address-line2"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Adresse ligne 2
                    </label>
                    <input
                      id="company-address-line2"
                      value={form.address_line2}
                      onChange={(e) => setField("address_line2", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      placeholder="Bâtiment, étage, CS…"
                      autoComplete="address-line2"
                      disabled={loading}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="company-postal-code"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Code postal
                      </label>
                      <input
                        id="company-postal-code"
                        value={form.postal_code}
                        onChange={(e) => setField("postal_code", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        maxLength={5}
                        inputMode="numeric"
                        autoComplete="postal-code"
                        disabled={loading}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="company-city"
                        className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                      >
                        Ville
                      </label>
                      <input
                        id="company-city"
                        value={form.city}
                        onChange={(e) => setField("city", e.target.value)}
                        className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                        autoComplete="address-level2"
                        disabled={loading}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 border-t border-[#e8eef5] pt-4">
                  <CompanySectionHeader title="Identifiants" badge="SIREN / SIRET" />
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="company-siret"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      SIREN / SIRET <span className="text-[#ef4444]">*</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="company-siret"
                        value={form.siret}
                        onChange={(e) => setField("siret", e.target.value)}
                        className={[inputCls, "font-mono text-sm"].filter(Boolean).join(" ")}
                        maxLength={18}
                        inputMode="numeric"
                        placeholder="123 456 789 00011"
                        disabled={loading}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setLookupSeed(formatFrenchBusinessIdInput(form.siret || lookupSeed || ""));
                          setLookupModalOpen(true);
                        }}
                        disabled={loading}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-[#dbeafe] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Rechercher une entreprise par SIREN ou SIRET"
                        title="Rechercher par SIREN ou SIRET"
                      >
                        <Search className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="mt-1.5 text-[#94a3b8] text-xs">SIREN ou SIRET, espaces gérés automatiquement.</p>
                  </div>
                  <div>
                    <label
                      htmlFor="company-vat-number"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      N° TVA intracommunautaire
                    </label>
                    <input
                      id="company-vat-number"
                      value={form.vat_number}
                      onChange={(e) => setField("vat_number", e.target.value)}
                      className={[inputCls, "font-mono tracking-[0.08em] text-sm"].filter(Boolean).join(" ")}
                      maxLength={24}
                      placeholder="FR 00 000 000 000"
                      autoComplete="off"
                      disabled={loading}
                    />
                    <p className="mt-1.5 text-[#94a3b8] text-xs">Format auto : FR 00 000 000 000.</p>
                  </div>
                </div>
              </Card>

              <Card>
                <CompanySectionHeader title="Réglages" badge="Optionnel" />
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="company-vat-regime"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Régime TVA
                    </label>
                    <select
                      id="company-vat-regime"
                      value={form.vat_regime}
                      onChange={(e) => setField("vat_regime", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      disabled={loading}
                    >
                      <option value="real_normal_monthly">Réel normal (mensuel)</option>
                      <option value="real_normal_quarterly">Réel normal (trimestriel)</option>
                      <option value="simplified">Régime simplifié</option>
                      <option value="franchise">Franchise en base</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="company-vat-collection"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Exigibilité TVA collectée
                    </label>
                    <select
                      id="company-vat-collection"
                      value={form.vat_on_debits ? "debits" : "encaissements"}
                      onChange={(e) => setForm((prev) => ({ ...prev, vat_on_debits: e.target.value === "debits" }))}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      disabled={loading || isVatFranchiseRegime(form.vat_regime)}
                    >
                      <option value="encaissements">TVA sur les encaissements</option>
                      <option value="debits">TVA sur les débits</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="company-default-sales-vat-rate"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      TVA ventes par défaut
                    </label>
                    <select
                      id="company-default-sales-vat-rate"
                      value={isVatFranchiseRegime(form.vat_regime) ? "0" : form.default_sales_vat_rate}
                      onChange={(e) => setField("default_sales_vat_rate", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      disabled={loading || isVatFranchiseRegime(form.vat_regime)}
                    >
                      <option value="20">20 %</option>
                      <option value="10">10 %</option>
                      <option value="5.5">5,5 %</option>
                      <option value="2.1">2,1 %</option>
                      <option value="0">0 %</option>
                    </select>
                    {isVatFranchiseRegime(form.vat_regime) ? (
                      <p className="mt-1.5 text-xs text-[#64748b]">Forcé à 0 % en franchise en base.</p>
                    ) : null}
                  </div>
                  <div>
                    <label
                      htmlFor="company-transaction-periodicity"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Périodicité transmissions
                    </label>
                    <select
                      id="company-transaction-periodicity"
                      value={form.transaction_periodicity}
                      onChange={(e) => setField("transaction_periodicity", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      disabled={loading}
                    >
                      <option value="">Auto (selon régime TVA)</option>
                      <option value="monthly">Mensuelle</option>
                      <option value="decade">Décade (10 jours)</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="company-late-payment-interest"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Pénalités de retard
                    </label>
                    <input
                      id="company-late-payment-interest"
                      value={form.late_payment_interest}
                      onChange={(e) => setField("late_payment_interest", e.target.value)}
                      placeholder="Taux légal en vigueur"
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="company-vat-exemption-notice"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      Mention franchise / exonération
                    </label>
                    <input
                      id="company-vat-exemption-notice"
                      value={form.vat_exemption_notice}
                      onChange={(e) => setField("vat_exemption_notice", e.target.value)}
                      className={[inputCls, "text-sm"].filter(Boolean).join(" ")}
                      placeholder="TVA non applicable, art. 293 B du CGI."
                      disabled={loading}
                    />
                  </div>
                </div>
              </Card>

              <DisclosureCard
                title="Coordonnées bancaires"
                defaultOpen={!Boolean(form.iban || form.bic)}
                collapsible={false}
                badge={
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 ${(!form.iban || isValidIban(form.iban)) && (!form.bic || isValidBic(form.bic)) ? "bg-[#ecfdf5] text-[#059669]" : "bg-[#fffbeb] text-[#b45309]"}`}
                    style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                  >
                    {(!form.iban || isValidIban(form.iban)) && (!form.bic || isValidBic(form.bic))
                      ? "Paiement OK"
                      : "À corriger"}
                  </span>
                }
              >
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="company-iban"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      IBAN
                    </label>
                    <input
                      id="company-iban"
                      value={form.iban}
                      onChange={(e) => setField("iban", e.target.value)}
                      className={[`${inputCls} font-mono`, "text-sm"].filter(Boolean).join(" ")}
                      placeholder="FR76 3000 1007 1000 0000 0000 001"
                      maxLength={42}
                      autoComplete="off"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="company-bic"
                      className={[labelCls, "text-sm font-medium"].filter(Boolean).join(" ")}
                    >
                      BIC
                    </label>
                    <input
                      id="company-bic"
                      value={form.bic}
                      onChange={(e) => setField("bic", e.target.value)}
                      className={[`${inputCls} font-mono`, "text-sm"].filter(Boolean).join(" ")}
                      placeholder="BNPAFRPP"
                      maxLength={11}
                      autoComplete="off"
                      disabled={loading}
                    />
                  </div>
                </div>
              </DisclosureCard>

              <CompanyNumberingSettings
                numbering={numbering}
                editing={editing}
                unlocked={numberingUnlocked}
                loading={loading}
                onChange={setNumberingField}
                onToggleUnlocked={() => setNumberingUnlocked((current) => !current)}
              />
            </fieldset>
          </div>

          <CompanyPreviewSidebar
            form={form}
            readinessStatus={readinessStatus}
            sirenSnapshot={sirenSnapshot}
            vatReady={vatReady}
            vatRegimeLabel={vatRegimeLabel}
            vatCollectionLabel={vatCollectionLabel}
          />
        </div>
      </div>
    </div>
  );
}

function CompanyNumberingSettings({
  numbering,
  editing,
  unlocked,
  loading,
  onChange,
  onToggleUnlocked,
}: {
  numbering: typeof defaultNumbering;
  editing: boolean;
  unlocked: boolean;
  loading: boolean;
  onChange: (key: keyof typeof defaultNumbering, value: string) => void;
  onToggleUnlocked: () => void;
}) {
  const canUnlock = editing && !loading;
  return (
    <Card>
      <CompanySectionHeader title="Numérotation" badge="Documents" />
      <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fbff] px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              unlocked ? "bg-[#eff6ff] text-[#2563eb]" : "bg-[#f1f5f9] text-[#64748b]"
            }`}
          >
            {unlocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </span>
          <div>
            <p className="text-sm font-bold text-[#0f172a]">
              {unlocked ? "Numérotation déverrouillée" : "Numérotation verrouillée"}
            </p>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[#64748b]">
              Les numéros de factures et de devis sont verrouillés par défaut pour éviter une rupture de séquence.
              Déverrouillez uniquement si vous devez corriger le prochain numéro avant de créer un document.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleUnlocked}
          disabled={!canUnlock}
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-bold transition-colors ${
            unlocked
              ? "border-[#bfdbfe] bg-white text-[#1d4ed8] hover:bg-[#eff6ff]"
              : canUnlock
                ? "border-[#2563eb] bg-[#2563eb] text-white hover:bg-[#1d4ed8]"
                : "border-[#e2e8f0] bg-white text-[#94a3b8]"
          }`}
        >
          {unlocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          {unlocked ? "Reverrouiller" : "Modifier la numérotation"}
        </button>
      </div>
      <div className="mt-3 grid gap-5 xl:grid-cols-2">
        <NumberingLine
          title="Factures et avoirs"
          iconClassName="text-[#2563eb]"
          prefix={numbering.invoice_prefix}
          year={numbering.invoice_year}
          nextNumber={numbering.invoice_next_number}
          nextLabel="Prochaine facture"
          afterLabel="Après émission"
          prefixKey="invoice_prefix"
          yearKey="invoice_year"
          nextNumberKey="invoice_next_number"
          disabled={loading || !unlocked}
          onChange={onChange}
        />
        <NumberingLine
          title="Devis"
          iconClassName="text-[#7c3aed]"
          prefix={numbering.quote_prefix}
          year={numbering.quote_year}
          nextNumber={numbering.quote_next_number}
          nextLabel="Prochain devis"
          afterLabel="Après création"
          prefixKey="quote_prefix"
          yearKey="quote_year"
          nextNumberKey="quote_next_number"
          disabled={loading || !unlocked}
          onChange={onChange}
        />
      </div>
    </Card>
  );
}

function NumberingLine({
  title,
  iconClassName,
  prefix,
  year,
  nextNumber,
  nextLabel,
  afterLabel,
  prefixKey,
  yearKey,
  nextNumberKey,
  disabled,
  onChange,
}: {
  title: string;
  iconClassName: string;
  prefix: string;
  year: number;
  nextNumber: number;
  nextLabel: string;
  afterLabel: string;
  prefixKey: keyof typeof defaultNumbering;
  yearKey: keyof typeof defaultNumbering;
  nextNumberKey: keyof typeof defaultNumbering;
  disabled: boolean;
  onChange: (key: keyof typeof defaultNumbering, value: string) => void;
}) {
  const prefixInputId = `company-numbering-${String(prefixKey)}`;
  const yearInputId = `company-numbering-${String(yearKey)}`;
  const nextNumberInputId = `company-numbering-${String(nextNumberKey)}`;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-[#0f172a]">
          <Hash className={`h-4 w-4 ${iconClassName}`} /> {title}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-[#64748b]">
            {nextLabel} :{" "}
            <strong className="font-bold text-[#0f172a]">{formatNumberingPreview(prefix, year, nextNumber)}</strong>
          </span>
          <span className="text-[#94a3b8]">
            {afterLabel} :{" "}
            <strong className="font-bold text-[#475569]">{nextNumberingPreview(prefix, year, nextNumber)}</strong>
          </span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_140px]">
        <div>
          <label htmlFor={prefixInputId} className={[labelCls, "text-xs font-bold"].filter(Boolean).join(" ")}>
            Préfixe
          </label>
          <input
            id={prefixInputId}
            value={prefix}
            onChange={(event) => onChange(prefixKey, event.target.value)}
            className={[inputCls, "text-sm disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#64748b]"]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled}
            maxLength={16}
          />
        </div>
        <div>
          <label htmlFor={yearInputId} className={[labelCls, "text-xs font-bold"].filter(Boolean).join(" ")}>
            Année
          </label>
          <input
            id={yearInputId}
            type="number"
            min={2000}
            max={2100}
            value={year}
            onChange={(event) => onChange(yearKey, event.target.value)}
            className={[inputCls, "text-sm disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#64748b]"]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled}
          />
        </div>
        <div>
          <label htmlFor={nextNumberInputId} className={[labelCls, "text-xs font-bold"].filter(Boolean).join(" ")}>
            Prochain n°
          </label>
          <input
            id={nextNumberInputId}
            type="number"
            min={1}
            value={nextNumber}
            onChange={(event) => onChange(nextNumberKey, event.target.value)}
            className={[inputCls, "text-sm disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#64748b]"]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled}
          />
        </div>
      </div>
    </section>
  );
}

function CompanySectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <h3 className="text-[0.9375rem] font-bold text-[#0f172a]">{title}</h3>
      {badge ? (
        <span className="rounded-full bg-[#f8fafc] px-2 py-1 text-[0.68rem] font-bold text-[#94a3b8]">{badge}</span>
      ) : null}
    </div>
  );
}

function CompanyPreviewSidebar({
  form,
  readinessStatus,
  sirenSnapshot,
  vatReady,
  vatRegimeLabel,
  vatCollectionLabel,
}: {
  form: typeof defaultForm;
  readinessStatus: Array<{ label: string; ok: boolean }>;
  sirenSnapshot: string;
  vatReady: boolean;
  vatRegimeLabel: string;
  vatCollectionLabel: string;
}) {
  const completed = readinessStatus.filter((item) => item.ok).length;
  const score = Math.round((completed / Math.max(1, readinessStatus.length)) * 100);
  const initials =
    String(form.name || "ME")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "ME";
  const businessId = formatSiretInput(form.siret || "") || sirenSnapshot || "À renseigner";
  const address = [form.address_line1, form.address_line2, [form.postal_code, form.city].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return (
    <aside className="h-fit overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_12px_28px_-24px_rgba(15,23,42,0.5)] xl:sticky xl:top-4">
      <div className="border-b border-[#eef2f7] p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0f172a] text-sm font-bold text-white">
            {initials}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-[#0f172a]">{form.name || "Entreprise à compléter"}</div>
            <div className="truncate text-[0.72rem] font-semibold text-[#2563eb]">{businessId}</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <CompanyPreviewStat label="Profil" value={`${score}%`} />
          <CompanyPreviewStat label="Pays" value={(form.country_code || "FR").toUpperCase()} />
        </div>
      </div>

      <CompanyPreviewSection title="Préparation" icon={CheckCircle2} tone="blue" badge={`${score}%`}>
        {readinessStatus.map((item) => (
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
      </CompanyPreviewSection>

      <CompanyPreviewSection title="Document" icon={FileText} tone="green">
        <CompanyPreviewRow
          label="Email"
          value={form.email_reply_to || "À renseigner"}
          ok={Boolean(form.email_reply_to)}
        />
        <CompanyPreviewRow label="Téléphone" value={form.phone || "À renseigner"} ok={Boolean(form.phone)} />
        <CompanyPreviewRow
          label="SIREN"
          value={sirenSnapshot || "À renseigner"}
          ok={Boolean(sirenSnapshot && isValidSiren(sirenSnapshot))}
        />
        <CompanyPreviewRow
          label="SIRET"
          value={isValidSiret(form.siret) ? "Valide" : "À corriger"}
          ok={isValidSiret(form.siret)}
        />
        <CompanyPreviewRow label="TVA" value={vatReady ? vatRegimeLabel : "À corriger"} ok={vatReady} />
        <CompanyPreviewRow
          label="Exigibilité"
          value={isVatFranchiseRegime(form.vat_regime) ? "Non applicable" : vatCollectionLabel}
          ok
        />
        <CompanyPreviewRow label="Adresse" value={address || "À renseigner"} ok={Boolean(address)} />
      </CompanyPreviewSection>

      <CompanyPreviewSection title="Paiement" icon={Wallet} tone="amber">
        <CompanyPreviewRow
          label="IBAN"
          value={!form.iban || isValidIban(form.iban) ? "OK" : "À corriger"}
          ok={!form.iban || isValidIban(form.iban)}
        />
        <CompanyPreviewRow
          label="BIC"
          value={!form.bic || isValidBic(form.bic) ? "OK" : "À corriger"}
          ok={!form.bic || isValidBic(form.bic)}
        />
      </CompanyPreviewSection>

      <div className="border-t border-[#eef2f7] p-4">
        <div className="flex items-start gap-2 text-[0.72rem] leading-5 text-[#64748b]">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#94a3b8]" />
          <span>Après enregistrement, ces informations alimentent les devis, factures, exports et emails clients.</span>
        </div>
      </div>
    </aside>
  );
}

function CompanyPreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3 text-center">
      <div className="text-[0.65rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">{label}</div>
      <div className="mt-1 truncate text-sm font-bold text-[#0f172a]">{value}</div>
    </div>
  );
}

function CompanyPreviewSection({
  title,
  icon: Icon,
  tone,
  badge,
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "amber";
  badge?: string;
  children: ReactNode;
}) {
  const palette = {
    blue: "bg-[#eff6ff] text-[#2563eb]",
    green: "bg-[#ecfdf5] text-[#059669]",
    amber: "bg-[#fffbeb] text-[#d97706]",
  }[tone];
  return (
    <section className="border-t border-[#eef2f7] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${palette}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="text-[0.82rem] font-bold text-[#0f172a]">{title}</div>
        </div>
        {badge ? (
          <span className="rounded-full border border-[#e2e8f0] bg-[#f8fafc] px-2 py-0.5 text-[0.68rem] font-bold text-[#64748b]">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function CompanyPreviewRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[0.75rem]">
      <span className="text-[#64748b]">{label}</span>
      <span className={`min-w-0 truncate text-right font-bold ${ok ? "text-[#0f172a]" : "text-[#d97706]"}`}>
        {value}
      </span>
    </div>
  );
}
