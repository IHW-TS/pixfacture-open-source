"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Link } from "@/figma/react-router-compat";
import {
  api,
  apiFetch,
  extractUserFacingApiMessage,
  formatApiError,
  rawApi,
  sanitizeUserFacingApiMessage,
} from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { downloadProtectedFile } from "@/lib/download";
import { logout as browserLogout } from "@/lib/authCookies";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession, refreshSession } from "@/lib/useSession";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useWorkspaceSummary } from "@/lib/useWorkspaceSummary";
import {
  AppPageHeader,
  PrimaryButton,
  SecondaryButton,
  DangerButton,
  Card,
  DataTable,
  InputField,
  SelectField,
  SectionTitle,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { InlineHelpTooltip } from "../../components/app/GuidanceTooltip";
import { SeqinoTokenNotice } from "../../components/app/SeqinoTokenNotice";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import { WorkspaceChecklist, WorkspaceReadinessCard } from "../../components/app/WorkspaceReadiness";
import { CompanyPage } from "./CompanyPage";
import {
  Building2,
  CreditCard,
  FileText,
  Palette,
  Shield,
  Download,
  Upload,
  Globe,
  Webhook,
  Layout,
  FlaskConical,
  Paperclip,
  ChevronRight,
  ChevronDown,
  Check,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Trash2,
  PlugZap,
  Mail,
  Database,
  Eye,
  History,
  WandSparkles,
  Lock,
  X,
} from "lucide-react";

const isCsvFile = (file: File) => /\.csv$/i.test(file.name || "");

const settingsLinks = [
  {
    href: "/app/settings/company",
    label: "Entreprise",
    icon: Building2,
    desc: "Raison sociale, SIRET, TVA et identité",
    bg: "bg-[#eff6ff]",
    text: "text-[#1d4ed8]",
  },
  {
    href: "/app/settings/billing",
    label: "Abonnement",
    icon: CreditCard,
    desc: "Plan actif et facturation",
    bg: "bg-[#ecfdf5]",
    text: "text-[#059669]",
  },
  {
    href: "/app/settings/branding",
    label: "Branding",
    icon: Palette,
    desc: "Logo, couleurs et templates de documents",
    bg: "bg-[#f5f3ff]",
    text: "text-[#7c3aed]",
  },
  {
    href: "/app/settings/security",
    label: "Sécurité",
    icon: Shield,
    desc: "Double authentification, sessions actives, permissions",
    bg: "bg-[#fef2f2]",
    text: "text-[#dc2626]",
  },
  {
    href: "/app/settings/attachments",
    label: "Pièces jointes",
    icon: Paperclip,
    desc: "Types autorisés, taille max, stockage",
    bg: "bg-[#ecfeff]",
    text: "text-[#0891b2]",
  },
];

const normalizeStatus = (value?: string | null) => (value || "").trim().toLowerCase();

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type CabinetValidationStatus = "pending_review" | "validated" | "changes_requested";

const normalizeCabinetValidationStatus = (value?: string | null): CabinetValidationStatus => {
  if (value === "validated" || value === "changes_requested") return value;
  return "pending_review";
};

function AccountingStatusBadge({ entry, quality }: { entry: any; quality?: { count: number } | null }) {
  const status = String(entry?.status || "").toLowerCase();
  const cabinetStatus = normalizeCabinetValidationStatus(entry?.cabinet_validation_status);
  const state =
    cabinetStatus === "changes_requested"
      ? { label: "Correction demandée", className: "border-amber-200 bg-amber-50 text-amber-800" }
      : cabinetStatus === "validated"
        ? { label: "Validé cabinet", className: "border-indigo-200 bg-indigo-50 text-indigo-700" }
        : status === "delivered_to_accountant"
          ? { label: "Remis au cabinet", className: "border-emerald-200 bg-emerald-50 text-emerald-700" }
          : quality
            ? {
                label: `${quality.count} alerte${quality.count > 1 ? "s" : ""}`,
                className: "border-amber-200 bg-amber-50 text-amber-800",
              }
            : { label: "Généré", className: "border-blue-200 bg-blue-50 text-blue-700" };

  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold", state.className)}>
      {state.label}
    </span>
  );
}

function accountingQualitySummary(entry: any): { count: number; labels: string[] } | null {
  const quality = entry?.quality_checks || entry?.filters?.quality_checks;
  const warnings = Array.isArray(quality?.warnings) ? quality.warnings : [];
  const count = Number(quality?.warnings_count ?? warnings.length ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  return {
    count,
    labels: warnings
      .map((warning: any) => String(warning?.label || "").trim())
      .filter(Boolean)
      .slice(0, 3),
  };
}

function useTenantData() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [settingsRes, companyRes] = await Promise.allSettled([
          rawApi("/api/settings/tenant"),
          rawApi("/api/company/profile"),
        ]);
        let settingsPayload: any = null;
        let companyPayload: any = null;

        if (settingsRes.status === "fulfilled" && settingsRes.value.ok) {
          settingsPayload = await settingsRes.value.json().catch(() => null);
        }
        if (companyRes.status === "fulfilled" && companyRes.value.ok) {
          companyPayload = await companyRes.value.json().catch(() => null);
        }

        if (!cancelled) {
          setSettings(settingsPayload);
          setCompany(companyPayload);
        }
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Impossible de charger les paramètres."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { loading, error, settings, company };
}

