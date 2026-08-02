import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AppPageHeader,
  PrimaryButton,
  SecondaryButton,
  NoticeBanner,
  Card,
  StatusPill,
} from "../../components/app/AppPageHeader";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  FileText,
  Landmark,
  Palette,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import {
  companyLegalMentionsDefaults,
  deriveFrenchVatNumberFromSiren,
  digitsOnly,
  formatBicInput,
  formatIbanInput,
  formatNafCodeInput,
  formatPostalCodeInput,
  formatSiretInput,
  formatVatNumberInput,
  isValidBic,
  isValidFrenchVatNumber,
  isValidIban,
  isValidNafCode,
  isValidSiret,
  normalizeBic,
  normalizeCountryCode,
  normalizeIban,
  normalizeNafCode,
  normalizeVatNumber,
} from "@/lib/businessRules";

const inputCls =
  "w-full rounded-xl border border-[#e2e8f0] bg-white px-3.5 py-2.5 text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20";
const inputStyle = {
  fontSize: "0.875rem",
};
const labelCls = "block text-[#374151] mb-1.5";
const labelStyle = { fontSize: "0.8125rem", fontWeight: 500 as const };

function Field({
  label,
  required,
  hint,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <div>
      <label className={labelCls} style={labelStyle}>
        {label}
        {required && <span className="text-[#ef4444] ml-0.5">*</span>}
      </label>
      <input
        className={`${inputCls} ${error ? "ring-2 ring-[#ef4444]/30" : ""}`}
        style={{ ...inputStyle, borderColor: error ? "#fca5a5" : undefined }}
        {...props}
      />
      {error && (
        <p className="mt-1 text-[#ef4444]" style={{ fontSize: "0.75rem" }}>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

type ScoreKey = "devis" | "facture" | "paiement" | "einvoicing";
function ReadinessScores({ fields, compact = false }: { fields: Record<string, string>; compact?: boolean }) {
  const scores: { key: ScoreKey; label: string; checks: boolean[] }[] = [
    {
      key: "devis",
      label: "Devis prêt",
      checks: [!!fields.name, isValidSiret(fields.siret), !!fields.vatOrExemption, !!fields.address],
    },
    {
      key: "facture",
      label: "Facture prête",
      checks: [
        !!fields.name,
        isValidSiret(fields.siret),
        !!fields.vatOrExemption,
        !!fields.address,
        !!fields.legal_mentions,
        !!fields.late_payment_interest,
      ],
    },
    {
      key: "paiement",
      label: "Paiement prêt",
      checks: [!fields.iban || isValidIban(fields.iban), !fields.bic || isValidBic(fields.bic)],
    },
    {
      key: "einvoicing",
      label: "E-facturation prête",
      checks: [isValidSiret(fields.siret), !!fields.vatOrExemption, !!fields.address, !!fields.legal_mentions],
    },
  ];

  if (compact) {
    return (
      <div className="space-y-2.5">
        {scores.map((s) => {
          const done = s.checks.filter(Boolean).length;
          const total = s.checks.length;
          const ok = done === total;
          return (
            <div
              key={s.key}
              className="flex items-center justify-between gap-3 rounded-xl border border-[#eef2f7] bg-[#fafcff] px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                  {s.label}
                </p>
                <p className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                  {done}/{total}
                </p>
              </div>
              <StatusPill status={ok ? "ok" : "warn"} label={ok ? "OK" : "À faire"} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {scores.map((s) => {
        const done = s.checks.filter(Boolean).length;
        const total = s.checks.length;
        const ok = done === total;
        return (
          <div
            key={s.key}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border ${ok ? "bg-[#f0fdf4] border-[#bbf7d0]" : "bg-[#fffbeb] border-[#fde68a]"}`}
          >
            {ok ? (
              <CheckCircle2 className="w-4 h-4 text-[#16a34a] flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-[#d97706] flex-shrink-0" />
            )}
            <div className="min-w-0">
              <p
                className={`truncate ${ok ? "text-[#15803d]" : "text-[#92400e]"}`}
                style={{ fontSize: "0.75rem", fontWeight: 600 }}
              >
                {s.label}
              </p>
              <p className={ok ? "text-[#16a34a]" : "text-[#d97706]"} style={{ fontSize: "0.625rem" }}>
                {done}/{total}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[0.9375rem] font-semibold text-[#0f172a]">{title}</h2>
      {badge ? <div className="text-[0.6875rem] font-bold text-[#94a3b8]">{badge}</div> : null}
    </div>
  );
}

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="space-y-4">
      <SectionHeader title={title} badge={badge} />
      {children}
    </Card>
  );
}

function CompanyPanelStat({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: React.ReactNode;
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

function CompanyPanelRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-[#475569]" style={{ fontSize: "0.78rem" }}>
      <span className="text-[#94a3b8]">{label}</span>
      <span className="max-w-[62%] text-right font-semibold text-[#0f172a]">{value}</span>
    </div>
  );
}

const defaultForm = {
  name: "",
  siren: "",
  siret: "",
  naf_code: "",
  vat: "",
  vat_exemption_notice: "",
  legal_form: "",
  share_capital: "",
  address: "",
  address2: "",
  postal: "",
  city: "",
  country: "FR",
  phone: "",
  email_reply_to: "",
  iban: "",
  bic: "",
  vat_regime: "real_normal_monthly",
  vat_on_debits: false,
  legal_mentions: "",
  late_payment_interest: "Taux BCE + 10 points",
  recovery_fee_eur: "40",
  discount_terms: "Néant",
};

function normalizeCompanyPhoneInput(value: string) {
  return String(value || "")
    .replace(/[^\d+().\-\s]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

export function CompanyPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sireneLoading, setSireneLoading] = useState(false);
  const [sireneSearchOpen, setSireneSearchOpen] = useState(false);
  const [fields, setFields] = useState({ ...defaultForm });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (k: string) => (v: string) => setFields((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setPageError(null);
      try {
        const res = await rawApi("/api/company/profile");
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger le dossier entreprise."));
        }
        const profile = await res.json().catch(() => null);
        if (cancelled || !profile) return;
        const siret = formatSiretInput(profile.siret || "");
        setFields({
          name: profile.name || "",
          siren: digitsOnly(profile.siret || "").slice(0, 9),
          siret,
          naf_code: formatNafCodeInput(profile.naf_code || ""),
          vat: formatVatNumberInput(profile.vat_number || ""),
          vat_exemption_notice: profile.vat_exemption_notice || "",
          legal_form: profile.legal_form || "",
          share_capital: profile.share_capital || "",
          address: profile.address_line1 || profile.address || "",
          address2: profile.address_line2 || "",
          postal: profile.postal_code || "",
          city: profile.city || "",
          country: normalizeCountryCode(profile.country_code || profile.country || "FR", "FR") || "FR",
          phone: normalizeCompanyPhoneInput(profile.phone || ""),
          email_reply_to: profile.email_reply_to || "",
          iban: formatIbanInput(profile.iban || ""),
          bic: formatBicInput(profile.bic || ""),
          vat_regime: profile.vat_regime || "real_normal_monthly",
          vat_on_debits: Boolean(profile.vat_on_debits),
          legal_mentions: profile.legal_mentions || "",
          late_payment_interest: profile.late_payment_interest || "Taux BCE + 10 points",
          recovery_fee_eur: String(profile.recovery_fee_eur ?? "40"),
          discount_terms: profile.discount_terms || "Néant",
        });
      } catch (err) {
        if (!cancelled) setPageError(formatApiError(err, "Impossible de charger le dossier entreprise."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const validate = useCallback(() => {
    const next: Record<string, string> = {};
    const normalizedCountry = normalizeCountryCode(fields.country, "FR") || "FR";
    if (!fields.name.trim()) next.name = "Nom requis";
    if (!isValidSiret(fields.siret)) next.siret = "SIRET invalide (14 chiffres avec contrôle)";
    if (fields.naf_code.trim() && !isValidNafCode(fields.naf_code))
      next.naf_code = "Format attendu : 62.01Z ou 6201Z. 72.2C correspond à un ancien format NAF 2003.";
    if (fields.vat_regime !== "franchise" && !isValidFrenchVatNumber(fields.vat))
      next.vat = "TVA invalide (ex: FR12345678901)";
    if (fields.vat_regime === "franchise" && !fields.vat_exemption_notice.trim())
      next.vat_exemption_notice = "Mention d'exonération requise";
    if (!fields.address.trim()) next.address = "Adresse requise";
    if (normalizedCountry === "FR" && !/^\d{5}$/.test(formatPostalCodeInput(fields.postal, "FR")))
      next.postal = "Code postal FR : 5 chiffres";
    if (!fields.city.trim()) next.city = "Ville requise";
    if (fields.iban.trim() && !isValidIban(fields.iban)) next.iban = "IBAN invalide";
    if (fields.bic.trim() && !isValidBic(fields.bic)) next.bic = "BIC invalide (8 ou 11 caractères)";
    if (!fields.legal_mentions.trim()) next.legal_mentions = "Mentions légales requises";
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [fields]);

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    setPageError(null);
    setNotice(null);
    try {
      const normalizedCountry = normalizeCountryCode(fields.country, "FR") || "FR";
      const payload = {
        name: fields.name.trim(),
        siret: digitsOnly(fields.siret),
        naf_code: normalizeNafCode(fields.naf_code) || null,
        vat_number:
          fields.vat_regime === "franchise" ? normalizeVatNumber(fields.vat) || null : normalizeVatNumber(fields.vat),
        vat_exemption_notice:
          fields.vat_regime === "franchise"
            ? fields.vat_exemption_notice.trim() || "TVA non applicable, art. 293 B du CGI."
            : fields.vat_exemption_notice.trim() || null,
        legal_form: fields.legal_form.trim() || null,
        share_capital: fields.share_capital.trim() || null,
        address_line1: fields.address.trim(),
        address_line2: fields.address2.trim() || null,
        postal_code: fields.postal.trim() || null,
        city: fields.city.trim() || null,
        country_code: normalizedCountry,
        country: normalizedCountry,
        phone: normalizeCompanyPhoneInput(fields.phone).trim() || null,
        email_reply_to: fields.email_reply_to.trim() || null,
        iban: normalizeIban(fields.iban) || null,
        bic: normalizeBic(fields.bic) || null,
        vat_regime: fields.vat_regime,
        vat_on_debits: Boolean(fields.vat_on_debits),
        legal_mentions: fields.legal_mentions.trim(),
        late_payment_interest: fields.late_payment_interest.trim() || null,
        recovery_fee_eur: Number(fields.recovery_fee_eur || 0) || 0,
        discount_terms: fields.discount_terms.trim() || null,
      };
      const profile = await api("/api/company/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setFields((prev) => ({
        ...prev,
        siren: digitsOnly(profile?.siret || prev.siret).slice(0, 9),
        siret: formatSiretInput(profile?.siret || prev.siret),
        naf_code: formatNafCodeInput(profile?.naf_code || prev.naf_code),
        vat: formatVatNumberInput(profile?.vat_number || prev.vat),
        vat_exemption_notice: profile?.vat_exemption_notice || prev.vat_exemption_notice,
        country: normalizeCountryCode(profile?.country_code || profile?.country || prev.country, "FR") || "FR",
        phone: normalizeCompanyPhoneInput(profile?.phone || prev.phone),
        email_reply_to: profile?.email_reply_to || prev.email_reply_to,
        iban: formatIbanInput(profile?.iban || prev.iban),
        bic: formatBicInput(profile?.bic || prev.bic),
        vat_on_debits: Boolean(profile?.vat_on_debits ?? prev.vat_on_debits),
        discount_terms: profile?.discount_terms || prev.discount_terms,
      }));
      setSaved(true);
      setNotice("Profil entreprise enregistré.");
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setPageError(formatApiError(err, "Impossible d'enregistrer l'entreprise."));
    } finally {
      setSaving(false);
    }
  };

  const sireneLookup = async () => {
    const siret = digitsOnly(fields.siret);
    const siren = digitsOnly(fields.siren);
    if (!siret && !siren) {
      setPageError("Renseignez un SIREN ou un SIRET avant le préremplissage.");
      return false;
    }
    setSireneLoading(true);
    setPageError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (siret) params.set("siret", siret);
      else params.set("siren", siren);
      const res = await rawApi(`/api/customers/company-lookup?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Recherche SIRENE indisponible."));
      }
      const data = await res.json().catch(() => null);
      setFields((prev) => ({
        ...prev,
        name: data?.name || prev.name,
        siren: digitsOnly(data?.siren || prev.siren).slice(0, 9),
        siret: formatSiretInput(data?.siret || prev.siret),
        naf_code: formatNafCodeInput(data?.naf_code || prev.naf_code),
        vat: (() => {
          const country =
            normalizeCountryCode(data?.country_code || data?.country || prev.country || "FR", "FR") || "FR";
          const lookupSiren = digitsOnly(data?.siren || data?.siret || prev.siren || prev.siret).slice(0, 9);
          if (country !== "FR") return prev.vat;
          return formatVatNumberInput(data?.vat_number || deriveFrenchVatNumberFromSiren(lookupSiren) || prev.vat);
        })(),
        address: data?.address_line1 || prev.address,
        address2: data?.address_line2 || prev.address2,
        postal: data?.postal_code || prev.postal,
        city: data?.city || prev.city,
        country: normalizeCountryCode(data?.country_code || data?.country || prev.country || "FR", "FR") || "FR",
      }));
      setNotice("Données SIRENE récupérées : identité, SIRET, NAF et TVA si disponible.");
      return true;
    } catch (err) {
      setPageError(formatApiError(err, "Recherche SIRENE indisponible."));
      return false;
    } finally {
      setSireneLoading(false);
    }
  };

  const vatOrExemption = fields.vat_regime === "franchise" ? fields.vat_exemption_notice || "FRANCHISE" : fields.vat;
  const checklistItems = useMemo(
    () => [
      { label: "Nom commercial", ok: !!fields.name.trim() },
      { label: "SIRET", ok: isValidSiret(fields.siret) },
      {
        label: "TVA / exonération",
        ok:
          fields.vat_regime === "franchise"
            ? Boolean(fields.vat_exemption_notice.trim())
            : isValidFrenchVatNumber(fields.vat),
      },
      { label: "Adresse", ok: !!fields.address.trim() && !!fields.city.trim() },
      { label: "Mentions légales", ok: !!fields.legal_mentions.trim() && !!fields.late_payment_interest.trim() },
      { label: "IBAN", ok: !fields.iban.trim() || isValidIban(fields.iban) },
      { label: "BIC", ok: !fields.bic.trim() || isValidBic(fields.bic) },
    ],
    [fields],
  );
  const done = checklistItems.filter((c) => c.ok).length;
  const total = checklistItems.length;
  const pct = Math.round((done / total) * 100);
  const allOk = done === total;
  const missingItems = checklistItems.filter((c) => !c.ok);
  const addressReady = !!fields.address.trim() && !!fields.postal.trim() && !!fields.city.trim();
  const nextAction = !fields.name.trim()
    ? "Renseignez la raison sociale."
    : !isValidSiret(fields.siret)
      ? "Préremplissez ou corrigez le SIRET."
      : !(fields.vat_regime === "franchise" || isValidFrenchVatNumber(fields.vat))
        ? "Vérifiez la TVA ou choisissez la franchise."
        : fields.vat_regime === "franchise" && !fields.vat_exemption_notice.trim()
          ? "Ajoutez la mention d'exonération TVA."
          : !addressReady
            ? "Complétez l'adresse du siège."
            : !fields.legal_mentions.trim()
              ? "Ajoutez les mentions légales."
              : !fields.iban.trim()
                ? "Ajoutez l'IBAN."
                : "Dossier prêt pour l'émission.";
  const addressPreview = [fields.address.trim(), fields.postal.trim(), fields.city.trim()].filter(Boolean).join(", ");
  const sirenSnapshot = digitsOnly(fields.siret || fields.siren).slice(0, 9);
  const sireneSeed = digitsOnly(fields.siret) || digitsOnly(fields.siren);
  const sireneReady = sireneSeed.length === 9 || sireneSeed.length === 14;
  const sireneHint = sireneSeed
    ? `${sireneSeed.length === 14 ? "SIRET" : "SIREN"} détecté`
    : "Entre un SIREN ou un SIRET pour préremplir.";
  const displaySireneSeed = fields.siret || fields.siren;
  const showSireneSearch = sireneSearchOpen || !sireneReady;
  const updateSireneSeed = (value: string) => {
    const digits = digitsOnly(value);
    if (!digits) {
      setFields((prev) => ({ ...prev, siren: "", siret: "" }));
      return;
    }
    if (digits.length > 9) {
      const siret = formatSiretInput(value);
      setFields((prev) => ({ ...prev, siret, siren: digitsOnly(siret).slice(0, 9) }));
      return;
    }
    setFields((prev) => ({ ...prev, siren: digits.slice(0, 9), siret: "" }));
  };
  const displayName = fields.name.trim() || "Dossier entreprise";
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "EN";
  const status = allOk
    ? { tone: "ok" as const, label: "Prêt" }
    : pct >= 70
      ? { tone: "warn" as const, label: "À compléter" }
      : { tone: "muted" as const, label: "Brouillon" };
  const readinessFields = {
    name: fields.name,
    siret: fields.siret,
    vatOrExemption,
    address: addressPreview,
    legal_mentions: fields.legal_mentions,
    late_payment_interest: fields.late_payment_interest,
    iban: fields.iban,
    bic: fields.bic,
  };

  return (
    <div>
      <AppPageHeader
        title="Dossier entreprise"
        breadcrumb="Paramètres · Entreprise"
        description="Ces informations alimentent Factur-X, Chorus Pro, les mentions légales et les factures."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/settings/branding"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[#374151] transition-all hover:bg-[#f8fafc] active:scale-[0.97]"
              style={{
                fontSize: "var(--pf-app-text-body)",
                fontWeight: 500,
                border: "1px solid rgba(0,0,0,0.08)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              }}
            >
              <Palette className="h-3.5 w-3.5 text-[#7c3aed]" />
              Branding documents
            </Link>
            <PrimaryButton onClick={handleSave} disabled={saving || loading}>
              {saved ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" /> Enregistré
                </>
              ) : saving ? (
                "Enregistrement…"
              ) : (
                "Enregistrer"
              )}
            </PrimaryButton>
          </div>
        }
      />

      <div className="w-full space-y-6 p-5 lg:p-7">
        <div className="space-y-3">
          {pageError ? (
            <NoticeBanner variant="danger" title="Dossier entreprise">
              {pageError}
            </NoticeBanner>
          ) : null}
          {notice ? (
            <NoticeBanner variant="success" title="Dossier entreprise">
              {notice}
            </NoticeBanner>
          ) : null}
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-4">
            <Card className="space-y-4 p-4">
              <div>
                <div className="text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#64748b]">
                  Identification
                </div>
                <div className="mt-0.5 text-[0.85rem] font-bold text-[#0f172a]">Dossier entreprise</div>
              </div>
              <div className="rounded-2xl border border-[#dbeafe] bg-[#f8fbff] p-3">
                {showSireneSearch ? (
                  <>
                    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_170px] lg:items-center">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dbeafe] text-[#1d4ed8]">
                          <RefreshCw className={`h-4 w-4 ${sireneLoading ? "animate-spin" : ""}`} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[0.82rem] font-bold text-[#0f172a]">Recherche entreprise</div>
                          <div className="text-[0.7rem] font-semibold text-[#64748b]">SIREN ou SIRET</div>
                        </div>
                      </div>

                      <label className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] px-3 transition-colors">
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.07em] ${
                            sireneReady ? "bg-[#dbeafe] text-[#1d4ed8]" : "bg-white text-[#64748b]"
                          }`}
                        >
                          {sireneReady ? "Prêt" : "9 ou 14"}
                        </span>
                        <input
                          aria-label="SIREN ou SIRET pour préremplissage"
                          value={displaySireneSeed}
                          onChange={(event) => updateSireneSeed(event.target.value)}
                          placeholder="123 456 789 ou 123 456 789 00012"
                          inputMode="numeric"
                          maxLength={18}
                          className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:outline-none focus:ring-0 focus:shadow-none"
                          style={{ fontSize: "0.875rem" }}
                          disabled={loading}
                        />
                      </label>

                      <PrimaryButton
                        onClick={async () => {
                          if (await sireneLookup()) {
                            setSireneSearchOpen(false);
                          }
                        }}
                        disabled={!sireneReady || sireneLoading || loading}
                        className="h-11 w-full rounded-xl px-5"
                      >
                        <RefreshCw className={`h-4 w-4 ${sireneLoading ? "animate-spin" : ""}`} />
                        {sireneLoading ? "Recherche…" : "Rechercher"}
                      </PrimaryButton>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex rounded-full border px-2 py-1 text-[0.7rem] font-semibold ${
                          sireneReady
                            ? "border-[#bbf7d0] bg-white text-[#047857]"
                            : "border-[#dbeafe] bg-white text-[#64748b]"
                        }`}
                      >
                        {sireneHint}
                      </span>
                      <span className="text-[0.72rem] font-medium text-[#64748b]">
                        À faire en premier : le préremplissage reprend raison sociale, adresse, SIRET, code NAF et TVA
                        si possible.
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex rounded-full border border-[#bbf7d0] bg-white px-2 py-1 text-[0.7rem] font-semibold text-[#047857]">
                          {sireneHint}
                        </span>
                        <span className="text-[0.82rem] font-bold text-[#0f172a]">{displaySireneSeed}</span>
                      </div>
                      <div className="mt-1 text-[0.72rem] font-medium text-[#64748b]">
                        Entreprise identifiée. Les informations principales peuvent maintenant être corrigées dans le
                        dossier ci-dessous.
                      </div>
                    </div>
                    <SecondaryButton
                      onClick={() => setSireneSearchOpen(true)}
                      className="h-10 rounded-xl px-4"
                      disabled={loading}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Rechercher une autre entreprise
                    </SecondaryButton>
                  </div>
                )}
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px]">
                <div className="flex min-h-[3.35rem] items-center gap-2.5 rounded-xl border border-[#fb923c] bg-[#fff7ed] px-3 text-left text-[#9a3412] shadow-[0_8px_18px_rgba(251,146,60,0.1)]">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ffedd5] text-[#ea580c]">
                    <Building2 className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[0.82rem] font-semibold text-[#0f172a]">Professionnel</span>
                    <span className="block truncate text-[0.68rem] text-[#64748b]">Émetteur des devis et factures</span>
                  </span>
                </div>
                <div className="flex min-h-[3.35rem] items-center gap-2.5 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 text-left text-[#475569]">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#64748b]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[0.82rem] font-semibold text-[#0f172a]">Conformité</span>
                    <span className="block truncate text-[0.68rem] text-[#64748b]">SIRET, TVA, mentions</span>
                  </span>
                </div>
                <div className="flex min-h-[3.35rem] items-center justify-between gap-2 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 text-[#64748b]">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Landmark className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-[0.75rem] font-bold">Paiement</span>
                  </span>
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${fields.iban.trim() && isValidIban(fields.iban) ? "bg-[#22c55e]" : "bg-[#cbd5e1]"}`}
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Card>

            <Section title="Informations principales" badge="Entreprise">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <Field
                    label="Nom commercial / Raison sociale"
                    required
                    value={fields.name}
                    onChange={(e) => set("name")(e.target.value)}
                    placeholder="ACME SAS"
                    error={errors.name}
                    disabled={loading}
                  />
                </div>
                <Field
                  label="SIREN"
                  hint="Repris automatiquement depuis le SIRET."
                  value={fields.siren}
                  onChange={(e) => set("siren")(digitsOnly(e.target.value).slice(0, 9))}
                  placeholder="123456789"
                  maxLength={9}
                  disabled={loading}
                />
                <Field
                  label="SIRET"
                  required
                  hint="14 chiffres, espaces gérés automatiquement."
                  value={fields.siret}
                  onChange={(e) => {
                    const next = formatSiretInput(e.target.value);
                    setFields((prev) => ({ ...prev, siret: next, siren: digitsOnly(next).slice(0, 9) }));
                  }}
                  placeholder="123 456 789 00011"
                  error={errors.siret}
                  disabled={loading}
                />
                <Field
                  label="N° TVA intracommunautaire"
                  required={fields.vat_regime !== "franchise"}
                  hint={
                    fields.vat_regime === "franchise"
                      ? "Optionnel en franchise en base."
                      : "Format : FR 00 000 000 000."
                  }
                  value={fields.vat}
                  onChange={(e) => set("vat")(formatVatNumberInput(e.target.value))}
                  placeholder="FR 00 000 000 000"
                  error={errors.vat}
                  disabled={loading}
                />
                <Field
                  label="Code NAF / APE"
                  hint="Optionnel : format actuel 4 chiffres + 1 lettre, ex. 62.01Z."
                  value={fields.naf_code}
                  onChange={(e) => set("naf_code")(formatNafCodeInput(e.target.value))}
                  placeholder="62.01Z"
                  error={errors.naf_code}
                  disabled={loading}
                />
                <Field
                  label="Forme juridique"
                  value={fields.legal_form}
                  onChange={(e) => set("legal_form")(e.target.value)}
                  placeholder="SAS, SARL, EURL…"
                  disabled={loading}
                />
                <Field
                  label="Capital social"
                  value={fields.share_capital}
                  onChange={(e) => set("share_capital")(e.target.value)}
                  placeholder="10 000 €"
                  disabled={loading}
                />
                <Field
                  label="Téléphone"
                  value={fields.phone}
                  onChange={(e) => set("phone")(normalizeCompanyPhoneInput(e.target.value))}
                  placeholder="01 23 45 67 89"
                  inputMode="tel"
                  maxLength={24}
                  disabled={loading}
                />
                <Field
                  label="Email de réponse"
                  value={fields.email_reply_to}
                  onChange={(e) => set("email_reply_to")(e.target.value)}
                  placeholder="contact@entreprise.fr"
                  disabled={loading}
                />
              </div>
            </Section>

            <Section title="Adresse & conformité" badge={fields.country || "FR"}>
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Adresse (ligne 1)"
                  required
                  value={fields.address}
                  onChange={(e) => set("address")(e.target.value)}
                  placeholder="1 rue Exemple"
                  error={errors.address}
                  disabled={loading}
                />
                <Field
                  label="Adresse (ligne 2)"
                  value={fields.address2}
                  onChange={(e) => set("address2")(e.target.value)}
                  placeholder="Bâtiment, étage…"
                  disabled={loading}
                />
                <Field
                  label="Code postal"
                  required
                  value={fields.postal}
                  onChange={(e) => set("postal")(formatPostalCodeInput(e.target.value, fields.country))}
                  placeholder="75001"
                  maxLength={(normalizeCountryCode(fields.country, "FR") || "FR") === "FR" ? 5 : 16}
                  error={errors.postal}
                  disabled={loading}
                />
                <Field
                  label="Ville"
                  required
                  value={fields.city}
                  onChange={(e) => set("city")(e.target.value)}
                  placeholder="Paris"
                  error={errors.city}
                  disabled={loading}
                />
                <div className="md:col-span-2">
                  <label className={labelCls} style={labelStyle}>
                    Pays
                  </label>
                  <select
                    className={inputCls}
                    style={inputStyle}
                    value={fields.country}
                    onChange={(e) => set("country")(normalizeCountryCode(e.target.value, "FR") || "FR")}
                    disabled={loading}
                  >
                    <option value="FR">France</option>
                    <option value="BE">Belgique</option>
                    <option value="CH">Suisse</option>
                    <option value="DE">Allemagne</option>
                    <option value="LU">Luxembourg</option>
                  </select>
                </div>
              </div>
            </Section>

            <Section title="Coordonnées bancaires" badge={fields.iban.trim() ? "Paiement" : "Optionnel"}>
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="IBAN"
                  hint="Groupé par 4 en affichage"
                  value={fields.iban}
                  onChange={(e) => set("iban")(formatIbanInput(e.target.value))}
                  placeholder="FR76 3000 1234 5678 9012 3456 789"
                  error={errors.iban}
                  disabled={loading}
                />
                <Field
                  label="BIC / SWIFT"
                  hint="8 ou 11 caractères, majuscules"
                  value={fields.bic}
                  onChange={(e) => set("bic")(formatBicInput(e.target.value))}
                  placeholder="AGRIFRPP"
                  error={errors.bic}
                  disabled={loading}
                />
              </div>
            </Section>

            <Section title="Fiscalité & e-reporting" badge={fields.vat_regime === "franchise" ? "Franchise" : "TVA"}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className={labelCls} style={labelStyle}>
                    Régime TVA
                  </label>
                  <select
                    className={inputCls}
                    style={inputStyle}
                    value={fields.vat_regime}
                    onChange={(e) => {
                      const nextRegime = e.target.value;
                      setFields((prev) => ({
                        ...prev,
                        vat_regime: nextRegime,
                        vat_exemption_notice:
                          nextRegime === "franchise" && !prev.vat_exemption_notice.trim()
                            ? "TVA non applicable, art. 293 B du CGI."
                            : prev.vat_exemption_notice,
                      }));
                    }}
                    disabled={loading}
                  >
                    <option value="real_normal_monthly">Réel normal (mensuel)</option>
                    <option value="real_normal_quarterly">Réel normal (trimestriel)</option>
                    <option value="simplified">Régime simplifié</option>
                    <option value="franchise">Franchise en base</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls} style={labelStyle}>
                    Exigibilité TVA
                  </label>
                  <select
                    className={inputCls}
                    style={inputStyle}
                    value={fields.vat_on_debits ? "debits" : "encaissements"}
                    onChange={(e) => setFields((prev) => ({ ...prev, vat_on_debits: e.target.value === "debits" }))}
                    disabled={loading || fields.vat_regime === "franchise"}
                  >
                    <option value="encaissements">TVA sur les encaissements</option>
                    <option value="debits">TVA sur les débits</option>
                  </select>
                </div>
                {fields.vat_regime === "franchise" ? (
                  <div className="md:col-span-2">
                    <Field
                      label="Mention d'exonération TVA"
                      required
                      value={fields.vat_exemption_notice}
                      onChange={(e) => set("vat_exemption_notice")(e.target.value)}
                      placeholder="TVA non applicable, art. 293 B du CGI."
                      error={errors.vat_exemption_notice}
                      disabled={loading}
                    />
                  </div>
                ) : null}
              </div>
            </Section>

            <Section title="Mentions légales & emails" badge={fields.legal_mentions.trim() ? "Prêtes" : "À compléter"}>
              <div>
                <label className={labelCls} style={labelStyle}>
                  Mentions légales <span className="text-[#ef4444]">*</span>
                </label>
                <textarea
                  rows={4}
                  className={`${inputCls} resize-none ${errors.legal_mentions ? "ring-2 ring-[#ef4444]/30" : ""}`}
                  style={{ ...inputStyle, borderColor: errors.legal_mentions ? "#fca5a5" : undefined }}
                  value={fields.legal_mentions}
                  onChange={(e) => set("legal_mentions")(e.target.value)}
                  placeholder="Pénalités de retard : taux BCE + 10 points. Indemnité forfaitaire de recouvrement : 40 €."
                  disabled={loading}
                />
                {errors.legal_mentions ? (
                  <p className="mt-1 text-[#ef4444]" style={{ fontSize: "0.75rem" }}>
                    {errors.legal_mentions}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-1.5 text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
                  style={{ fontSize: "0.75rem", fontWeight: 500 }}
                  onClick={() =>
                    set("legal_mentions")(
                      companyLegalMentionsDefaults({
                        vatRegime: fields.vat_regime,
                        vatOnDebits: fields.vat_on_debits,
                      }),
                    )
                  }
                >
                  Insérer les mentions automatiques
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Pénalités de retard"
                  value={fields.late_payment_interest}
                  onChange={(e) => set("late_payment_interest")(e.target.value)}
                  placeholder="Taux BCE + 10 points"
                  disabled={loading}
                />
                <Field
                  label="Indemnité forfaitaire (€)"
                  value={fields.recovery_fee_eur}
                  onChange={(e) => set("recovery_fee_eur")(e.target.value)}
                  placeholder="40"
                  disabled={loading}
                />
                <Field
                  label="Escompte"
                  value={fields.discount_terms}
                  onChange={(e) => set("discount_terms")(e.target.value)}
                  placeholder="Néant"
                  disabled={loading}
                />
              </div>
            </Section>
          </div>

          <aside className="overflow-hidden bg-white shadow-[0_10px_24px_rgba(15,23,42,0.06)] xl:sticky xl:top-4">
            <section className="px-4 py-5">
              <div className="flex items-center justify-between gap-3">
                <div
                  className="text-[#94a3b8]"
                  style={{ fontSize: "0.68rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
                >
                  Aperçu entreprise
                </div>
                <StatusPill status={status.tone} label={status.label} />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2563eb] text-white"
                  style={{ fontSize: "0.75rem", fontWeight: 850 }}
                >
                  {initials}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[#0f172a]" style={{ fontSize: "0.92rem", fontWeight: 850 }}>
                    {displayName}
                  </div>
                  <div className="truncate text-[#4f46e5]" style={{ fontSize: "0.75rem", fontWeight: 520 }}>
                    {fields.vat || fields.siret || "Identifiants à compléter"}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <CompanyPanelStat label="Profil" value={`${pct}%`} tone={pct >= 85 ? "green" : "slate"} />
                <CompanyPanelStat label="Points" value={`${done}/${total}`} tone={allOk ? "green" : "slate"} />
              </div>
            </section>

            <section className="border-t border-[#e2e8f0] px-4 py-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eff6ff] text-[#2563eb]">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
                <h3 className="text-[#0f172a]" style={{ fontSize: "0.82rem", fontWeight: 800 }}>
                  Préparation
                </h3>
              </div>
              <div className="mt-3">
                <ReadinessScores fields={readinessFields} compact />
              </div>
              <div
                className="mt-3 rounded-xl border px-3 py-2 text-[#475569]"
                style={{ borderColor: "#dbeafe", background: "#eff6ff", fontSize: "0.74rem", lineHeight: 1.4 }}
              >
                {nextAction}
              </div>
            </section>

            <section className="border-t border-[#e2e8f0] px-4 py-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#ecfdf5] text-[#059669]">
                  <FileText className="h-3.5 w-3.5" />
                </span>
                <h3 className="text-[#0f172a]" style={{ fontSize: "0.82rem", fontWeight: 800 }}>
                  Document
                </h3>
              </div>
              <div className="mt-3 space-y-3">
                <CompanyPanelRow label="SIREN" value={sirenSnapshot || "À renseigner"} />
                <CompanyPanelRow label="SIRET" value={fields.siret || "À renseigner"} />
                <CompanyPanelRow
                  label="TVA"
                  value={fields.vat_regime === "franchise" ? "Franchise" : fields.vat || "À renseigner"}
                />
                <CompanyPanelRow label="Adresse" value={addressPreview || "À renseigner"} />
              </div>
            </section>

            <section className="border-t border-[#e2e8f0] px-4 py-4">
              <div
                className="text-[#94a3b8]"
                style={{ fontSize: "0.68rem", fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase" }}
              >
                À traiter
              </div>
              <div className="mt-3 space-y-2">
                {(missingItems.length ? missingItems : [{ label: "Dossier complet", ok: true }])
                  .slice(0, 4)
                  .map((item) => (
                    <div
                      key={item.label}
                      className="flex items-center justify-between gap-3 rounded-xl bg-[#f8fafc] px-3 py-2"
                    >
                      <span className="text-[#0f172a]" style={{ fontSize: "0.76rem", fontWeight: 760 }}>
                        {item.label}
                      </span>
                      <StatusPill status={item.ok ? "ok" : "warn"} label={item.ok ? "OK" : "À faire"} />
                    </div>
                  ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