export function SettingsIndexPage() {
  const { loading, error, settings, company } = useTenantData();
  const { summary } = useWorkspaceSummary();

  const cardBadge = (href: string) => {
    if (href === "/app/settings/company") {
      const ok =
        typeof summary?.company?.complete === "boolean"
          ? summary.company.complete
          : Boolean(company?.name && company?.siret && (company?.address_line1 || company?.address));
      return ok ? "Complet" : "À compléter";
    }
    if (href === "/app/settings/billing") {
      const status = normalizeStatus(company?.subscription_status);
      if (!status) return "—";
      if (["active", "trialing"].includes(status)) return "Actif";
      if (["past_due", "unpaid"].includes(status)) return "Paiement requis";
      return status;
    }
    return null;
  };

  return (
    <div>
      <AppPageHeader
        title="Paramètres"
        breadcrumb="Configuration"
        description="Gérez votre espace de facturation, votre profil et vos intégrations."
      />
      <div className="p-5 lg:p-7 w-full space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2 text-xs">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              Configuration
            </p>
            <p className="text-[#0f172a] mt-1 text-[0.9375rem] font-bold">{loading ? "…" : "Standard"}</p>
          </div>
          <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              Complétion
            </p>
            <p className="text-[#0f172a] mt-1 text-[0.9375rem] font-bold">
              {summary
                ? `${summary?.setup?.percent || 0}%`
                : loading
                  ? "…"
                  : settings?.onboarding_completed
                    ? "100%"
                    : "En cours"}
            </p>
          </div>
          <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              Abonnement
            </p>
            <p className="text-[#0f172a] mt-1 text-[0.9375rem] font-bold">
              {loading ? "…" : normalizeStatus(company?.plan) === "pro" ? "Pro" : "Starter"}
            </p>
          </div>
        </div>

        {summary ? (
          <div className="grid xl:grid-cols-[1.15fr,0.85fr] gap-6">
            <WorkspaceReadinessCard
              summary={summary}
              title="État global de la configuration"
              description="Vue homogène du niveau de préparation de l’espace avant mise en vente, documents clients et relances."
            />
            <WorkspaceChecklist summary={summary} limit={4} title="À traiter depuis les réglages" />
          </div>
        ) : null}

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {settingsLinks.map((setting) => {
            const badge = cardBadge(setting.href);
            return (
              <Link
                key={setting.href}
                to={setting.href}
                className="group bg-white border border-[#e2e8f0] rounded-xl p-5 hover:border-[#1d4ed8]/20 hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 transition-all shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className={`w-10 h-10 rounded-xl ${setting.bg} flex items-center justify-center flex-shrink-0`}>
                    <setting.icon className={`w-5 h-5 ${setting.text}`} style={{ strokeWidth: 1.8 }} />
                  </div>
                  <ChevronRight className="w-4 h-4 text-[#cbd5e1] group-hover:text-[#94a3b8] transition-colors mt-0.5" />
                </div>
                <h3 className="text-[#0f172a] mb-1 text-[0.9375rem] font-semibold">{setting.label}</h3>
                <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                  {setting.desc}
                </p>
                {badge && (
                  <div
                    className="mt-3 inline-flex items-center px-2 py-0.5 rounded-full bg-[#f8fafc] text-[#64748b] border border-[#e2e8f0]"
                    style={{ fontSize: "0.6875rem", fontWeight: 600 }}
                  >
                    {badge}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SettingsShell({
  title,
  breadcrumb,
  desc,
  backHref = "/app/settings",
  children,
}: {
  title: string;
  breadcrumb: string;
  desc: string;
  backHref?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <AppPageHeader title={title} breadcrumb={breadcrumb} description={desc} backHref={backHref} />
      <div className="p-5 lg:p-7 w-full space-y-5">{children}</div>
    </div>
  );
}

export function SettingsCompanyPage() {
  return <CompanyPage />;
}

export function SettingsBillingPage() {
  const { plan, subscriptionStatus, trialEnd } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPortal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result: any = await api("/api/billing/portal", { method: "GET" });
      if (!result?.url) throw new Error("Le portail de facturation est momentanément indisponible.");
      window.location.href = result.url;
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ouvrir le portail de facturation."));
    } finally {
      setBusy(false);
    }
  };

  const status = normalizeStatus(subscriptionStatus);
  const statusLabels: Record<string, string> = {
    active: "Actif",
    trialing: "Essai en cours",
    past_due: "Paiement à régulariser",
    unpaid: "Paiement requis",
    canceled: "Résilié",
    cancelled: "Résilié",
    inactive: "Inactif",
  };
  const statusLabel = statusLabels[status] || "Statut en cours de mise à jour";
  const planLabel = normalizeStatus(plan) === "pro" ? "Pro" : "Starter";

  return (
    <SettingsShell title="Abonnement" breadcrumb="Paramètres · Abonnement" desc="Plan actif et facturation.">
      <Card className="max-w-lg space-y-4">
        {error && <p className="text-[#dc2626] text-xs">{error}</p>}
        <div className="flex items-center gap-2 mb-1">
          <div
            className="px-2.5 py-1 rounded-full bg-[#ecfdf5] text-[#047857]"
            style={{ fontSize: "0.6875rem", fontWeight: 700 }}
          >
            {planLabel} · {statusLabel}
          </div>
        </div>
        {trialEnd && status === "trialing" && (
          <p className="text-[#64748b] text-xs">
            Fin d'essai le {new Intl.DateTimeFormat("fr-FR").format(new Date(trialEnd))}
          </p>
        )}
        <div className="flex gap-2">
          <SecondaryButton onClick={openPortal} disabled={busy}>
            Gérer la facturation
          </SecondaryButton>
          <Link
            to="/app/billing"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white transition-all shadow-sm"
            style={{
              fontSize: "0.8125rem",
              fontWeight: 500,
              background: "linear-gradient(135deg, #059669 0%, #0d9488 100%)",
            }}
          >
            Ouvrir la page abonnement <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </Card>
    </SettingsShell>
  );
}

export function SettingsBrandingPage() {
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [savingBranding, setSavingBranding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState("#1d4ed8");
  const [pdfTemplate, setPdfTemplate] = useState("classic");
  const [emailSignature, setEmailSignature] = useState("");
  const [emailFooterNote, setEmailFooterNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [companyRes, settingsRes] = await Promise.allSettled([
          rawApi("/api/company/profile"),
          rawApi("/api/settings/tenant"),
        ]);
        const company =
          companyRes.status === "fulfilled" && companyRes.value.ok
            ? await companyRes.value.json().catch(() => null)
            : null;
        const settings =
          settingsRes.status === "fulfilled" && settingsRes.value.ok
            ? await settingsRes.value.json().catch(() => null)
            : null;
        const branding = settings?.features?.branding || {};
        if (!cancelled) {
          setLogoUrl(company?.logo_url || "");
          setColor(branding?.email_accent || "#1d4ed8");
          setPdfTemplate(branding?.pdf_template || "classic");
          setEmailSignature(branding?.email_signature || "");
          setEmailFooterNote(branding?.email_footer_note || "");
        }
      } catch {
        // ignore
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response: any = await apiFetch("/api/company/logo", { method: "POST", body });
      if (response?.logo_url) {
        setLogoUrl(response.logo_url);
      }
      setNotice("Logo enregistré.");
    } catch (err) {
      setError(formatApiError(err, "Import du logo impossible."));
    } finally {
      setUploading(false);
    }
  };

  const saveBranding = async () => {
    if (savingBranding) return;
    setSavingBranding(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/settings/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          features: {
            branding: {
              pdf_template: pdfTemplate,
              email_accent: color,
              email_signature: emailSignature.trim() || null,
              email_footer_note: emailFooterNote.trim() || null,
            },
          },
        }),
      });
      setNotice("Branding documents enregistré.");
    } catch (err) {
      setError(formatApiError(err, "Enregistrement du branding impossible."));
    } finally {
      setSavingBranding(false);
    }
  };

  return (
    <SettingsShell title="Branding" breadcrumb="Paramètres · Branding" desc="Logo, couleurs et templates de documents.">
      <div className="bg-white border border-[#e2e8f0] rounded-xl p-6 max-w-2xl space-y-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {error && <p className="text-[#dc2626] text-xs">{error}</p>}
        {notice && <p className="text-[#059669] text-xs">{notice}</p>}

        <div>
          <label className="block text-[#374151] mb-2 text-sm font-medium">Logo (PNG/JPG)</label>
          <div className="flex items-center gap-4">
            <div className="relative w-16 h-16 rounded-xl bg-gradient-to-br from-[#f8fafc] to-[#f1f5f9] border-2 border-dashed border-[#cbd5e1] flex items-center justify-center overflow-hidden">
              {logoUrl ? (
                <Image src={logoUrl} alt="Logo" fill sizes="64px" unoptimized className="object-cover" />
              ) : (
                <Palette className="w-5 h-5 text-[#94a3b8]" />
              )}
            </div>
            <div>
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="text-[#374151] text-sm"
                onChange={(e) => void uploadLogo(e.target.files?.[0])}
                disabled={uploading}
              />
              <p className="text-[#94a3b8] mt-1 text-xs">PNG ou JPG, max 2 Mo</p>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[#374151] mb-2 text-sm font-medium">Couleur principale</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-10 h-10 border border-[#e2e8f0] rounded-lg cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
            />
            <div>
              <span className="text-[#0f172a] font-mono text-sm font-semibold">{color}</span>
              <p className="text-[#94a3b8] text-xs">Utilisée sur les emails et les documents compatibles.</p>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[#374151] mb-2 text-sm font-medium">Template PDF par défaut</label>
          <select
            value={pdfTemplate}
            onChange={(event) => setPdfTemplate(event.target.value)}
            className="w-full rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/20"
          >
            <option value="classic">Classique</option>
            <option value="graphite">Graphite</option>
            <option value="ivory">Ivoire</option>
          </select>
        </div>

        <div>
          <label className="block text-[#374151] mb-2 text-sm font-medium">Signature email</label>
          <textarea
            rows={4}
            value={emailSignature}
            onChange={(event) => setEmailSignature(event.target.value)}
            placeholder="Cordialement,&#10;Votre équipe"
            className="w-full resize-none rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/20"
          />
        </div>

        <div>
          <label className="block text-[#374151] mb-2 text-sm font-medium">Note de pied d'email</label>
          <textarea
            rows={3}
            value={emailFooterNote}
            onChange={(event) => setEmailFooterNote(event.target.value)}
            placeholder="Information ajoutée en bas des emails envoyés aux clients."
            className="w-full resize-none rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/20"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e2e8f0] pt-4">
          <p className="text-xs text-[#64748b]">
            Le logo est sauvegardé immédiatement. Les autres réglages utilisent ce bouton.
          </p>
          <PrimaryButton onClick={saveBranding} disabled={savingBranding}>
            {savingBranding ? "Enregistrement…" : "Enregistrer le branding"}
          </PrimaryButton>
        </div>
      </div>
    </SettingsShell>
  );
}

export function SettingsSecurityPage() {
  const { user } = useSession();
  const userRole = String((user as any)?.role || "").toLowerCase();
  const canManageTeam = Boolean((user as any)?.is_admin) || ["owner", "admin"].includes(userRole);
  const [membersCount, setMembersCount] = useState<number | null>(null);
  const [mfaStatus, setMfaStatus] = useState<{
    enabled: boolean;
    configured: boolean;
    required: boolean;
  } | null>(null);
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; uri: string; issuer?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaDisableCode, setMfaDisableCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaNotice, setMfaNotice] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const effectiveMfaEnabled = Boolean(mfaStatus?.enabled ?? (user as any)?.mfa_enabled);
  const effectiveMfaRequired = Boolean(mfaStatus?.required);
  const showMfaPanel = true;

  const loadMfaStatus = useCallback(async () => {
    try {
      const status: any = await apiFetch("/api/auth/mfa/status");
      setMfaStatus({
        enabled: Boolean(status?.enabled),
        configured: Boolean(status?.configured),
        required: Boolean(status?.required),
      });
    } catch (err) {
      setMfaError(formatApiError(err, "Statut de double authentification indisponible."));
    }
  }, []);

  useEffect(() => {
    void loadMfaStatus();
  }, [loadMfaStatus]);

  useEffect(() => {
    if (!canManageTeam) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await rawApi("/api/users");
        if (!res.ok) return;
        const data = await res.json().catch(() => []);
        if (!cancelled && Array.isArray(data)) setMembersCount(data.length);
      } catch {
        // ignore
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [canManageTeam]);

  const startMfaSetup = async () => {
    setMfaBusy("setup");
    setMfaError(null);
    setMfaNotice(null);
    try {
      const setup: any = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
      setMfaSetup({
        secret: String(setup?.secret || ""),
        uri: String(setup?.uri || ""),
        issuer: setup?.issuer ? String(setup.issuer) : undefined,
      });
      setMfaCode("");
      setMfaNotice("Ajoutez cette clé dans votre application d'authentification, puis validez le code généré.");
      await loadMfaStatus();
    } catch (err) {
      setMfaError(formatApiError(err, "Activation de la double authentification impossible."));
    } finally {
      setMfaBusy(null);
    }
  };

  const verifyMfa = async () => {
    setMfaBusy("verify");
    setMfaError(null);
    setMfaNotice(null);
    try {
      await apiFetch("/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      setMfaSetup(null);
      setMfaCode("");
      setMfaStatus((current) => ({
        enabled: true,
        configured: true,
        required: Boolean(current?.required),
      }));
      await refreshSession(true);
      setMfaNotice("Double authentification activée sur votre compte.");
    } catch (err) {
      setMfaError(formatApiError(err, "Code de double authentification invalide."));
    } finally {
      setMfaBusy(null);
    }
  };

  const disableMfa = async () => {
    setMfaBusy("disable");
    setMfaError(null);
    setMfaNotice(null);
    try {
      await apiFetch("/api/auth/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ code: mfaDisableCode.trim() }),
      });
      setMfaDisableCode("");
      setMfaStatus({ enabled: false, configured: false, required: false });
      await refreshSession(true);
      setMfaNotice("Double authentification désactivée sur votre compte.");
    } catch (err) {
      setMfaError(formatApiError(err, "Désactivation de la double authentification impossible."));
    } finally {
      setMfaBusy(null);
    }
  };

  const handlePasswordChange = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    if (newPassword !== confirmPassword) {
      setPasswordError("Les deux nouveaux mots de passe doivent être identiques.");
      return;
    }
    setPasswordBusy(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSuccess(true);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem("login_notice", "Mot de passe modifié. Reconnectez-vous pour continuer.");
      }
      await browserLogout();
    } catch (err) {
      setPasswordError(formatApiError(err, "Modification impossible."));
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <SettingsShell title="Sécurité" breadcrumb="Paramètres · Sécurité" desc="Mot de passe et sécurité de votre compte.">
      <div className="bg-white border border-[#e2e8f0] rounded-xl p-6 max-w-4xl space-y-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {showMfaPanel ? (
          <div className="rounded-xl bg-[#f8fafc] border border-[#e2e8f0] p-4 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#fef2f2] flex items-center justify-center flex-shrink-0">
                  <Shield className="w-4 h-4 text-[#dc2626]" />
                </div>
                <div>
                  <div className="text-[#0f172a] text-sm font-semibold">
                    Double authentification {effectiveMfaRequired ? "obligatoire" : "facultative"}
                  </div>
                  <p className="text-[#64748b] mt-0.5 text-xs leading-5">
                    {effectiveMfaRequired
                      ? "Cette protection est obligatoire pour votre compte d’administration de la plateforme."
                      : effectiveMfaEnabled
                        ? "Double authentification active sur votre compte. Conservez l'application d'authentification configurée."
                        : "Vous pouvez ajouter un code à 6 chiffres en plus du mot de passe. Cette protection reste votre choix."}
                  </p>
                  {canManageTeam && !effectiveMfaRequired ? (
                    <p className="text-[#64748b] mt-1 text-xs leading-5">
                      Chaque membre choisit de l’activer depuis son propre compte. Elle n’est pas imposée à l’équipe.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill
                  label={effectiveMfaEnabled ? "Actif" : "Inactif"}
                  status={effectiveMfaEnabled ? "ok" : "warn"}
                />
                {canManageTeam ? (
                  <Link
                    to="/app/team"
                    className="inline-flex items-center px-3 py-1.5 rounded-lg border border-[#e2e8f0] text-[#374151] hover:bg-white"
                    style={{ fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    Voir l'équipe
                  </Link>
                ) : null}
              </div>
            </div>

            {mfaError ? (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs font-medium text-[#b91c1c]"
              >
                {mfaError}
              </div>
            ) : null}
            {mfaNotice ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-xs font-medium text-[#15803d]"
              >
                {mfaNotice}
              </div>
            ) : null}

            {!effectiveMfaEnabled ? (
              <div className="space-y-3">
                {!mfaSetup ? (
                  <PrimaryButton type="button" onClick={startMfaSetup} disabled={mfaBusy === "setup"}>
                    <Shield className="w-3.5 h-3.5" />
                    {mfaBusy === "setup" ? "Préparation..." : "Activer la double authentification"}
                  </PrimaryButton>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-end">
                    <label className="grid gap-1.5">
                      <span className="text-[11px] font-semibold text-gray-500">Clé à saisir dans l'application</span>
                      <div className="flex min-h-10 items-center rounded-xl border border-[#dbeafe] bg-white px-3 py-2 font-mono text-[12px] font-bold text-[#1e3a8a] break-all">
                        {mfaSetup.secret}
                      </div>
                    </label>
                    <InputField
                      label="Code 6 chiffres"
                      inputMode="numeric"
                      value={mfaCode}
                      onChange={(event) => setMfaCode(event.target.value)}
                      placeholder="123456"
                    />
                    <PrimaryButton
                      type="button"
                      onClick={verifyMfa}
                      disabled={mfaBusy === "verify" || mfaCode.trim().length < 6}
                    >
                      <Check className="w-3.5 h-3.5" />
                      {mfaBusy === "verify" ? "Vérification..." : "Valider"}
                    </PrimaryButton>
                    <div className="flex flex-wrap gap-2 lg:col-span-3">
                      <SecondaryButton type="button" onClick={() => void copyTextToClipboard(mfaSetup.secret)}>
                        Copier la clé
                      </SecondaryButton>
                      <SecondaryButton type="button" onClick={() => void copyTextToClipboard(mfaSetup.uri)}>
                        Copier le lien de configuration
                      </SecondaryButton>
                    </div>
                  </div>
                )}
              </div>
            ) : effectiveMfaRequired ? (
              <p className="text-xs leading-5 text-[#475569]">
                La double authentification ne peut pas être désactivée sur un compte d’administration plateforme.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[220px_auto] sm:items-end">
                <InputField
                  label="Code actuel"
                  inputMode="numeric"
                  value={mfaDisableCode}
                  onChange={(event) => setMfaDisableCode(event.target.value)}
                  placeholder="123456"
                />
                <SecondaryButton
                  type="button"
                  onClick={disableMfa}
                  disabled={mfaBusy === "disable" || mfaDisableCode.trim().length < 6}
                >
                  {mfaBusy === "disable" ? "Désactivation..." : "Désactiver la double authentification"}
                </SecondaryButton>
              </div>
            )}
          </div>
        ) : null}

        <div className="p-4 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-[#34d399]" />
            <div className="text-[#0f172a] text-sm font-semibold">Session active</div>
          </div>
          <p className="text-[#64748b] text-xs">
            {user?.email || "Compte connecté"}
            {canManageTeam ? ` · ${membersCount != null ? `${membersCount} membre(s)` : "Membres non chargés"}` : ""}
          </p>
        </div>

        <form onSubmit={handlePasswordChange} className="p-4 rounded-xl bg-[#f8fafc] border border-[#e2e8f0] space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-[#fef2f2] flex items-center justify-center flex-shrink-0">
              <Lock className="w-4 h-4 text-[#2563eb]" />
            </div>
            <div>
              <div className="text-[#0f172a] text-sm font-semibold">Mot de passe</div>
              <p className="text-[#64748b] text-xs">
                Après modification, toutes les sessions seront déconnectées par sécurité.
              </p>
            </div>
          </div>
          {passwordError ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs font-medium text-[#b91c1c]"
            >
              {passwordError}
            </div>
          ) : null}
          {passwordSuccess ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-xs font-medium text-[#15803d]"
            >
              Mot de passe modifié. Reconnectez-vous pour continuer.
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <InputField
              label="Mot de passe actuel"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoComplete="current-password"
            />
            <InputField
              label="Nouveau mot de passe"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
            <InputField
              label="Confirmation"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </div>
          <PrimaryButton type="submit" disabled={passwordBusy}>
            <Lock className="w-3.5 h-3.5" />
            {passwordBusy ? "Modification..." : "Modifier le mot de passe"}
          </PrimaryButton>
        </form>
      </div>
    </SettingsShell>
  );
}

export function AccountingExportPanel() {
  const { user, capabilities } = useSession();
  const purchasesEnabled = Boolean(capabilities?.purchases_enabled);
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [customers, setCustomers] = useState<Array<{ id: string; name?: string; email?: string }>>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [exportHistory, setExportHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [historyNotes, setHistoryNotes] = useState<Record<string, string>>({});
  const [periodLock, setPeriodLock] = useState<any | null>(null);
  const [chartSummary, setChartSummary] = useState<any | null>(null);
  const [chartSummaryLoading, setChartSummaryLoading] = useState(true);
  const [chartSummaryError, setChartSummaryError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [exportHistoryOpen, setExportHistoryOpen] = useState(false);

  const loadExportHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const payload: any = await apiFetch("/api/exports/accounting?limit=100");
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setExportHistory(items);
      setHistoryNotes((current) => {
        const next = { ...current };
        for (const item of items) {
          if (item?.id && next[item.id] == null) next[item.id] = item.cabinet_comment || "";
        }
        return next;
      });
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[settings-export] export history unavailable", err);
      }
      setExportHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadPeriodLock = useCallback(async () => {
    const params = new URLSearchParams({ limit: "1" });
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
    try {
      const payload: any = await apiFetch(`/api/exports/accounting?${params.toString()}`);
      setPeriodLock(payload?.period_lock || null);
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[settings-export] period lock unavailable", err);
      }
      setPeriodLock(null);
    }
  }, [endDate, selectedCustomerId, startDate]);

  useEffect(() => {
    let cancelled = false;
    const search = customerQuery.trim();
    setCustomerSearchLoading(true);
    const timer = window.setTimeout(
      () => {
        const params = new URLSearchParams({ limit: "80", offset: "0" });
        if (search) params.set("q", search);
        rawApi(`/api/customers?${params.toString()}`)
          .then(async (res) => {
            const payload = res.ok ? await res.json().catch(() => []) : [];
            if (!cancelled) setCustomers(Array.isArray(payload) ? payload : []);
          })
          .catch((err) => {
            if (process.env.NODE_ENV === "development") {
              console.warn("[settings-export] customer filter unavailable", err);
            }
            if (!cancelled) setCustomers([]);
          })
          .finally(() => {
            if (!cancelled) setCustomerSearchLoading(false);
          });
      },
      search ? 180 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [customerQuery]);

  useEffect(() => {
    void loadExportHistory();
  }, [loadExportHistory]);

  useEffect(() => {
    void loadPeriodLock();
  }, [loadPeriodLock]);

  useEffect(() => {
    if (!exportHistoryOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExportHistoryOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [exportHistoryOpen]);

  const userRole = String((user as any)?.role || "").toLowerCase();
  const canMarkAccountingDelivered = Boolean(
    (user as any)?.is_admin || ["owner", "admin", "accountant"].includes(userRole),
  );
  const canOverrideAccountingLock = Boolean((user as any)?.is_admin || ["owner", "admin"].includes(userRole));
  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) || null,
    [customers, selectedCustomerId],
  );
  const selectedCustomerLabel = selectedCustomer
    ? selectedCustomer.name || selectedCustomer.email || selectedCustomer.id
    : "";
  const filteredCustomers = useMemo(() => {
    const query = customerQuery.trim().toLowerCase();
    if (!query || query === selectedCustomerLabel.toLowerCase()) return customers.slice(0, 80);
    return customers
      .filter((customer) => {
        const label = `${customer.name || ""} ${customer.email || ""} ${customer.id || ""}`.toLowerCase();
        return label.includes(query);
      })
      .slice(0, 80);
  }, [customerQuery, customers, selectedCustomerLabel]);

  const download = async (path: string, label = "Export") => {
    try {
      setError(null);
      setExportBusy(label);
      setExportProgress("Préparation du fichier");
      await downloadProtectedFile(path);
      setExportProgress("Téléchargement lancé");
      window.setTimeout(() => void loadExportHistory(), 1200);
    } catch (err) {
      setError(formatApiError(err, "Export impossible."));
    } finally {
      window.setTimeout(() => {
        setExportBusy(null);
        setExportProgress(null);
      }, 450);
    }
  };

  const updateExportStatus = async (entry: any, nextStatus: "generated" | "delivered_to_accountant") => {
    setHistoryBusy(entry.id);
    setError(null);
    try {
      const updated: any = await apiFetch(`/api/exports/accounting/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus, cabinet_comment: historyNotes[entry.id] || "" }),
      });
      setExportHistory((items) => items.map((item) => (item.id === entry.id ? updated : item)));
      setHistoryNotes((items) => ({ ...items, [entry.id]: updated.cabinet_comment || "" }));
      void loadPeriodLock();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour du statut export impossible."));
    } finally {
      setHistoryBusy(null);
    }
  };

  const updateCabinetValidationStatus = async (entry: any, nextStatus: CabinetValidationStatus) => {
    setHistoryBusy(entry.id);
    setError(null);
    try {
      const updated: any = await apiFetch(`/api/exports/accounting/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          cabinet_validation_status: nextStatus,
          cabinet_comment: historyNotes[entry.id] || "",
        }),
      });
      setExportHistory((items) => items.map((item) => (item.id === entry.id ? updated : item)));
      setHistoryNotes((items) => ({ ...items, [entry.id]: updated.cabinet_comment || "" }));
      void loadPeriodLock();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour de la validation cabinet impossible."));
    } finally {
      setHistoryBusy(null);
    }
  };

  const withFilters = (path: string, options: { supportsPeriod?: boolean; supportsCustomer?: boolean } = {}) => {
    const supportsPeriod = options.supportsPeriod !== false;
    const supportsCustomer = options.supportsCustomer !== false;
    const params = new URLSearchParams();
    if (supportsPeriod && startDate) params.set("start_date", startDate);
    if (supportsPeriod && endDate) params.set("end_date", endDate);
    if (supportsCustomer && selectedCustomerId) params.set("customer_id", selectedCustomerId);
    const query = params.toString();
    if (!query) return path;
    return `${path}${path.includes("?") ? "&" : "?"}${query}`;
  };

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
    setChartSummaryLoading(true);
    setChartSummaryError(null);
    apiFetch(`/api/exports/accounting/chart-summary${params.toString() ? `?${params.toString()}` : ""}`)
      .then((payload) => {
        if (!cancelled) setChartSummary(payload);
      })
      .catch((err) => {
        if (!cancelled) {
          setChartSummary(null);
          setChartSummaryError(formatApiError(err, "Plan de comptes indisponible."));
        }
      })
      .finally(() => {
        if (!cancelled) setChartSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endDate, selectedCustomerId, startDate]);

  const formats = [
    {
      key: "cabinet",
      label: "Dossier pour mon comptable",
      path: "/api/exports/accounting/cabinet.zip",
      supportsPeriod: true,
      supportsCustomer: true,
    },
    {
      key: "fec",
      label: "Journal des ventes — expert",
      path: "/api/invoices/export.fec",
      supportsPeriod: true,
      supportsCustomer: true,
    },
  ] as const;
  const chartReady = String(chartSummary?.status || "").toLowerCase() === "ready";
  const missingChartItems = Number(chartSummary?.missing_total || 0);
  const cabinetFormat = formats[0];
  const fecFormat = formats[1];
  const exportLocked = Boolean(periodLock);
  const qualityStatusClass = chartSummaryError
    ? "bg-[#fffbeb] text-[#b45309]"
    : chartReady
      ? "bg-[#ecfdf5] text-[#047857]"
      : "bg-[#fff7ed] text-[#c2410c]";
  const missingSections = Array.isArray(chartSummary?.sections)
    ? chartSummary.sections
        .map((section: any) => ({
          key: String(section?.key || section?.label || ""),
          label: String(section?.label || "Point à compléter"),
          count: Number(section?.missing_count || 0),
        }))
        .filter((section: { count: number }) => Number.isFinite(section.count) && section.count > 0)
    : [];
  const missingSectionsSummary = missingSections.length
    ? missingSections
        .map((section: { label: string; count: number }) => section.label + ": " + section.count)
        .join(" · ")
    : purchasesEnabled || paymentsEnabled
      ? "Points à traiter détaillés dans les sections incluses dans votre plan."
      : "Points à traiter détaillés dans les sections ventes et devis.";
  const salesMissingItems = missingSections.find((section: { key: string }) => section.key === "sales")?.count || 0;
  const hasFecQualityBlocker = !chartSummaryLoading && !chartSummaryError && salesMissingItems > 0;
  const hasCabinetQualityNotice = !chartSummaryLoading && !chartSummaryError && missingChartItems > 0;
  const hasAccountingFilters = Boolean(startDate || endDate || selectedCustomerId);
  const cabinetDownloadPath = hasCabinetQualityNotice
    ? `${cabinetFormat.path}?strict_quality=false`
    : cabinetFormat.path;
  const cabinetDownloadLabel = hasCabinetQualityNotice
    ? "Brouillon cabinet filtré"
    : hasAccountingFilters
      ? "Dossier cabinet filtré"
      : "Tout le dossier cabinet";
  const fecDownloadLabel = hasAccountingFilters ? "Journal ventes filtré" : "Tout le journal ventes";
  const cabinetExportBlocked = chartSummaryLoading || exportLocked || Boolean(exportBusy);
  const strictExportBlocked =
    chartSummaryLoading || Boolean(chartSummaryError) || hasFecQualityBlocker || exportLocked || Boolean(exportBusy);
  const exportBlockReason = chartSummaryLoading
    ? "Contrôle comptable en cours."
    : chartSummaryError
      ? chartSummaryError
      : hasFecQualityBlocker
        ? "Complétez les comptes de vente avant de générer le FEC."
        : exportLocked
          ? "Période déjà remise au cabinet : gérez-la depuis l'historique."
          : "";
  const exportScopeNotice = selectedCustomerId
    ? `Périmètre filtré sur ${selectedCustomerLabel || "ce client"} : les exports suivent uniquement les ventes de ce client.`
    : purchasesEnabled || paymentsEnabled
      ? "Dossier pour mon comptable : ventes et modules Pro inclus dans votre plan à contrôler. Journal des ventes : export expert limité aux ventes."
      : "Dossier Starter : clients, devis, factures et contrôles de vente. Les achats et paiements ne sont ni chargés ni inclus.";
  const exportHistoryRows = useMemo(() => {
    if (!periodLock?.id) return exportHistory;
    return exportHistory.some((entry) => entry?.id === periodLock.id) ? exportHistory : [periodLock, ...exportHistory];
  }, [exportHistory, periodLock]);

  return (
    <>
      <div className="w-full space-y-6">
        {error ? <p className="text-[#dc2626] text-xs">{error}</p> : null}
        {exportBusy ? (
          <NoticeBanner tone="info" title={exportBusy}>
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {exportProgress || "Traitement en cours"}
            </span>
          </NoticeBanner>
        ) : null}

        <div className="relative rounded-2xl border border-[#E8EAF0] bg-white shadow-sm overflow-visible">
          <div className="px-6 py-4 border-b border-[#F0F3F8] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                <FileText size={14} className="text-[#5B5FEE]" />
              </div>
              <p className="text-[14px] font-bold text-gray-900">Exports comptables</p>
              <span
                className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", qualityStatusClass)}
              >
                {chartSummaryLoading ? "Contrôle" : chartReady ? "Prêt" : "À traiter"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setExportHistoryOpen(true)}
              className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3.5 py-2 text-[12px] font-bold text-indigo-700 transition-all hover:border-indigo-200 hover:bg-indigo-100"
            >
              <History size={13} />
              Historique des exports
            </button>
          </div>

          {hasCabinetQualityNotice ? (
            <div className="mx-6 mt-5 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3.5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100">
                  <AlertTriangle size={14} className="text-amber-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-amber-950">
                    {hasFecQualityBlocker ? "Journal des ventes bloqué" : "Dossier comptable incomplet"}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-5 text-amber-800">
                    {hasFecQualityBlocker
                      ? "Complétez les ventes avant génération. Le dossier de contrôle reste disponible."
                      : missingSectionsSummary}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {periodLock && (
            <div className="mx-6 mt-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3.5">
              <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-[12px] font-bold text-amber-950">Période déjà remise au cabinet</p>
                <p className="text-[12px] text-amber-800 mt-0.5 leading-relaxed">
                  Un export pour cette période est <strong>verrouillé après remise au cabinet</strong>
                  {periodLock?.delivered_to_accountant_at
                    ? ` depuis le ${formatDateFr(periodLock.delivered_to_accountant_at, "—")}`
                    : ""}
                  .
                </p>
              </div>
              <button
                type="button"
                onClick={() => setExportHistoryOpen(true)}
                className="rounded-xl border border-amber-200 bg-white/70 px-3 py-1.5 text-[12px] font-bold text-amber-800 transition-all hover:bg-white"
              >
                Gérer dans l'historique
              </button>
            </div>
          )}

          <div className="px-6 py-5">
            <div className="grid gap-3 lg:grid-cols-[160px_160px_minmax(220px,1fr)_auto_auto] lg:items-end">
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1.5">Début</label>
                <input
                  id="settings-export-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="text-[13px] border border-[#E8EAF0] bg-[#FAFBFE] rounded-xl px-3.5 py-2.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-[#5B5FEE] transition-all w-40"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1.5">Fin</label>
                <input
                  id="settings-export-end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="text-[13px] border border-[#E8EAF0] bg-[#FAFBFE] rounded-xl px-3.5 py-2.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-[#5B5FEE] transition-all w-40"
                />
              </div>
              <div className="flex-1 min-w-[180px] relative">
                <label className="block text-[11px] font-semibold text-gray-500 mb-1.5">Client</label>
                <div className="relative">
                  <input
                    id="settings-export-client"
                    value={customerQuery || selectedCustomerLabel}
                    onFocus={() => setCustomerSearchOpen(true)}
                    onChange={(e) => {
                      setCustomerQuery(e.target.value);
                      setSelectedCustomerId("");
                      setCustomerSearchOpen(true);
                    }}
                    role="combobox"
                    aria-expanded={customerSearchOpen}
                    aria-controls="settings-export-client-listbox"
                    placeholder="Tous les clients"
                    autoComplete="off"
                    className="w-full text-[13px] border border-[#E8EAF0] bg-[#FAFBFE] rounded-xl px-3.5 py-2.5 pr-9 text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-[#5B5FEE] transition-all"
                  />
                  <button
                    type="button"
                    aria-label="Afficher les clients"
                    onClick={() => setCustomerSearchOpen((open) => !open)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>
                {customerSearchOpen ? (
                  <div
                    id="settings-export-client-listbox"
                    role="listbox"
                    className="absolute left-0 right-0 z-[70] mt-2 max-h-72 overflow-y-auto rounded-xl border border-[#E8EAF0] bg-white p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.16)]"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={!selectedCustomerId}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setSelectedCustomerId("");
                        setCustomerQuery("");
                        setCustomerSearchOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] font-semibold",
                        selectedCustomerId ? "text-gray-600 hover:bg-[#FAFBFE]" : "bg-indigo-50 text-[#5B5FEE]",
                      )}
                    >
                      Tous les clients
                      {!selectedCustomerId ? <Check size={13} /> : null}
                    </button>
                    {customerSearchLoading ? (
                      <div className="px-3 py-4 text-center text-[13px] font-semibold text-gray-400">Recherche...</div>
                    ) : filteredCustomers.length ? (
                      filteredCustomers.map((customer) => {
                        const label = customer.name || customer.email || customer.id;
                        return (
                          <button
                            key={customer.id}
                            type="button"
                            role="option"
                            aria-selected={selectedCustomerId === customer.id}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setSelectedCustomerId(customer.id);
                              setCustomerQuery(label);
                              setCustomerSearchOpen(false);
                            }}
                            className={cn(
                              "mt-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] text-gray-600 hover:bg-[#FAFBFE]",
                              selectedCustomerId === customer.id && "bg-indigo-50 text-[#5B5FEE]",
                            )}
                          >
                            <span className="truncate">{label}</span>
                            {selectedCustomerId === customer.id ? <Check size={13} /> : null}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-3 py-4 text-center text-[13px] font-semibold text-gray-400">
                        Aucun client trouvé.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="flex items-center justify-center gap-2 rounded-xl border border-[#E8EAF0] px-4 py-2.5 text-[13px] font-semibold text-gray-600 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={cabinetExportBlocked}
                aria-label={cabinetDownloadLabel}
                title={
                  exportLocked
                    ? "Période déjà remise au cabinet : déverrouillez-la dans l'historique avant de régénérer ce dossier."
                    : hasAccountingFilters
                      ? "ZIP de travail filtré avec la période et le client sélectionnés."
                      : purchasesEnabled || paymentsEnabled
                        ? "ZIP de travail pour le cabinet : ventes et modules Pro inclus dans votre plan, avec les alertes à contrôler."
                        : "ZIP de travail Starter pour le cabinet : clients, factures, lignes de vente et alertes, sans achats ni paiements."
                }
                onClick={() =>
                  void download(
                    withFilters(cabinetDownloadPath, {
                      supportsPeriod: cabinetFormat.supportsPeriod,
                      supportsCustomer: cabinetFormat.supportsCustomer,
                    }),
                    cabinetDownloadLabel,
                  )
                }
              >
                <Database size={13} />
                {exportBusy === cabinetDownloadLabel ? "Préparation" : cabinetDownloadLabel}
              </button>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 text-[13px] font-bold text-white rounded-xl px-5 py-2.5 transition-all shadow-lg",
                  strictExportBlocked
                    ? "opacity-50 cursor-not-allowed bg-gray-400 shadow-none"
                    : "hover:opacity-90 hover:scale-[1.02] active:scale-[0.98] shadow-indigo-200/60",
                )}
                disabled={strictExportBlocked}
                aria-label={fecDownloadLabel}
                title={
                  hasAccountingFilters
                    ? "Journal des ventes au format FEC avec la période et le client sélectionnés."
                    : "Journal des ventes complet au format FEC. Ce n'est pas le FEC fiscal complet de l'exercice."
                }
                onClick={() =>
                  void download(
                    withFilters(fecFormat.path, { supportsPeriod: true, supportsCustomer: true }),
                    fecFormat.label,
                  )
                }
                style={!strictExportBlocked ? { background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" } : {}}
              >
                <FileText size={13} />
                {exportBusy === fecFormat.label ? "Préparation" : fecDownloadLabel}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] leading-5">
              <span className="text-gray-500">{exportScopeNotice}</span>
              <InlineHelpTooltip content="Le dossier pour mon comptable est un ZIP de travail pour le cabinet. Le journal des ventes est un export expert limité aux ventes." />
              {exportBlockReason ? <span className="font-semibold text-amber-700">{exportBlockReason}</span> : null}
            </div>
          </div>
        </div>
      </div>
      {exportHistoryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 py-6">
          <button
            type="button"
            aria-label="Fermer l'historique des exports"
            className="absolute inset-0 cursor-pointer"
            onClick={() => setExportHistoryOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-history-title"
            className="relative z-10 max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-[#E8EAF0] bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#F3F5F9] px-6 py-4">
              <div>
                <p id="export-history-title" className="text-[16px] font-extrabold text-gray-900">
                  Historique des exports
                </p>
                <p className="mt-0.5 text-[12px] text-gray-500">
                  Dossiers pour mon comptable, journal des ventes et validations à contrôler avec le cabinet.
                </p>
              </div>
              <button
                type="button"
                aria-label="Fermer"
                onClick={() => setExportHistoryOpen(false)}
                className="rounded-xl border border-[#E8EAF0] p-2 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>

            <div className="max-h-[64vh] overflow-y-auto px-6 py-3">
              {historyLoading ? (
                <div className="px-6 py-8 text-center text-[13px] font-semibold text-gray-400">
                  Chargement des exports...
                </div>
              ) : exportHistoryRows.length ? (
                <div className="divide-y divide-[#F7F8FC]">
                  {exportHistoryRows.map((entry) => {
                    const delivered = entry.status === "delivered_to_accountant";
                    const cabinetValidationStatus = normalizeCabinetValidationStatus(entry.cabinet_validation_status);
                    const quality = accountingQualitySummary(entry);
                    const hasCabinetCorrection = cabinetValidationStatus === "changes_requested";
                    const rowHasQualityAlert = Boolean(quality);
                    const needsAction = hasCabinetCorrection || rowHasQualityAlert;
                    const period =
                      entry.period_start || entry.period_end
                        ? `${formatDateFr(entry.period_start, "Début libre")} -> ${formatDateFr(entry.period_end, "Fin libre")}`
                        : "Toutes périodes";
                    const note = historyNotes[entry.id] || entry.cabinet_comment || quality?.labels?.join(", ") || "";
                    return (
                      <div key={entry.id} className={cn("py-4", needsAction && "bg-amber-50/20")}>
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-[13px] font-bold text-gray-900">
                                {entry.label || entry.format || "Export journal des ventes"}
                              </p>
                              {delivered ? (
                                <span className="flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
                                  <Lock size={9} /> Verrouillé
                                </span>
                              ) : null}
                              <AccountingStatusBadge entry={entry} quality={quality} />
                            </div>
                            <p className="mt-1 text-[12px] text-gray-500">
                              {period} · {entry.customer_name || "Tous les clients"}
                            </p>
                            {note && needsAction ? (
                              <p className="mt-2 max-w-3xl rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[12px] leading-5 text-amber-900">
                                {note}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                            <p className="text-[11px] text-gray-400">{formatDateFr(entry.created_at, "—")}</p>
                            <div className="flex items-center gap-2">
                              {delivered ? (
                                <button
                                  type="button"
                                  onClick={() => void updateExportStatus(entry, "generated")}
                                  disabled={historyBusy === entry.id || !canOverrideAccountingLock}
                                  title={
                                    !canOverrideAccountingLock
                                      ? "Seul un administrateur peut déverrouiller une période remise au cabinet."
                                      : undefined
                                  }
                                  className="rounded-xl border border-[#E8EAF0] px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-all hover:bg-gray-50 hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Déverrouiller
                                </button>
                              ) : null}
                              {!delivered && !needsAction ? (
                                <button
                                  type="button"
                                  onClick={() => void updateExportStatus(entry, "delivered_to_accountant")}
                                  disabled={historyBusy === entry.id || !canMarkAccountingDelivered}
                                  title={
                                    !canMarkAccountingDelivered
                                      ? "Droit comptable requis pour marquer une période comme remise au cabinet."
                                      : undefined
                                  }
                                  className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 transition-all hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Marquer remis
                                </button>
                              ) : null}
                              {hasCabinetCorrection ? (
                                <button
                                  type="button"
                                  onClick={() => void updateCabinetValidationStatus(entry, "pending_review")}
                                  disabled={historyBusy === entry.id}
                                  className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-1.5 text-[12px] font-bold text-amber-800 transition-all hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Marquer renvoyé
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-[#E8EAF0] bg-[#FAFBFE] px-6 py-10 text-center">
                  <p className="text-[13px] font-semibold text-gray-500">Aucun export suivi.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function SettingsExportPage() {
  return (
    <SettingsShell
      title="Exports ventes & contrôle compta"
      breadcrumb=""
      desc="Journal des ventes, dossier pour mon comptable et historique à valider avec votre cabinet."
    >
      <AccountingExportPanel />
    </SettingsShell>
  );
}

function CsvMigrationPanel({ compact = false }: { compact?: boolean }) {
  const customerInputRef = useRef<HTMLInputElement | null>(null);
  const itemInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (path: string) => {
    setError(null);
    setNotice(null);
    try {
      await downloadProtectedFile(path);
    } catch (err) {
      setError(formatApiError(err, "Téléchargement du fichier CSV impossible."));
    }
  };

  const importCsv = async (kind: "customers" | "items", file: File | undefined) => {
    if (!file) return;
    if (!isCsvFile(file)) {
      setNotice(null);
      setError("Import CSV impossible : sélectionnez un fichier .csv.");
      return;
    }
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const endpoint = kind === "customers" ? "/api/customers/import" : "/api/items/import";
      const result: any = await apiFetch(endpoint, { method: "POST", body });
      const created = Number(result?.created ?? result?.imported ?? 0);
      const updated = Number(result?.updated || 0);
      const skipped = Number(result?.skipped || 0);
      setNotice(
        `${kind === "customers" ? "Clients" : "Articles"} importés: ${created} créés, ${updated} mis à jour, ${skipped} ignorés.`,
      );
    } catch (err) {
      setError(formatApiError(err, `Import ${kind} impossible.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className={`space-y-4 ${compact ? "" : "max-w-3xl"}`}>
      <div className="flex flex-col gap-2 border-b border-[#eef2f7] pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[#0f172a]" style={{ fontSize: compact ? "1rem" : "1.125rem", fontWeight: 800 }}>
            Imports CSV
          </div>
          <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
            Importez vos clients ou votre catalogue, puis récupérez les fichiers au même endroit.
          </p>
        </div>
        <span
          className="inline-flex h-8 items-center rounded-full bg-[#eff6ff] px-3 text-[#1d4ed8]"
          style={{ fontSize: "0.75rem", fontWeight: 800 }}
        >
          CSV uniquement
        </span>
      </div>
      {error && <p className="text-[#dc2626] text-xs">{error}</p>}
      {notice && <p className="text-[#059669] text-xs">{notice}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-[#e2e8f0] bg-[#fbfdff] p-4" id="customers">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#eff6ff]">
              <Upload className="h-4 w-4 text-[#1d4ed8]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[#0f172a] text-[0.9375rem] font-bold">Clients</h3>
              <p className="text-[#64748b]" style={{ fontSize: "0.78rem", lineHeight: 1.45 }}>
                Import ou sauvegarde de la liste clients.
              </p>
            </div>
          </div>
          <input
            ref={customerInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              void importCsv("customers", e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <PrimaryButton
              onClick={() => customerInputRef.current?.click()}
              disabled={busy === "customers"}
              className="min-w-[116px] justify-center"
            >
              <Upload className="w-3.5 h-3.5" /> Importer
            </PrimaryButton>
            <SecondaryButton
              onClick={() => void download("/api/customers/export.csv")}
              className="min-w-[116px] justify-center"
              aria-label="Exporter tous les clients"
              title="Télécharge tous les clients au format CSV."
            >
              <Download className="w-3.5 h-3.5" /> Tous les clients
            </SecondaryButton>
          </div>
        </div>

        <div className="rounded-2xl border border-[#e2e8f0] bg-[#fbfdff] p-4" id="items">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#ecfdf5]">
              <Upload className="h-4 w-4 text-[#059669]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[#0f172a] text-[0.9375rem] font-bold">Articles</h3>
              <p className="text-[#64748b]" style={{ fontSize: "0.78rem", lineHeight: 1.45 }}>
                Import ou sauvegarde du catalogue.
              </p>
            </div>
          </div>
          <input
            ref={itemInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              void importCsv("items", e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <PrimaryButton
              onClick={() => itemInputRef.current?.click()}
              disabled={busy === "items"}
              className="min-w-[116px] justify-center"
            >
              <Upload className="w-3.5 h-3.5" /> Importer
            </PrimaryButton>
            <SecondaryButton
              onClick={() => void download("/api/items/export.csv")}
              className="min-w-[116px] justify-center"
              aria-label="Exporter tous les articles"
              title="Télécharge tout le catalogue d'articles au format CSV."
            >
              <Download className="w-3.5 h-3.5" /> Tous les articles
            </SecondaryButton>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function SettingsMigrationPage() {
  return (
    <SettingsShell
      title="Imports CSV"
      breadcrumb="Paramètres · Imports CSV"
      desc="Les imports sont rangés dans Clients et Produits & services pour rester proches des données concernées."
    >
      <CsvMigrationPanel />
    </SettingsShell>
  );
}

const settingsInputCls =
  "w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
const settingsTextareaCls = `${settingsInputCls} resize-y min-h-[112px]`;
const settingsCheckboxCls = "rounded border-[#cbd5e1] text-[#1d4ed8] focus:ring-[#1d4ed8]";
const WEBHOOK_EVENT_OPTIONS = [
  { value: "invoice.einvoicing.accepted", label: "Acceptation e-facture" },
  { value: "invoice.einvoicing.refused", label: "Refus e-facture" },
  { value: "invoice.einvoicing.rejected", label: "Rejet e-facture" },
];

const extractSettingsMessage = (payload: any, fallback: string) => {
  return extractUserFacingApiMessage(payload, undefined, fallback);
};

async function ensureSettingsOk(res: Response, fallback: string) {
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(extractUserFacingApiMessage(payload, res.status, fallback));
  }
  return payload;
}

const formatSettingsDate = (value?: string | null) => {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(parsed);
};

const formatSettingsDateTime = (value?: string | null) => {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
};

const formatSettingsBytes = (value?: number | null) => {
  const safe = Number(value || 0);
  if (!Number.isFinite(safe) || safe <= 0) return "0 o";
  if (safe < 1024) return `${safe} o`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} Ko`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} Go`;
};

const formatSettingsPercent = (value?: number | null) => {
  const safe = Number(value || 0);
  if (!Number.isFinite(safe)) return "0 %";
  return `${Math.max(0, Math.min(100, safe)).toFixed(1).replace(".0", "")} %`;
};

const prettifySettingsStatus = (value?: string | null) => {
  const raw = (value || "").trim();
  if (!raw) return "—";
  const normalized = raw.toLowerCase();
  const labels: Record<string, string> = {
    active: "Actif",
    connected: "Connecté",
    pending: "En attente",
    disabled: "Désactivé",
    failed: "Échec",
    error: "Erreur",
    ok: "OK",
    never: "Jamais",
    draft: "Brouillon",
    generated: "Généré",
    sent: "Envoyé",
    accepted: "Accepté",
    acknowledged: "Acquitté",
    rejected: "Rejeté",
    processing: "En cours",
    available: "Disponible",
    subscribed: "Abonné",
    trialing: "Essai",
  };
  return labels[normalized] || raw.replace(/_/g, " ");
};

const settingsToneFromStatus = (value?: string | null) => {
  const normalized = (value || "").trim().toLowerCase();
  if (["active", "connected", "accepted", "acknowledged", "ok", "generated", "sent", "available"].includes(normalized))
    return "ok";
  if (["pending", "processing", "trialing", "never", "draft"].includes(normalized)) return "warn";
  if (["failed", "error", "rejected", "refused", "inactive", "disabled"].includes(normalized))
    return normalized === "disabled" ? "muted" : "danger";
  return "muted";
};

const isOperationalPlatformConnector = (
  slug: string | null | undefined,
  seqinoOperational: boolean,
  chorusOperational: boolean,
) => {
  const normalized = normalizeStatus(slug);
  if (normalized === "seqino") return seqinoOperational;
  if (["chorus", "choruspro", "chorus_pro"].includes(normalized)) return chorusOperational;
  return false;
};

const settingsPlatformLabel = (slug?: string | null) => {
  const normalized = normalizeStatus(slug);
  if (normalized === "seqino") return "Seqino";
  if (["chorus", "choruspro", "chorus_pro"].includes(normalized)) return "Chorus Pro";
  return normalized ? normalized.replace(/_/g, " ") : "Plateforme";
};

function SettingsCheckboxRow({ checked, onChange, label, hint, disabled = false }: any) {
  return (
    <label
      className={`flex items-start gap-3 rounded-xl border border-[#e2e8f0] p-3.5 transition-colors ${disabled ? "opacity-60" : "hover:border-[#cbd5e1]"}`}
    >
      <input
        type="checkbox"
        className={settingsCheckboxCls}
        checked={!!checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <div>
        <div className="text-[#0f172a] text-sm font-semibold">{label}</div>
        {hint ? <p className="text-[#64748b] mt-0.5 text-xs leading-relaxed">{hint}</p> : null}
      </div>
    </label>
  );
}

export function SettingsPlatformsPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [connections, setConnections] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [mandates, setMandates] = useState<any[]>([]);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const [planRestricted, setPlanRestricted] = useState(false);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);
  const chorusOperational = einvoicingEnabled && Boolean(capabilities?.chorus_operational);
  const platformOperational = seqinoOperational || chorusOperational;

  const load = useCallback(async () => {
    if (!einvoicingEnabled || !platformOperational) {
      setLoading(false);
      setError(null);
      setOnboarding(null);
      setConnections([]);
      setConnectors([]);
      setMandates([]);
      setPlanRestricted(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [onboardingRes, connectionsRes, connectorsRes, mandatesRes] = await Promise.allSettled([
        seqinoOperational ? rawApi("/api/platforms/onboarding-status") : Promise.resolve(null),
        rawApi("/api/platforms/connections"),
        rawApi("/api/platforms/connectors"),
        seqinoOperational ? rawApi("/api/platforms/seqino/mandates") : Promise.resolve(null),
      ]);

      let restricted = false;
      let onboardingPayload: any = null;
      let connectionsPayload: any[] = [];
      let connectorsPayload: any[] = [];
      let mandatesPayload: any[] = [];

      if (onboardingRes.status === "fulfilled" && onboardingRes.value?.ok) {
        onboardingPayload = await onboardingRes.value.json().catch(() => null);
      }
      if (connectionsRes.status === "fulfilled") {
        if (connectionsRes.value.ok) {
          const payload = await connectionsRes.value.json().catch(() => []);
          connectionsPayload = (Array.isArray(payload) ? payload : []).filter((item) =>
            isOperationalPlatformConnector(item?.provider_slug, seqinoOperational, chorusOperational),
          );
        } else if ([401, 403, 402].includes(connectionsRes.value.status)) {
          restricted = true;
        }
      }
      if (connectorsRes.status === "fulfilled") {
        if (connectorsRes.value.ok) {
          const payload = await connectorsRes.value.json().catch(() => null);
          connectorsPayload = (Array.isArray(payload?.connectors) ? payload.connectors : []).filter((item: any) =>
            isOperationalPlatformConnector(item?.slug, seqinoOperational, chorusOperational),
          );
        } else if ([401, 403, 402].includes(connectorsRes.value.status)) {
          restricted = true;
        }
      }
      if (mandatesRes.status === "fulfilled" && mandatesRes.value) {
        if (mandatesRes.value.ok) {
          mandatesPayload = await mandatesRes.value.json().catch(() => []);
        } else if ([401, 403, 402].includes(mandatesRes.value.status)) {
          restricted = true;
        }
      }

      setOnboarding(onboardingPayload || null);
      setConnections(Array.isArray(connectionsPayload) ? connectionsPayload : []);
      setConnectors(Array.isArray(connectorsPayload) ? connectorsPayload : []);
      setMandates(Array.isArray(mandatesPayload) ? mandatesPayload : []);
      setPlanRestricted(restricted);
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger les connexions plateformes."));
    } finally {
      setLoading(false);
    }
  }, [chorusOperational, einvoicingEnabled, platformOperational, seqinoOperational]);

  useEffect(() => {
    if (sessionLoading) return;
    void load();
  }, [load, sessionLoading]);

  const activeMandates = Number(
    onboarding?.mandate?.active_count ??
      mandates.filter((item) => normalizeStatus(item?.status) === "active").length ??
      0,
  );
  const chorusConnection = connections.find((item) =>
    ["chorus", "choruspro"].includes(normalizeStatus(item?.provider_slug)),
  );
  const chorusTenantConnected = normalizeStatus(chorusConnection?.status) === "connected";
  const chorusServerAvailable = chorusOperational;
  const chorusActive = chorusServerAvailable && chorusTenantConnected;
  const seqinoConnection = connections.find((item) => normalizeStatus(item?.provider_slug) === "seqino");
  const pdpOperational =
    seqinoOperational && normalizeStatus(seqinoConnection?.status) === "connected" && activeMandates > 0;
  const onboardingErrors = Array.isArray(onboarding?.errors) ? onboarding.errors : [];
  const exchangeDate = onboarding?.exchanges?.last_success || onboarding?.exchanges?.last_error || null;
  const operationalPlatformsReady = (!seqinoOperational || pdpOperational) && (!chorusOperational || chorusActive);

  const testConnection = async (slug: string) => {
    if (!isOperationalPlatformConnector(slug, seqinoOperational, chorusOperational)) return;
    setTestingSlug(slug);
    setError(null);
    setNotice(null);
    try {
      const res = await rawApi(`/api/platforms/test-connection?connector=${encodeURIComponent(slug)}`);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Test de connexion impossible."));
      }
      setNotice(extractSettingsMessage(payload?.message, `Connexion ${slug} validée.`));
      await load();
    } catch (err) {
      setError(formatApiError(err, "Test de connexion impossible."));
    } finally {
      setTestingSlug(null);
    }
  };

  return (
    <SettingsShell
      title="Plateformes"
      breadcrumb="Paramètres · Plateformes"
      desc="Vue d’ensemble des connecteurs e-facturation réellement activés pour votre espace."
    >
      <div className="space-y-4">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "Plateformes réservées au plan Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Starter reste limité aux clients, devis et factures classiques. Les connexions Seqino et Chorus sont réservées au plan Pro, sous réserve d’un contrat, d’un mandat et d’une configuration opérationnelle."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        <SeqinoTokenNotice enabled={Boolean(seqinoOperational && capabilities?.token_topup_enabled)} />
        {platformOperational && error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {platformOperational && notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {einvoicingEnabled && platformOperational && planRestricted ? (
          <NoticeBanner tone="warning">
            Certaines actions avancées (connexions détaillées, mandats, tests) sont réservées au plan Pro. Le tableau
            ci-dessous reste utile pour piloter la préparation et voir les points bloquants.
          </NoticeBanner>
        ) : null}
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : !platformOperational ? (
          <NoticeBanner tone="info" title="Mode export actif">
            Les connexions Seqino et Chorus ne sont pas activées sur cette instance. Aucun statut, mandat, catalogue ou
            test connecté n’est chargé depuis cette page. Vous pouvez continuer à utiliser les
            <Link to="/app/settings/export" className="ml-1 underline font-medium">
              exports
            </Link>{" "}
            et consulter l’
            <Link to="/app/einvoicing" className="underline font-medium">
              historique des transmissions
            </Link>
            .
          </NoticeBanner>
        ) : loading ? (
          <LoadingCard label="Chargement des intégrations…" />
        ) : (
          <>
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
              {chorusOperational ? (
                <StatCard
                  label="Chorus / canal public"
                  value={chorusActive ? "Connecté" : "Non configuré"}
                  sub={chorusActive ? "Connexion de cet espace confirmée" : "Connexion espace non confirmée"}
                  accent={chorusActive ? "green" : "amber"}
                  icon={<Globe className="w-4 h-4" />}
                />
              ) : null}
              {seqinoOperational ? (
                <>
                  <StatCard
                    label="Seqino"
                    value={pdpOperational ? "Connectée" : "À vérifier"}
                    sub={pdpOperational ? `${activeMandates} mandat actif(s)` : "Connexion ou mandat à finaliser"}
                    accent={pdpOperational ? "green" : "amber"}
                    icon={<Check className="w-4 h-4" />}
                  />
                  <StatCard
                    label="Synchro Seqino"
                    value={prettifySettingsStatus(onboarding?.directory?.status)}
                    sub={
                      onboarding?.directory?.last_sync
                        ? `Dernière synchro ${formatSettingsDateTime(onboarding.directory.last_sync)}`
                        : "Aucune synchronisation encore"
                    }
                    accent={
                      settingsToneFromStatus(onboarding?.directory?.status) === "ok"
                        ? "green"
                        : settingsToneFromStatus(onboarding?.directory?.status) === "danger"
                          ? "red"
                          : "amber"
                    }
                    icon={<Database className="w-4 h-4" />}
                  />
                  <StatCard
                    label="Dernier échange Seqino"
                    value={exchangeDate ? formatSettingsDate(exchangeDate) : "Aucun"}
                    sub={
                      (onboarding?.exchanges?.error_summary
                        ? sanitizeUserFacingApiMessage(
                            onboarding.exchanges.error_summary,
                            400,
                            "Le dernier échange n'a pas abouti.",
                          )
                        : null) ||
                      (onboarding?.exchanges?.last_success ? "Dernier échange réussi" : "Pas encore d’échange")
                    }
                    accent={
                      onboarding?.exchanges?.last_success ? "green" : onboarding?.exchanges?.last_error ? "red" : "cyan"
                    }
                    icon={<Globe className="w-4 h-4" />}
                  />
                </>
              ) : null}
            </div>

            {!chorusActive && chorusServerAvailable ? (
              <NoticeBanner tone="warning">
                Chorus Pro n’est pas encore activé pour cet espace. Aucun envoi vers le secteur public ne doit être
                lancé avant confirmation de l’activation. Contactez le support pour finaliser cette étape.
              </NoticeBanner>
            ) : null}

            {seqinoOperational && onboardingErrors.length ? (
              <NoticeBanner tone="warning">
                <div className="space-y-1">
                  <div className="font-medium">Étapes à terminer avant l’activation :</div>
                  <ul className="list-disc ml-4 space-y-1">
                    {onboardingErrors.map((item: any) => (
                      <li key={item.code || item.message}>
                        <strong>
                          {sanitizeUserFacingApiMessage(
                            item.message,
                            400,
                            "Une étape de préparation reste à terminer.",
                          )}
                        </strong>
                        {item.hint ? (
                          <span>
                            {" — "}
                            {sanitizeUserFacingApiMessage(item.hint, 400, "Consultez l'étape correspondante.")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </NoticeBanner>
            ) : operationalPlatformsReady ? (
              <NoticeBanner tone="success">
                Les connexions activées sont prêtes. Utilisez cette page pour vérifier leur état, puis{" "}
                <Link to="/app/einvoicing" className="underline font-medium">
                  ouvrez les transmissions
                </Link>{" "}
                uniquement pour le suivi opérationnel.
              </NoticeBanner>
            ) : null}

            <div className="grid xl:grid-cols-[1.35fr,0.65fr] gap-4">
              <div className="space-y-4">
                <Card>
                  <SectionTitle
                    action={
                      <SecondaryButton onClick={() => void load()}>
                        <RefreshCw className="w-3.5 h-3.5" />
                        Rafraîchir
                      </SecondaryButton>
                    }
                  >
                    Connexions enregistrées
                  </SectionTitle>
                  {connections.length ? (
                    <DataTable headers={["Plateforme", "Statut", "Mise à jour", "Action"]}>
                      {connections.map((item) => (
                        <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                          <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                            {settingsPlatformLabel(item.provider_slug)}
                          </td>
                          <td className="px-4 py-3">
                            <StatusPill
                              status={settingsToneFromStatus(item.status)}
                              label={prettifySettingsStatus(item.status)}
                            />
                          </td>
                          <td className="px-4 py-3 text-[#64748b] text-sm">
                            {formatSettingsDateTime(item.updated_at)}
                          </td>
                          <td className="px-4 py-3">
                            <SecondaryButton
                              className="!px-2.5 !py-1.5 !text-xs"
                              onClick={() => void testConnection(item.provider_slug)}
                              disabled={testingSlug === item.provider_slug}
                            >
                              {testingSlug === item.provider_slug ? "Test…" : "Tester"}
                            </SecondaryButton>
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <EmptyCard
                      title="Aucune connexion enregistrée"
                      description={
                        seqinoOperational
                          ? "La connexion Seqino nécessite un dossier entreprise complet, un contrat et un mandat valides."
                          : "La connexion Chorus nécessite un compte technique et un routage valides pour cet espace."
                      }
                      action={
                        <Link
                          to="/app/settings/company"
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#eff6ff] text-[#1d4ed8] hover:bg-[#dbeafe] text-sm font-semibold"
                        >
                          Vérifier l’entreprise <ExternalLink className="w-3.5 h-3.5" />
                        </Link>
                      }
                    />
                  )}
                </Card>

                {seqinoOperational ? (
                  <Card>
                    <SectionTitle>Mandats Seqino</SectionTitle>
                    {mandates.length ? (
                      <DataTable headers={["Société", "SIREN / SIRET", "Statut", "Début", "Maj"]}>
                        {mandates.map((item) => (
                          <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                            <td className="px-4 py-3 text-[#0f172a] text-sm font-medium">{item.name || "Mandat"}</td>
                            <td className="px-4 py-3 text-[#374151] font-mono text-sm">
                              {item.siret || item.siren || "—"}
                            </td>
                            <td className="px-4 py-3">
                              <StatusPill
                                status={settingsToneFromStatus(item.status)}
                                label={prettifySettingsStatus(item.status)}
                              />
                            </td>
                            <td className="px-4 py-3 text-[#64748b] text-sm">{formatSettingsDate(item.start_date)}</td>
                            <td className="px-4 py-3 text-[#64748b] text-sm">
                              {formatSettingsDateTime(item.updated_at)}
                            </td>
                          </tr>
                        ))}
                      </DataTable>
                    ) : (
                      <EmptyCard
                        title="Aucun mandat Seqino chargé"
                        description="La connexion ne sera opérationnelle qu’après validation du contrat, du mandat et de la configuration de cet espace."
                      />
                    )}
                  </Card>
                ) : null}
              </div>

              <div className="space-y-4">
                <Card>
                  <SectionTitle>Connecteurs disponibles</SectionTitle>
                  <div className="space-y-2">
                    {connectors.length ? (
                      connectors.map((item: any) => (
                        <div
                          key={item.slug || item.label}
                          className="flex items-start justify-between gap-3 rounded-xl border border-[#e2e8f0] p-3.5"
                        >
                          <div>
                            <div className="text-[#0f172a] text-sm font-semibold">
                              {item.label || item.slug || "Connecteur"}
                            </div>
                            <div className="text-[#64748b] mt-0.5 text-xs leading-relaxed">
                              {item.slug || "Slug non renseigné"}
                            </div>
                          </div>
                          <StatusPill
                            status={
                              connections.some(
                                (row) => normalizeStatus(row.provider_slug) === normalizeStatus(item.slug),
                              )
                                ? "ok"
                                : "muted"
                            }
                            label={
                              connections.some(
                                (row) => normalizeStatus(row.provider_slug) === normalizeStatus(item.slug),
                              )
                                ? "Configuré"
                                : "Disponible"
                            }
                          />
                        </div>
                      ))
                    ) : (
                      <p className="text-[#64748b] text-sm">Aucun catalogue connecté chargé.</p>
                    )}
                  </div>
                </Card>
                <Card>
                  <SectionTitle>Chemin recommandé</SectionTitle>
                  <ol className="space-y-2.5 text-[#374151]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                    <li>
                      1. Vérifier la complétude entreprise dans{" "}
                      <Link to="/app/settings/company" className="text-[#1d4ed8] font-medium">
                        Entreprise
                      </Link>
                      .
                    </li>
                    {seqinoOperational ? (
                      <li>2. Vérifier le contrat, le mandat et la connexion Seqino de cet espace.</li>
                    ) : (
                      <li>2. Vérifier le compte technique et le routage Chorus de cet espace.</li>
                    )}
                    <li>
                      3. Suivre les retours réels dans{" "}
                      <Link to="/app/einvoicing" className="text-[#1d4ed8] font-medium">
                        Transmissions
                      </Link>
                      .
                    </li>
                  </ol>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </SettingsShell>
  );
}

export function SettingsAttachmentsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [usageRes, recentRes] = await Promise.all([
        rawApi("/api/attachments/usage"),
        rawApi("/api/attachments/recent?limit=50"),
      ]);
      const usagePayload = await ensureSettingsOk(usageRes, "Impossible de charger la capacité de stockage.");
      const recentPayload = await ensureSettingsOk(recentRes, "Impossible de charger les pièces jointes.");
      setUsage(usagePayload || null);
      setRecent(Array.isArray(recentPayload) ? recentPayload : []);
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger les pièces jointes."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const deleteAttachment = async (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Supprimer cette pièce jointe de l’espace ?")) return;
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res?.ok) {
        throw new Error(res?.message || "Suppression impossible.");
      }
      setNotice("Pièce jointe supprimée.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setDeletingId(null);
    }
  };

  const usagePercent = useMemo(() => {
    const quota = Number(usage?.quota_bytes || 0);
    const used = Number(usage?.used_bytes || 0);
    if (!quota) return 0;
    return Math.min(100, Math.max(0, (used / quota) * 100));
  }, [usage]);
  const customQuota = Number(usage?.quota_bytes || 0) <= 0;
  const quotaLabel = customQuota ? "Sur mesure" : formatSettingsBytes(usage?.quota_bytes);

  return (
    <SettingsShell
      title="Pièces jointes"
      breadcrumb="Paramètres · Pièces jointes"
      desc="Capacité de stockage, formats autorisés et derniers fichiers rattachés aux documents."
    >
      <div className="space-y-4">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {loading ? (
          <LoadingCard label="Chargement du stockage…" />
        ) : (
          <>
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
              <StatCard
                label="Utilisé"
                value={formatSettingsBytes(usage?.used_bytes)}
                sub={`sur ${quotaLabel}`}
                accent="blue"
                icon={<Paperclip className="w-4 h-4" />}
              />
              <StatCard
                label="Fichier max"
                value={formatSettingsBytes(usage?.max_file_bytes)}
                sub="par import"
                accent="green"
                icon={<Upload className="w-4 h-4" />}
              />
              <StatCard
                label="Pièces / doc"
                value={usage?.max_per_document || 0}
                sub="maximum"
                accent="amber"
                icon={<Layout className="w-4 h-4" />}
              />
              <StatCard
                label="Plan"
                value={(usage?.plan || "starter").toUpperCase()}
                sub={`${recent.length} fichier(s) récent(s)`}
                accent="purple"
                icon={<Database className="w-4 h-4" />}
              />
            </div>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[#0f172a] text-[0.9375rem] font-semibold">Capacité actuelle</div>
                  <p className="text-[#64748b] mt-0.5 text-sm">Les limites affichées correspondent au plan actif.</p>
                </div>
                <StatusPill
                  status={customQuota ? "info" : usagePercent > 85 ? "danger" : usagePercent > 60 ? "warn" : "ok"}
                  label={customQuota ? "Sur mesure" : formatSettingsPercent(usagePercent)}
                />
              </div>
              <div className="h-2.5 rounded-full bg-[#e2e8f0] overflow-hidden">
                <div
                  className={`h-full ${usagePercent > 85 ? "bg-[#ef4444]" : usagePercent > 60 ? "bg-[#f59e0b]" : "bg-[#1d4ed8]"}`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {(usage?.allowed_content_types || []).map((item: string) => (
                  <span
                    key={item}
                    className="px-2.5 py-1 rounded-full border border-[#e2e8f0] bg-[#f8fafc] text-[#64748b]"
                    style={{ fontSize: "0.6875rem", fontWeight: 600 }}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </Card>

            {recent.length ? (
              <DataTable headers={["Document", "Fichier", "Type", "Taille", "Visibilité", "Ajout", "Action"]}>
                {recent.map((item) => {
                  const href = item.invoice_id
                    ? `/app/invoices/${item.invoice_id}`
                    : item.quote_id
                      ? `/app/quotes/${item.quote_id}`
                      : null;
                  const docLabel = item.invoice_id ? "Facture" : item.quote_id ? "Devis" : "Document";
                  return (
                    <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                      <td className="px-4 py-3">
                        {href ? (
                          <Link to={href} className="text-[#1d4ed8] text-sm font-semibold">
                            {docLabel}
                          </Link>
                        ) : (
                          <span className="text-[#0f172a] text-sm font-semibold">{docLabel}</span>
                        )}
                        <div className="text-[#94a3b8] text-xs">
                          {item.invoice_id || item.quote_id || item.id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[#374151] text-sm">{item.filename || item.label || "Fichier"}</div>
                        {item.label ? <div className="text-[#94a3b8] text-xs">{item.label}</div> : null}
                      </td>
                      <td className="px-4 py-3 text-[#64748b] text-sm">{item.content_type || "—"}</td>
                      <td className="px-4 py-3 text-[#64748b] text-sm">{formatSettingsBytes(item.size_bytes)}</td>
                      <td className="px-4 py-3">
                        <StatusPill
                          status={item.public_visible ? "ok" : "muted"}
                          label={item.public_visible ? "Visible" : "Privé"}
                        />
                      </td>
                      <td className="px-4 py-3 text-[#64748b] text-sm">{formatSettingsDateTime(item.created_at)}</td>
                      <td className="px-4 py-3">
                        <DangerButton
                          className="!px-2.5 !py-1.5 !text-xs"
                          onClick={() => void deleteAttachment(item.id)}
                          disabled={deletingId === item.id}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {deletingId === item.id ? "Suppression…" : "Supprimer"}
                        </DangerButton>
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            ) : (
              <EmptyCard
                title="Aucune pièce jointe récente"
                description="Les pièces jointes ajoutées aux devis et factures apparaîtront ici. Elles restent liées à leur document et à sa visibilité client."
              />
            )}
          </>
        )}
      </div>
    </SettingsShell>
  );
}

export function SettingsPortalsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [draft, setDraft] = useState<any>({
    theme: "blue",
    cardPayments: false,
    showCreditNotes: false,
    quoteConvertMode: "disabled",
    supportEmail: "",
    footerNote: "",
    acceptanceMode: "simple",
    termsUrl: "",
    termsRequired: false,
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, companyRes] = await Promise.all([
        rawApi("/api/settings/tenant"),
        rawApi("/api/company/profile"),
      ]);
      const settingsPayload = await ensureSettingsOk(settingsRes, "Impossible de charger les paramètres portail.");
      const companyPayload = await ensureSettingsOk(companyRes, "Impossible de charger les paramètres entreprise.");
      const portal = settingsPayload?.features?.portal || {};
      setSettings(settingsPayload || null);
      setCompany(companyPayload || null);
      setDraft({
        theme: portal.theme || "blue",
        cardPayments: false,
        showCreditNotes: !!portal.show_credit_notes,
        quoteConvertMode: portal.quote_convert_mode || "disabled",
        supportEmail: portal.support_email || companyPayload?.email_reply_to || "",
        footerNote: portal.footer_note || "",
        acceptanceMode: companyPayload?.quote_acceptance_mode || "simple",
        termsUrl: companyPayload?.quote_terms_url || "",
        termsRequired: !!companyPayload?.quote_terms_required,
      });
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger les portails."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const portalPayload = {
        ...(settings?.features?.portal || {}),
        theme: draft.theme,
        card_payments: false,
        show_credit_notes: !!draft.showCreditNotes,
        quote_convert_mode: draft.quoteConvertMode,
        support_email: (draft.supportEmail || "").trim() || null,
        footer_note: (draft.footerNote || "").trim() || null,
      };

      await Promise.all([
        apiFetch("/api/settings/tenant", {
          method: "PATCH",
          body: JSON.stringify({ features: { portal: portalPayload } }),
        }),
        apiFetch("/api/company/profile", {
          method: "PATCH",
          body: JSON.stringify({
            quote_acceptance_mode: draft.acceptanceMode,
            quote_terms_url: (draft.termsUrl || "").trim() || null,
            quote_terms_required: !!draft.termsRequired,
          }),
        }),
      ]);
      setNotice("Configuration des portails enregistrée.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsShell
      title="Portails"
      breadcrumb="Paramètres · Portails"
      desc="Paramètres du portail client et du portail devis pour rendre le parcours plus clair côté client."
    >
      <div className="space-y-4">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {loading ? (
          <LoadingCard label="Chargement des portails…" />
        ) : (
          <div className="grid xl:grid-cols-[1fr,0.42fr] gap-4">
            <Card className="space-y-5">
              <SectionTitle>Portail client</SectionTitle>
              <div className="grid md:grid-cols-2 gap-4">
                <SelectField
                  label="Thème"
                  value={draft.theme}
                  onChange={(event) => setDraft((prev: any) => ({ ...prev, theme: event.target.value }))}
                >
                  {[
                    ["blue", "Bleu"],
                    ["indigo", "Indigo"],
                    ["emerald", "Émeraude"],
                    ["orange", "Orange"],
                    ["rose", "Rose"],
                    ["slate", "Slate"],
                    ["violet", "Violet"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Conversion devis → facture"
                  value={draft.quoteConvertMode}
                  onChange={(event) => setDraft((prev: any) => ({ ...prev, quoteConvertMode: event.target.value }))}
                >
                  <option value="disabled">Désactiver</option>
                  <option value="create_draft">Demander un brouillon à valider</option>
                </SelectField>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <InputField
                  label="Email support affiché"
                  value={draft.supportEmail}
                  onChange={(event) => setDraft((prev: any) => ({ ...prev, supportEmail: event.target.value }))}
                  placeholder="support@votre-domaine.fr"
                />
                <InputField
                  label="URL CGV / conditions"
                  value={draft.termsUrl}
                  onChange={(event) => setDraft((prev: any) => ({ ...prev, termsUrl: event.target.value }))}
                  placeholder="https://…"
                />
              </div>
              <div>
                <label className="block text-[#374151] mb-1.5 text-sm font-medium">Note de pied de page</label>
                <textarea
                  className={settingsTextareaCls}
                  value={draft.footerNote}
                  onChange={(event) => setDraft((prev: any) => ({ ...prev, footerNote: event.target.value }))}
                  placeholder="Support, délai de paiement, informations utiles…"
                />
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <SettingsCheckboxRow
                  checked={draft.showCreditNotes}
                  onChange={(value: boolean) => setDraft((prev: any) => ({ ...prev, showCreditNotes: value }))}
                  label="Afficher les avoirs"
                  hint="Montre les notes de crédit aux clients sur le portail."
                />
                <SettingsCheckboxRow
                  checked={draft.termsRequired}
                  onChange={(value: boolean) => setDraft((prev: any) => ({ ...prev, termsRequired: value }))}
                  label="Accepter les conditions pour signer le devis"
                  hint="Ajoutez une validation explicite côté portail devis."
                />
                <div className="rounded-xl border border-[#e2e8f0] p-3.5">
                  <label className="block text-[#374151] mb-1.5 text-sm font-medium">Mode d’acceptation devis</label>
                  <select
                    className={[settingsInputCls, "text-sm"].filter(Boolean).join(" ")}
                    value={draft.acceptanceMode}
                    onChange={(event) => setDraft((prev: any) => ({ ...prev, acceptanceMode: event.target.value }))}
                  >
                    <option value="simple">Simple</option>
                    <option value="otp">OTP</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <PrimaryButton onClick={() => void save()} disabled={saving}>
                  {saving ? "Enregistrement…" : "Enregistrer les portails"}
                </PrimaryButton>
                <Link
                  to="/app/quotes"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#e2e8f0] text-[#374151] hover:bg-[#f8fafc] text-sm font-medium"
                >
                  Ouvrir les devis <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </Card>
            <div className="space-y-4">
              <Card>
                <SectionTitle>Résumé visible</SectionTitle>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748b] text-sm">Thème</span>
                    <StatusPill status="info" label={draft.theme} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748b] text-sm">Conversion devis</span>
                    <StatusPill
                      status={draft.quoteConvertMode === "disabled" ? "muted" : "ok"}
                      label={prettifySettingsStatus(draft.quoteConvertMode)}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748b] text-sm">Avoirs</span>
                    <StatusPill
                      status={draft.showCreditNotes ? "ok" : "muted"}
                      label={draft.showCreditNotes ? "Affichés" : "Masqués"}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748b] text-sm">Acceptation devis</span>
                    <StatusPill
                      status={draft.acceptanceMode === "otp" ? "warn" : "ok"}
                      label={draft.acceptanceMode === "otp" ? "OTP" : "Simple"}
                    />
                  </div>
                </div>
              </Card>
              <NoticeBanner tone="info">
                Cette page regroupe désormais les réglages utiles au client final. L’objectif est d’éviter qu’un
                commercial passe de plusieurs écrans “techniques” à des réglages invisibles côté client.
              </NoticeBanner>
            </div>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

function parseDunningScheduleDaysInput(value: string) {
  const seen = new Set<number>();
  return String(value || "")
    .split(/[,\s;]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= -30 && part <= 120)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}

export function SettingsDunningPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const paymentsGate = resolveProFeatureGate(capabilities, "payments");
  const paymentsEnabled = paymentsGate.enabled;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<any>({
    reminderBody: "",
    replyTo: "",
    automaticEnabled: true,
    scheduleDays: "-2, 3, 10",
    minIntervalHours: "24",
    attachPdf: true,
    latePaymentInterest: "",
    recoveryFee: "40",
    discountTerms: "",
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileRes, settingsRes] = await Promise.all([
        rawApi("/api/company/profile"),
        rawApi("/api/settings/tenant"),
      ]);
      const payload = await ensureSettingsOk(profileRes, "Impossible de charger les modèles de relance.");
      const settingsPayload = settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
      const dunning = settingsPayload?.features?.dunning || {};
      const scheduleDays = Array.isArray(dunning.schedule_days) ? dunning.schedule_days : [-2, 3, 10];
      setForm({
        reminderBody: payload?.reminder_body_default || "",
        replyTo: payload?.email_reply_to || "",
        automaticEnabled: dunning.enabled !== false,
        scheduleDays: scheduleDays.join(", "),
        minIntervalHours: dunning.min_interval_hours != null ? String(dunning.min_interval_hours) : "24",
        attachPdf: dunning.attach_pdf !== false,
        latePaymentInterest: payload?.late_payment_interest || "",
        recoveryFee: payload?.recovery_fee_eur != null ? String(payload.recovery_fee_eur) : "40",
        discountTerms: payload?.discount_terms || "",
      });
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger les relances."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!paymentsEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [paymentsEnabled, sessionLoading]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const scheduleDays = parseDunningScheduleDaysInput(form.scheduleDays);
      if (!scheduleDays.length) {
        throw new Error("Ajoutez au moins une période de relance, par exemple -2, 3, 10.");
      }
      const minIntervalHours = Math.max(1, Math.min(720, Number(form.minIntervalHours || 24)));
      await Promise.all([
        apiFetch("/api/company/profile", {
          method: "PATCH",
          body: JSON.stringify({
            reminder_body_default: (form.reminderBody || "").trim() || null,
            email_reply_to: (form.replyTo || "").trim() || null,
            late_payment_interest: (form.latePaymentInterest || "").trim() || null,
            recovery_fee_eur: form.recoveryFee === "" ? null : Number(form.recoveryFee),
            discount_terms: (form.discountTerms || "").trim() || null,
          }),
        }),
        apiFetch("/api/settings/tenant", {
          method: "PATCH",
          body: JSON.stringify({
            features: {
              dunning: {
                enabled: Boolean(form.automaticEnabled),
                schedule_days: scheduleDays,
                min_interval_hours: minIntervalHours,
                attach_pdf: Boolean(form.attachPdf),
              },
            },
          }),
        }),
      ]);
      setNotice("Relances enregistrées.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsShell
      title="Relance facture"
      breadcrumb="Factures · Relance facture"
      desc="Modèle email et mentions appliqués aux relances de factures."
      backHref="/app/invoices?status=overdue"
    >
      <div className="space-y-4">
        {!sessionLoading && !paymentsEnabled ? (
          <UpgradeNoticeCard
            title={paymentsGate.reactivationRequired ? paymentsGate.statusLabel : "Relances réservées au plan Pro"}
            description={
              paymentsGate.reactivationDescription ||
              "Starter reste limité aux clients, devis et factures classiques. Passez à Pro pour suivre les règlements et configurer les relances."
            }
            ctaLabel={paymentsGate.ctaLabel}
            ctaHref={paymentsGate.ctaHref}
            note={paymentsGate.reactivationNote || undefined}
          />
        ) : null}
        {paymentsEnabled && error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {paymentsEnabled && notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !paymentsEnabled ? null : loading ? (
          <LoadingCard label="Chargement des relances…" />
        ) : (
          <div className="grid xl:grid-cols-[1fr,0.42fr] gap-4">
            <Card className="space-y-5">
              <SectionTitle>Modèle de relance facture</SectionTitle>
              <InputField
                label="Adresse de réponse"
                value={form.replyTo}
                onChange={(event) => setForm((prev: any) => ({ ...prev, replyTo: event.target.value }))}
                placeholder="compta@votre-domaine.fr"
              />
              <div className="rounded-2xl border border-[#dbeafe] bg-[#f8fbff] p-4">
                <SectionTitle>Planning automatique</SectionTitle>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="flex items-start gap-3 rounded-xl border border-[#e2e8f0] bg-white px-3 py-3">
                    <input
                      type="checkbox"
                      checked={Boolean(form.automaticEnabled)}
                      onChange={(event) =>
                        setForm((prev: any) => ({ ...prev, automaticEnabled: event.target.checked }))
                      }
                      className="mt-1 h-4 w-4 rounded border-[#cbd5e1]"
                    />
                    <span>
                      <span className="block text-sm font-bold text-[#0f172a]">Relances automatiques</span>
                      <span className="block text-xs leading-5 text-[#64748b]">
                        Le job envoie les relances prévues si un destinataire existe et que le solde reste dû.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-[#e2e8f0] bg-white px-3 py-3">
                    <input
                      type="checkbox"
                      checked={Boolean(form.attachPdf)}
                      onChange={(event) => setForm((prev: any) => ({ ...prev, attachPdf: event.target.checked }))}
                      className="mt-1 h-4 w-4 rounded border-[#cbd5e1]"
                    />
                    <span>
                      <span className="block text-sm font-bold text-[#0f172a]">Joindre le PDF</span>
                      <span className="block text-xs leading-5 text-[#64748b]">
                        Ajoute la facture aux relances automatiques quand le PDF est disponible.
                      </span>
                    </span>
                  </label>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <InputField
                    label="Jours de relance"
                    value={form.scheduleDays}
                    onChange={(event) => setForm((prev: any) => ({ ...prev, scheduleDays: event.target.value }))}
                    placeholder="-2, 3, 10, 15"
                  />
                  <InputField
                    label="Intervalle minimum entre relances (h)"
                    type="number"
                    min="1"
                    max="720"
                    value={form.minIntervalHours}
                    onChange={(event) => setForm((prev: any) => ({ ...prev, minIntervalHours: event.target.value }))}
                    placeholder="24"
                  />
                </div>
                <p className="mt-3 text-xs leading-5 text-[#64748b]">
                  Les valeurs sont relatives à l'échéance : -2 signifie deux jours avant, 3 trois jours après.
                </p>
              </div>
              <div>
                <label className="block text-[#374151] mb-1.5 text-sm font-medium">Corps du message de relance</label>
                <textarea
                  className={settingsTextareaCls}
                  value={form.reminderBody}
                  onChange={(event) => setForm((prev: any) => ({ ...prev, reminderBody: event.target.value }))}
                  placeholder="Bonjour, sauf erreur de notre part…"
                />
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <InputField
                  label="Pénalités de retard"
                  value={form.latePaymentInterest}
                  onChange={(event) => setForm((prev: any) => ({ ...prev, latePaymentInterest: event.target.value }))}
                  placeholder="3 × taux BCE"
                />
                <InputField
                  label="Indemnité forfaitaire (€)"
                  type="number"
                  value={form.recoveryFee}
                  onChange={(event) => setForm((prev: any) => ({ ...prev, recoveryFee: event.target.value }))}
                  placeholder="40"
                />
              </div>
              <InputField
                label="Conditions d’escompte"
                value={form.discountTerms}
                onChange={(event) => setForm((prev: any) => ({ ...prev, discountTerms: event.target.value }))}
                placeholder="Aucun escompte pour paiement anticipé"
              />
              <div className="flex flex-wrap gap-2">
                <PrimaryButton onClick={() => void save()} disabled={saving}>
                  <Mail className="w-3.5 h-3.5" />
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </PrimaryButton>
                <Link
                  to="/app/invoices?status=overdue"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#e2e8f0] text-[#374151] hover:bg-[#f8fafc] text-sm font-medium"
                >
                  Retour aux factures en retard <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </Card>
            <div className="space-y-4">
              <Card>
                <SectionTitle>Variables utiles</SectionTitle>
                <div className="space-y-2 text-[#374151]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                  <div>
                    <code>{"{number}"}</code> Numéro de facture ou devis
                  </div>
                  <div>
                    <code>{"{client}"}</code> Nom du client
                  </div>
                  <div>
                    <code>{"{due_date}"}</code> Date d’échéance facture
                  </div>
                  <div>
                    <code>{"{total_ttc}"}</code> Total TTC du document
                  </div>
                  <div>
                    <code>{"{invoice_link}"}</code> Lien client sécurisé
                  </div>
                  <div>
                    <code>{"{company}"}</code> Nom de l'entreprise
                  </div>
                </div>
              </Card>
              <NoticeBanner tone="info">
                Les factures en retard sont suivies directement depuis la liste des factures, avec un état lisible et
                des actions simples pour les premiers clients.
              </NoticeBanner>
            </div>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

export function SettingsWebhooksPage() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<any>({
    url: "",
    status: "active",
    secret: "",
    events: WEBHOOK_EVENT_OPTIONS.map((item) => item.value),
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/webhooks");
      const payload = await ensureSettingsOk(res, "Impossible de charger les webhooks.");
      setItems(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger les webhooks."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggleEvent = (value: string) => {
    setForm((prev: any) => ({
      ...prev,
      events: prev.events.includes(value)
        ? prev.events.filter((item: string) => item !== value)
        : [...prev.events, value],
    }));
  };

  const submitWebhook = async () => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({
          url: form.url,
          status: form.status,
          secret: (form.secret || "").trim() || null,
          events: form.events,
        }),
      });
      setNotice("Webhook ajouté.");
      setForm({ url: "", status: "active", secret: "", events: WEBHOOK_EVENT_OPTIONS.map((item) => item.value) });
      await load();
    } catch (err) {
      setError(formatApiError(err, "Création du webhook impossible."));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStatus = async (item: any) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/webhooks/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: normalizeStatus(item.status) === "active" ? "disabled" : "active" }),
      });
      setNotice("Statut du webhook mis à jour.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour impossible."));
    } finally {
      setBusyId(null);
    }
  };

  const removeWebhook = async (item: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Supprimer le webhook ${item.url} ?`)) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/webhooks/${item.id}`, { method: "DELETE" });
      setNotice("Webhook supprimé.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsShell
      title="Webhooks"
      breadcrumb="Paramètres · Webhooks"
      desc="Points d’envoi sortants pour les statuts d’e-facturation."
    >
      <div className="space-y-4">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        <div className="grid xl:grid-cols-[0.95fr,1.05fr] gap-4">
          <Card className="space-y-4">
            <SectionTitle>Ajouter un point d’envoi</SectionTitle>
            <InputField
              label="URL destination"
              value={form.url}
              onChange={(event) => setForm((prev: any) => ({ ...prev, url: event.target.value }))}
              placeholder="https://votre-crm.example/webhooks/einvoicing"
            />
            <div className="grid md:grid-cols-2 gap-4">
              <SelectField
                label="Statut initial"
                value={form.status}
                onChange={(event) => setForm((prev: any) => ({ ...prev, status: event.target.value }))}
              >
                <option value="active">Actif</option>
                <option value="disabled">Désactivé</option>
              </SelectField>
              <InputField
                label="Secret (optionnel)"
                value={form.secret}
                onChange={(event) => setForm((prev: any) => ({ ...prev, secret: event.target.value }))}
                placeholder="whsec_…"
              />
            </div>
            <div>
              <div className="text-[#374151] mb-2 text-sm font-medium">Événements envoyés</div>
              <div className="space-y-2">
                {WEBHOOK_EVENT_OPTIONS.map((item) => (
                  <SettingsCheckboxRow
                    key={item.value}
                    checked={form.events.includes(item.value)}
                    onChange={() => toggleEvent(item.value)}
                    label={item.label}
                    hint={item.value}
                  />
                ))}
              </div>
            </div>
            <PrimaryButton
              onClick={() => void submitWebhook()}
              disabled={submitting || !form.url || !form.events.length}
            >
              <Webhook className="w-3.5 h-3.5" />
              {submitting ? "Ajout…" : "Ajouter le webhook"}
            </PrimaryButton>
          </Card>

          <Card className="space-y-4">
            <SectionTitle
              action={
                <SecondaryButton onClick={() => void load()}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  Rafraîchir
                </SecondaryButton>
              }
            >
              Points d’envoi actifs
            </SectionTitle>
            {loading ? (
              <LoadingCard label="Chargement des points d’envoi…" />
            ) : items.length ? (
              <DataTable headers={["Destination", "Statut", "Événements", "Dernière livraison", "Actions"]}>
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-[#0f172a] break-all text-sm font-medium">{item.url}</div>
                      <div className="text-[#94a3b8] text-xs">Créé le {formatSettingsDateTime(item.created_at)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        status={settingsToneFromStatus(item.status)}
                        label={prettifySettingsStatus(item.status)}
                      />
                    </td>
                    <td className="px-4 py-3 text-[#64748b] text-sm">
                      {Array.isArray(item.events) ? item.events.length : 0} événement(s)
                    </td>
                    <td className="px-4 py-3 text-[#64748b] text-sm">
                      {item.last_success_at
                        ? `OK ${formatSettingsDateTime(item.last_success_at)}`
                        : item.last_failure_at
                          ? `Échec ${formatSettingsDateTime(item.last_failure_at)}`
                          : "Jamais"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <SecondaryButton
                          className="!px-2.5 !py-1.5 !text-xs"
                          onClick={() => void toggleStatus(item)}
                          disabled={busyId === item.id}
                        >
                          {normalizeStatus(item.status) === "active" ? "Désactiver" : "Activer"}
                        </SecondaryButton>
                        <DangerButton
                          className="!px-2.5 !py-1.5 !text-xs"
                          onClick={() => void removeWebhook(item)}
                          disabled={busyId === item.id}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Supprimer
                        </DangerButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyCard
                title="Aucun webhook configuré"
                description="Vous pouvez vendre sans webhooks pour des premiers pilotes, mais cette brique devient utile dès que vos clients veulent brancher CRM, ERP ou support sur les statuts e-factures."
              />
            )}
          </Card>
        </div>
      </div>
    </SettingsShell>
  );
}

export function SettingsSandboxPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const purchasesGate = resolveProFeatureGate(capabilities, "purchases");
  const purchasesEnabled = purchasesGate.enabled;
  const sandboxRuntimeEnabled = process.env.NODE_ENV !== "production";
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inboxItems, setInboxItems] = useState<any[]>([]);
  const [inboxConnection, setInboxConnection] = useState<any>(null);
  const [platformStatus, setPlatformStatus] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [inboxRes, connectionRes, platformRes] = await Promise.allSettled([
        rawApi("/api/inbox?page=1&page_size=5"),
        rawApi("/api/inbox/connection"),
        rawApi("/api/platforms/onboarding-status"),
      ]);
      if (inboxRes.status === "fulfilled" && inboxRes.value.ok) {
        const payload = await inboxRes.value.json().catch(() => null);
        setInboxItems(Array.isArray(payload?.items) ? payload.items : []);
      } else {
        setInboxItems([]);
      }
      if (connectionRes.status === "fulfilled" && connectionRes.value.ok) {
        setInboxConnection(await connectionRes.value.json().catch(() => null));
      } else {
        setInboxConnection(null);
      }
      if (platformRes.status === "fulfilled" && platformRes.value.ok) {
        setPlatformStatus(await platformRes.value.json().catch(() => null));
      } else {
        setPlatformStatus(null);
      }
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger l’espace de test."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!purchasesEnabled || !sandboxRuntimeEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [purchasesEnabled, sandboxRuntimeEnabled, sessionLoading]);

  const seedMockInvoice = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const stamp = Date.now();
    const payload = {
      id: `msg-${stamp}`,
      received_at: new Date().toISOString(),
      provider_slug: "http_generic",
      payload: {
        invoice: {
          supplier_name: "Demo Supplier",
          supplier_siren: "123456789",
          invoice_number: `INBOX-${stamp}`,
          issue_date: new Date().toISOString().slice(0, 10),
          total_ttc: "120.00",
          currency: "EUR",
          format: "facturx",
        },
        attachments: [
          { kind: "pdf", content_base64: btoa("PDF-TEST") },
          { kind: "xml", content_base64: btoa("<invoice>demo</invoice>") },
        ],
      },
    };
    try {
      await apiFetch("/api/inbox/mock", { method: "POST", body: JSON.stringify(payload) });
      setNotice("Facture reçue de démonstration créée dans les achats.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Création de la démonstration indisponible sur cet environnement."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsShell
      title="Espace de test"
      breadcrumb="Paramètres · Espace de test"
      desc="Espace de démonstration réservé aux environnements non publics."
    >
      <div className="space-y-4">
        {!sessionLoading && !purchasesEnabled ? (
          <UpgradeNoticeCard
            title={purchasesGate.reactivationRequired ? purchasesGate.statusLabel : "Espace achats réservé au plan Pro"}
            description={
              purchasesGate.reactivationDescription ||
              "Starter reste limité aux clients, devis et factures classiques. Les achats fournisseurs sont disponibles avec Pro."
            }
            ctaLabel={purchasesGate.ctaLabel}
            ctaHref={purchasesGate.ctaHref}
            note={purchasesGate.reactivationNote || undefined}
          />
        ) : null}
        {!sessionLoading && purchasesEnabled && !sandboxRuntimeEnabled ? (
          <NoticeBanner tone="info" title="Espace de test désactivé en production">
            Aucune donnée de démonstration ne peut être créée depuis l’environnement public. Utilisez un environnement
            de test isolé pour simuler la réception d’achats fournisseurs.
          </NoticeBanner>
        ) : null}
        {purchasesEnabled && sandboxRuntimeEnabled && error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {purchasesEnabled && sandboxRuntimeEnabled && notice ? (
          <NoticeBanner tone="success">{notice}</NoticeBanner>
        ) : null}
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !purchasesEnabled || !sandboxRuntimeEnabled ? null : loading ? (
          <LoadingCard label="Chargement de l’espace de test…" />
        ) : (
          <>
            <div className="grid md:grid-cols-3 gap-4">
              <StatCard
                label="Réception active"
                value={inboxConnection?.active ? "Oui" : "Non"}
                sub={
                  Array.isArray(inboxConnection?.providers) && inboxConnection.providers.length
                    ? inboxConnection.providers.map((item: any) => item.label || item.slug).join(", ")
                    : "Import manuel uniquement"
                }
                accent={inboxConnection?.active ? "green" : "amber"}
                icon={<Layout className="w-4 h-4" />}
              />
              <StatCard
                label="Dernier échange"
                value={
                  platformStatus?.exchanges?.last_success
                    ? formatSettingsDate(platformStatus.exchanges.last_success)
                    : "Aucun"
                }
                sub={
                  platformStatus?.exchanges?.error_summary
                    ? sanitizeUserFacingApiMessage(
                        platformStatus.exchanges.error_summary,
                        400,
                        "Le dernier échange n'a pas abouti.",
                      )
                    : "Aucun incident critique remonté"
                }
                accent={platformStatus?.exchanges?.last_success ? "green" : "cyan"}
                icon={<Globe className="w-4 h-4" />}
              />
              <StatCard
                label="Achats démo"
                value={inboxItems.length}
                sub="élément(s) récents"
                accent="purple"
                icon={<WandSparkles className="w-4 h-4" />}
              />
            </div>
            <Card className="space-y-4">
              <SectionTitle>Actions de démonstration</SectionTitle>
              <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                Prépare rapidement un flux achats/fournisseurs de démonstration. Les blocages techniques restent
                visibles.
              </p>
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  onClick={() => void seedMockInvoice()}
                  disabled={busy}
                  title="Créer une e-facture reçue de démonstration."
                >
                  <WandSparkles className="w-3.5 h-3.5" />
                  {busy ? "Création…" : "Créer une démo reçue"}
                </PrimaryButton>
                <Link
                  to="/app/purchases"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#e2e8f0] text-[#374151] hover:bg-[#f8fafc] text-sm font-medium"
                >
                  Ouvrir achats & fournisseurs <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </Card>
            {inboxItems.length ? (
              <DataTable headers={["Facture", "Fournisseur", "Format", "Statut", "Réception"]}>
                {inboxItems.map((item) => (
                  <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/app/purchases/${item.id}`} className="text-[#1d4ed8] text-sm font-semibold">
                        {item.invoice_number || item.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[#374151] text-sm">{item.supplier_name || "—"}</td>
                    <td className="px-4 py-3 text-[#64748b] text-sm">{item.format || "—"}</td>
                    <td className="px-4 py-3">
                      <StatusPill
                        status={settingsToneFromStatus(item.status)}
                        label={prettifySettingsStatus(item.status)}
                      />
                    </td>
                    <td className="px-4 py-3 text-[#64748b] text-sm">{formatSettingsDateTime(item.received_at)}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyCard
                title="Aucune donnée de test récente"
                description="Crée une facture reçue de démonstration pour vérifier que les achats fournisseurs, les statuts et la navigation détaillée restent cohérents."
              />
            )}
          </>
        )}
      </div>
    </SettingsShell>
  );
}

export function SettingsGenericPage({ title, breadcrumb, desc }: { title: string; breadcrumb: string; desc: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [platformStatus, setPlatformStatus] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const settingsRes = await rawApi("/api/settings/tenant");
        if (settingsRes.ok && !cancelled) {
          const data = await settingsRes.json().catch(() => null);
          setSettings(data || null);
        }

        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes("plateforme")) {
          const pRes = await rawApi("/api/platforms/onboarding-status");
          if (pRes.ok && !cancelled) {
            const pdata = await pRes.json().catch(() => null);
            setPlatformStatus(pdata || null);
          }
        }
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Impossible de charger les paramètres."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [title]);

  const portalTheme = settings?.features?.portal?.theme;

  return (
    <SettingsShell title={title} breadcrumb={breadcrumb} desc={desc}>
      <Card className="max-w-lg space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#f1f5f9] flex items-center justify-center">
            <FlaskConical className="w-4 h-4 text-[#64748b]" />
          </div>
          <span className="text-[#64748b] text-sm">
            {loading ? "Chargement…" : "Configuration dynamique disponible"}
          </span>
        </div>

        {error && <p className="text-[#dc2626] text-xs">{error}</p>}

        {!loading && (
          <div className="space-y-1.5">
            <p className="text-[#94a3b8] text-xs">
              Preset: <strong>{settings?.preset || "standard"}</strong>
            </p>
            <p className="text-[#94a3b8] text-xs">
              Onboarding: <strong>{settings?.onboarding_completed ? "terminé" : "en cours"}</strong>
            </p>
            {portalTheme && (
              <p className="text-[#94a3b8] text-xs">
                Thème portail: <strong>{portalTheme}</strong>
              </p>
            )}
            {platformStatus && (
              <p className="text-[#94a3b8] text-xs">
                Connecteurs actifs:{" "}
                <strong>{Object.values(platformStatus?.enabled_connectors || {}).filter(Boolean).length}</strong>
              </p>
            )}
          </div>
        )}

        <p className="text-[#94a3b8] text-sm">
          La configuration <strong>{title.toLowerCase()}</strong> est reliée à votre espace. Certaines options avancées
          restent en cours d'évolution.
        </p>
      </Card>
    </SettingsShell>
  );
}
