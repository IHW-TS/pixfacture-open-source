import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { apiFetch, formatApiError, rawApi } from "@/lib/api";
import {
  AppPageHeader,
  PrimaryButton,
  SecondaryButton,
  Card,
  NoticeBanner,
  StatusPill,
} from "../../components/app/AppPageHeader";
import {
  Building2,
  CreditCard,
  Palette,
  Shield,
  Download,
  Upload,
  Globe,
  FlaskConical,
  Paperclip,
  ChevronRight,
  Check,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Copy,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Zap,
  RefreshCw,
  Lock,
  Key,
  Smartphone,
  Monitor,
  Laptop,
} from "lucide-react";

/* ── shared shell ── */
function SettingsShell({
  title,
  breadcrumb,
  desc,
  actions,
  children,
}: {
  title: string;
  breadcrumb: string;
  desc: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <AppPageHeader
        title={title}
        breadcrumb={breadcrumb}
        description={desc}
        backHref="/app/settings"
        actions={actions}
      />
      <div className="p-6 lg:p-8">{children}</div>
    </div>
  );
}

/* ── shared form input ── */
const inputCls =
  "w-full px-3.5 py-2.5 rounded-xl bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 transition-all";
const inputStyle = {
  fontSize: "0.875rem",
  border: "1px solid rgba(0,0,0,0.08)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
};
const labelCls = "block text-[#374151] mb-1.5";
const labelStyle = { fontSize: "0.8125rem", fontWeight: 500 as const };

/* ══════════════════════════════════════════════════════════
   Settings Index
══════════════════════════════════════════════════════════ */
type SettingsCardGroup = "priority" | "documents" | "client";
type SettingsCardStatus = "ok" | "warn" | null;
type SettingsLink = {
  href: string;
  label: string;
  icon: typeof Building2;
  desc: string;
  color: string;
  bg: string;
  status: SettingsCardStatus;
  group: SettingsCardGroup;
  tag?: string;
};

const settingsLinks: SettingsLink[] = [
  {
    href: "/app/settings/company",
    label: "Entreprise",
    icon: Building2,
    desc: "Raison sociale, SIRET, TVA, adresse et mentions légales.",
    color: "#1d4ed8",
    bg: "#eff6ff",
    status: "warn",
    group: "priority",
    tag: "Compte",
  },
  {
    href: "/app/settings/billing",
    label: "Abonnement",
    icon: CreditCard,
    desc: "Plan actif, limites du compte et facturation.",
    color: "#059669",
    bg: "#ecfdf5",
    status: "ok",
    group: "priority",
    tag: "Compte",
  },
  {
    href: "/app/settings/security",
    label: "Sécurité",
    icon: Shield,
    desc: "Mot de passe et double authentification facultative.",
    color: "#dc2626",
    bg: "#fef2f2",
    status: null,
    group: "priority",
    tag: "Compte",
  },
  {
    href: "/app/settings/attachments",
    label: "Pièces jointes",
    icon: Paperclip,
    desc: "Formats acceptés, taille maximum et pièces utiles.",
    color: "#0891b2",
    bg: "#ecfeff",
    status: null,
    group: "documents",
    tag: "Documents",
  },
];

export function SettingsIndexPage() {
  const [companyProfile, setCompanyProfile] = useState<Record<string, any> | null>(null);
  const [companyLoaded, setCompanyLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadCompanyStatus = async () => {
      try {
        const res = await rawApi("/api/company/profile");
        if (!res.ok) {
          if (!cancelled) setCompanyLoaded(true);
          return;
        }
        const company = await res.json().catch(() => null);
        if (!cancelled) {
          setCompanyProfile(company);
          setCompanyLoaded(true);
        }
      } catch {
        if (!cancelled) setCompanyLoaded(true);
      }
    };
    void loadCompanyStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const companyReady =
    !companyLoaded ||
    Boolean(
      String(companyProfile?.name || companyProfile?.legal_name || "").trim() &&
      String(companyProfile?.siret || "").trim() &&
      String(companyProfile?.address || companyProfile?.address_line1 || "").trim(),
    );
  const resolvedSettingsLinks = useMemo(
    () =>
      settingsLinks.map((setting) => {
        if (setting.href === "/app/settings/company") {
          return { ...setting, status: companyReady ? ("ok" as const) : ("warn" as const) };
        }
        return setting;
      }),
    [companyReady],
  );
  const needsActionItems = resolvedSettingsLinks.filter((s) => s.status === "warn");
  const needsAction = needsActionItems.length;
  const needsActionLabel = needsActionItems.map((item) => item.label).join(" et ");
  const needsActionVerb = needsAction > 1 ? "requièrent" : "requiert";
  const groupedLinks = [
    {
      key: "documents",
      label: "Documents",
      description: "Réglages des factures, devis et fichiers associés.",
      items: resolvedSettingsLinks.filter((link) => link.group === "documents"),
    },
    {
      key: "client",
      label: "Parcours client",
      description: "Réglages visibles dans les parcours réellement activés.",
      items: resolvedSettingsLinks.filter((link) => link.group === "client"),
    },
  ].filter((group) => group.items.length > 0);

  const priorityLinks = resolvedSettingsLinks.filter((link) => link.group === "priority");
  const quickLinks = resolvedSettingsLinks.filter((link) =>
    ["/app/settings/company", "/app/settings/export"].includes(link.href),
  );

  const renderSettingsCard = (s: SettingsLink, compact = false) => {
    const Icon = s.icon;
    const statusLabel = s.status === "warn" ? "À vérifier" : s.status === "ok" ? "Prêt" : null;
    if (compact) {
      return (
        <Link
          key={s.href}
          to={s.href}
          className="group flex min-h-[72px] items-center gap-3 rounded-xl border border-[#dbe4f0] bg-white px-3 py-3 transition-colors hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
        >
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: s.bg }}
          >
            <Icon className="h-[18px] w-[18px]" style={{ color: s.color, strokeWidth: 1.9 }} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.875rem] font-[800] text-[#0f172a]">{s.label}</span>
            <span className="mt-0.5 block truncate text-[0.75rem] font-[650] text-[#64748b]">{s.desc}</span>
          </span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-[#94a3b8] transition-colors group-hover:text-[#1d4ed8]" />
        </Link>
      );
    }
    return (
      <Link
        key={s.href}
        to={s.href}
        className={`group flex h-full min-h-[112px] items-center gap-4 rounded-2xl border border-[#dbe4f0] bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-[#bfd2f3] hover:shadow-[0_14px_34px_rgba(15,23,42,0.10)] ${
          compact ? "min-h-[84px]" : ""
        }`}
        style={{ boxShadow: "0 1px 3px rgba(15,23,42,0.05)" }}
      >
        <span
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: s.bg }}
        >
          <Icon className="h-5 w-5" style={{ color: s.color, strokeWidth: 1.9 }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex items-center gap-2">
            <span className="truncate text-[0.95rem] font-[750] text-[#0f172a]">{s.label}</span>
            {s.tag ? (
              <span className="hidden rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[0.68rem] font-[700] text-[#475569] sm:inline-flex">
                {s.tag}
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-[0.8125rem] leading-5 text-[#5f6f89]">{s.desc}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-2">
          {statusLabel ? (
            <span
              className="rounded-full px-2.5 py-1 text-[0.72rem] font-[750]"
              style={{
                color: s.status === "warn" ? "#b45309" : "#047857",
                background: s.status === "warn" ? "#fffbeb" : "#ecfdf5",
                border: `1px solid ${s.status === "warn" ? "#fcd34d" : "#86efac"}`,
              }}
            >
              {statusLabel}
            </span>
          ) : null}
          <ChevronRight className="h-4 w-4 text-[#b8c4d5] transition-colors group-hover:text-[#1d4ed8]" />
        </span>
      </Link>
    );
  };

  return (
    <div>
      <AppPageHeader
        title="Paramètres"
        breadcrumb="Configuration"
        description="Réglages essentiels du compte, des documents et de leur sécurité."
      />
      <div className="p-6 lg:p-8 space-y-5">
        {needsAction > 0 && (
          <NoticeBanner variant="warn" title={`${needsAction} réglage(s) à compléter`}>
            {needsActionLabel} {needsActionVerb} votre attention pour optimiser votre compte.
          </NoticeBanner>
        )}
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-6">
            <section className="space-y-3">
              <div>
                <h3 className="text-[1rem] font-[750] text-[#0f172a]">Réglages essentiels</h3>
                <p className="text-[0.8125rem] text-[#64748b]">
                  Les points qui changent directement vos factures, votre compte et votre conformité.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">{priorityLinks.map((s) => renderSettingsCard(s))}</div>
            </section>

            {groupedLinks.map((group, groupIndex) => (
              <motion.section
                key={group.key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: groupIndex * 0.04 }}
                className="space-y-3"
              >
                <div>
                  <h3 className="text-[1rem] font-[750] text-[#0f172a]">{group.label}</h3>
                  <p className="text-[0.8125rem] text-[#64748b]">{group.description}</p>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">{group.items.map((s) => renderSettingsCard(s))}</div>
              </motion.section>
            ))}
          </div>

          <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
            <div className="rounded-2xl border border-[#dbe4f0] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[0.78rem] font-[800] uppercase tracking-[0.08em] text-[#94a3b8]">À traiter</p>
                  <h3 className="text-[1rem] font-[800] text-[#0f172a]">
                    {needsAction > 0 ? `${needsAction} point(s)` : "Compte prêt"}
                  </h3>
                </div>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff6ff] text-[#1d4ed8]">
                  <CheckCircle2 className="h-5 w-5" />
                </span>
              </div>
              <div className="space-y-2">
                {(needsActionItems.length > 0 ? needsActionItems : priorityLinks.slice(0, 2)).map((item) => (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[#edf2f7] px-3 py-2.5 text-[0.8125rem] font-[700] text-[#0f172a] transition-colors hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                  >
                    <span className="truncate">{item.label}</span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-[#94a3b8]" />
                  </Link>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-[#dbe4f0] bg-[#f8fbff] p-4">
              <p className="mb-3 text-[0.78rem] font-[800] uppercase tracking-[0.08em] text-[#94a3b8]">Accès directs</p>
              <div className="space-y-2">{quickLinks.map((s) => renderSettingsCard(s, true))}</div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Company → redirect to full page
══════════════════════════════════════════════════════════ */
export function SettingsCompanyPage() {
  return (
    <SettingsShell
      title="Entreprise"
      breadcrumb="Paramètres · Entreprise"
      desc="Raison sociale, SIRET, TVA et informations légales."
    >
      <Card className="max-w-lg">
        <p className="text-[#64748b] mb-4" style={{ fontSize: "0.875rem", lineHeight: 1.6 }}>
          Configurez toutes les informations de votre entreprise pour les documents de facturation Factur-X et le canal
          public.
        </p>
        <Link
          to="/app/company"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-white transition-all"
          style={{
            fontSize: "0.875rem",
            fontWeight: 600,
            background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
            boxShadow: "0 2px 8px rgba(29,78,216,0.3)",
          }}
        >
          Ouvrir le dossier entreprise <ChevronRight className="w-4 h-4" />
        </Link>
      </Card>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Billing → redirect
══════════════════════════════════════════════════════════ */
export function SettingsBillingPage() {
  return (
    <SettingsShell
      title="Abonnement"
      breadcrumb="Paramètres · Abonnement"
      desc="Plan actif et facturation de l’abonnement."
    >
      <Card className="max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#ecfdf5] flex items-center justify-center">
            <CreditCard className="w-5 h-5 text-[#059669]" />
          </div>
          <div>
            <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
              Plan Starter / Pro
            </p>
            <StatusPill status="muted" label="À vérifier" />
          </div>
        </div>
        <p className="text-[#64748b] mb-4" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
          Ouvrez la page d’abonnement active pour consulter le plan réel, la période de facturation et les actions
          disponibles.
        </p>
        <Link
          to="/app/billing"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-white transition-all"
          style={{
            fontSize: "0.875rem",
            fontWeight: 600,
            background: "linear-gradient(135deg,#059669,#0d9488)",
            boxShadow: "0 2px 8px rgba(5,150,105,0.3)",
          }}
        >
          Gérer l'abonnement <ChevronRight className="w-4 h-4" />
        </Link>
      </Card>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Branding
══════════════════════════════════════════════════════════ */
export function SettingsBrandingPage() {
  const [logoUrl, setLogoUrl] = useState("");
  const [color, setColor] = useState("#1d4ed8");
  const [pdfTemplate, setPdfTemplate] = useState("classic");
  const [emailSignature, setEmailSignature] = useState("");
  const [emailFooterNote, setEmailFooterNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [companyRes, settingsRes] = await Promise.all([
          rawApi("/api/company/profile"),
          rawApi("/api/settings/tenant"),
        ]);
        const company = companyRes.ok ? await companyRes.json().catch(() => null) : null;
        const settings = settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
        const branding = settings?.features?.branding || {};
        if (cancelled) return;
        setLogoUrl(company?.logo_url || "");
        setColor(String(branding?.email_accent || "#1d4ed8"));
        setPdfTemplate(String(branding?.pdf_template || "classic"));
        setEmailSignature(String(branding?.email_signature || ""));
        setEmailFooterNote(String(branding?.email_footer_note || ""));
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Chargement du branding impossible."));
      } finally {
        if (!cancelled) setLoading(false);
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
    setNotice(null);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response: any = await apiFetch("/api/company/logo", { method: "POST", body });
      setLogoUrl(String(response?.logo_url || ""));
      setNotice("Logo enregistré. Il sera repris sur les documents et espaces publics.");
    } catch (err) {
      setError(formatApiError(err, "Import du logo impossible."));
    } finally {
      setUploading(false);
    }
  };

  const deleteLogo = async () => {
    setUploading(true);
    setNotice(null);
    setError(null);
    try {
      const response: any = await apiFetch("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify({ logo_url: null }),
      });
      setLogoUrl(String(response?.logo_url || ""));
      setNotice("Logo retiré des prochains documents.");
    } catch (err) {
      setError(formatApiError(err, "Suppression du logo impossible."));
    } finally {
      setUploading(false);
    }
  };

  const saveBranding = async () => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      await apiFetch("/api/settings/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          features: {
            branding: {
              pdf_template: pdfTemplate,
              email_accent: color || null,
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
      setSaving(false);
    }
  };

  return (
    <SettingsShell
      title="Branding"
      breadcrumb="Paramètres · Branding"
      desc="Logo, couleur d'accent et signature utilisés par les PDF, emails et espaces publics."
      actions={
        <PrimaryButton onClick={saveBranding} disabled={saving || loading}>
          {saving ? (
            "Enregistrement…"
          ) : (
            <>
              <Check className="w-3.5 h-3.5" /> Enregistrer
            </>
          )}
        </PrimaryButton>
      }
    >
      <div className="max-w-4xl space-y-4">
        {error ? (
          <NoticeBanner variant="danger" title="Branding documents">
            {error}
          </NoticeBanner>
        ) : null}
        {notice ? (
          <NoticeBanner variant="success" title="Branding documents">
            {notice}
          </NoticeBanner>
        ) : null}

        <Card>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
            <div>
              <h3 className="mb-1 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                Identité visuelle
              </h3>
              <p className="mb-4 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                Le logo est sauvegardé immédiatement. La couleur et les textes sont enregistrés avec le bouton en haut.
              </p>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-[#dbe4f0] bg-[#f8fafc]">
                  {logoUrl ? (
                    // The stored tenant logo can come from an authenticated runtime URL that Next Image cannot preload.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt="Logo entreprise" className="h-full w-full object-contain p-2" />
                  ) : (
                    <Palette className="h-6 w-6 text-[#94a3b8]" />
                  )}
                </div>
                <div className="min-w-[220px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[#374151] transition-all hover:bg-[#f8fafc]">
                      <Upload className="h-3.5 w-3.5" />
                      {uploading ? "Envoi…" : logoUrl ? "Remplacer le logo" : "Ajouter un logo"}
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        className="hidden"
                        disabled={uploading || loading}
                        onChange={(event) => void uploadLogo(event.target.files?.[0])}
                      />
                    </label>
                    {logoUrl ? (
                      <SecondaryButton onClick={deleteLogo} disabled={uploading || loading}>
                        <Trash2 className="h-3.5 w-3.5 text-[#dc2626]" />
                        Retirer
                      </SecondaryButton>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    PNG ou JPG, 2 Mo maximum. Utilisé sur PDF, emails et portail client.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <div className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white">
                <div
                  className="flex items-center justify-between px-4 py-3 text-white"
                  style={{ background: `linear-gradient(135deg, ${color || "#1d4ed8"}, #4f46e5)` }}
                >
                  <span className="font-bold" style={{ fontSize: "0.8125rem" }}>
                    FACTURE
                  </span>
                  <span className="opacity-85" style={{ fontSize: "0.75rem" }}>
                    Aperçu
                  </span>
                </div>
                <div className="space-y-2 p-4">
                  <div className="h-2 rounded bg-[#e2e8f0]" />
                  <div className="h-2 w-2/3 rounded bg-[#eef2f7]" />
                  <div className="h-2 w-5/6 rounded bg-[#eef2f7]" />
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <h3 className="mb-4 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
            Réglages documents
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="branding-accent-color" className={labelCls} style={labelStyle}>
                Couleur d'accent emails
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  aria-label="Sélectionner la couleur d'accent des emails"
                  value={color || "#1d4ed8"}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-10 w-12 cursor-pointer rounded-xl border border-[#e2e8f0]"
                  style={{ padding: "2px" }}
                  disabled={loading}
                />
                <input
                  id="branding-accent-color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className={`${inputCls} font-mono`}
                  style={{ ...inputStyle, maxWidth: 150 }}
                  placeholder="#1d4ed8"
                  disabled={loading}
                />
              </div>
            </div>
            <div>
              <label htmlFor="branding-pdf-template" className={labelCls} style={labelStyle}>
                Modèle PDF par défaut
              </label>
              <select
                id="branding-pdf-template"
                value={pdfTemplate}
                onChange={(e) => setPdfTemplate(e.target.value)}
                className={inputCls}
                style={inputStyle}
                disabled={loading}
              >
                <option value="classic">Classique</option>
                <option value="graphite">Graphite</option>
                <option value="ivory">Ivoire</option>
              </select>
            </div>
            <div>
              <label htmlFor="branding-email-signature" className={labelCls} style={labelStyle}>
                Signature email
              </label>
              <textarea
                id="branding-email-signature"
                value={emailSignature}
                onChange={(e) => setEmailSignature(e.target.value)}
                className={`${inputCls} min-h-[96px] resize-y`}
                style={inputStyle}
                placeholder={"Votre document est disponible depuis le portail sécurisé."}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="branding-email-footer-note" className={labelCls} style={labelStyle}>
                Note de pied d'email
              </label>
              <textarea
                id="branding-email-footer-note"
                value={emailFooterNote}
                onChange={(e) => setEmailFooterNote(e.target.value)}
                className={`${inputCls} min-h-[96px] resize-y`}
                style={inputStyle}
                placeholder="Pensez à l'environnement avant d'imprimer cet e-mail."
                disabled={loading}
              />
            </div>
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Security
══════════════════════════════════════════════════════════ */
export function SettingsSecurityPage() {
  const [mfaEnabled, setMfaEnabled] = useState(false);

  const sessions = [
    { id: 1, browser: "Chrome 122", os: "macOS", location: "Paris, France", current: true, lastSeen: "Maintenant" },
    {
      id: 2,
      browser: "Firefox 124",
      os: "Windows 11",
      location: "Lyon, France",
      current: false,
      lastSeen: "Il y a 2 jours",
    },
  ];

  return (
    <SettingsShell
      title="Sécurité"
      breadcrumb="Paramètres · Sécurité"
      desc="Authentification renforcée, sessions actives et gestion des accès."
    >
      <div className="max-w-2xl space-y-5">
        {!mfaEnabled && (
          <NoticeBanner variant="warn" title="Double authentification non activée">
            Activez l'authentification à deux facteurs pour sécuriser votre compte contre les accès non autorisés.
          </NoticeBanner>
        )}

        {/* Double authentification */}
        <Card>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#fef2f2] flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-5 h-5 text-[#dc2626]" style={{ strokeWidth: 1.8 }} />
              </div>
              <div>
                <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                  Double authentification
                </h3>
                <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                  Google Authenticator, Authy, 1Password…
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <StatusPill status={mfaEnabled ? "ok" : "danger"} label={mfaEnabled ? "Actif" : "Inactif"} />
              <button
                onClick={() => setMfaEnabled((o) => !o)}
                className="px-4 py-2 rounded-xl transition-all"
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  background: mfaEnabled ? "#f1f5f9" : "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                  color: mfaEnabled ? "#64748b" : "white",
                  boxShadow: mfaEnabled ? "none" : "0 2px 8px rgba(29,78,216,0.3)",
                }}
              >
                {mfaEnabled ? "Désactiver" : "Activer"}
              </button>
            </div>
          </div>
        </Card>

        {/* Change password */}
        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Mot de passe
          </h3>
          <div className="space-y-4">
            {[
              { label: "Mot de passe actuel", placeholder: "••••••••••" },
              { label: "Nouveau mot de passe", placeholder: "12 caractères min." },
              { label: "Confirmer", placeholder: "Identique au nouveau" },
            ].map((f) => (
              <div key={f.label}>
                <label className={labelCls} style={labelStyle}>
                  {f.label}
                </label>
                <input type="password" placeholder={f.placeholder} className={inputCls} style={inputStyle} />
              </div>
            ))}
            <PrimaryButton>
              <Key className="w-3.5 h-3.5" /> Modifier le mot de passe
            </PrimaryButton>
          </div>
        </Card>

        {/* Active sessions */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
              Sessions actives
            </h3>
            <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
              {sessions.length} session(s)
            </span>
          </div>
          <div className="space-y-3">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 p-3.5 rounded-xl bg-[#f8fafc]">
                <div className="w-9 h-9 rounded-xl bg-white flex items-center justify-center flex-shrink-0 shadow-sm">
                  {s.os.includes("mac") ? (
                    <Laptop className="w-4 h-4 text-[#64748b]" />
                  ) : (
                    <Monitor className="w-4 h-4 text-[#64748b]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                    {s.browser} · {s.os}
                    {s.current && (
                      <span
                        className="ml-2 px-1.5 py-0.5 rounded bg-[#dcfce7] text-[#16a34a]"
                        style={{ fontSize: "0.5625rem", fontWeight: 700 }}
                      >
                        Actuel
                      </span>
                    )}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {s.location} · {s.lastSeen}
                  </p>
                </div>
                {!s.current && (
                  <button
                    className="text-[#dc2626] hover:text-[#b91c1c] transition-colors flex-shrink-0"
                    style={{ fontSize: "0.75rem", fontWeight: 500 }}
                  >
                    Révoquer
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Export
══════════════════════════════════════════════════════════ */
export function SettingsExportPage() {
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState("2026-03-31");

  const formats = [
    {
      label: "CSV comptable",
      desc: "Factures, paiements, clients au format tableur",
      icon: Download,
      color: "#d97706",
      bg: "#fffbeb",
      primary: true,
    },
    {
      label: "FEC (DGFiP)",
      desc: "Fichier des Écritures Comptables — article A47 A-1 LPF",
      icon: Download,
      color: "#1d4ed8",
      bg: "#eff6ff",
      primary: false,
    },
    {
      label: "Archive EDI (ZIP)",
      desc: "UBL 2.1 + CII EN16931 — prêt pour votre PDP",
      icon: Download,
      color: "#7c3aed",
      bg: "#f5f3ff",
      primary: false,
    },
    {
      label: "Factur-X batch",
      desc: "PDF/A-3 + XML embarqué pour toutes les factures de la période",
      icon: Download,
      color: "#059669",
      bg: "#ecfdf5",
      primary: false,
    },
  ];

  return (
    <SettingsShell
      title="Exports comptables"
      breadcrumb="Paramètres · Exports"
      desc="CSV compta, FEC (DGFiP), EDI (UBL/CII) et archives Factur-X."
    >
      <div className="max-w-2xl space-y-5">
        <NoticeBanner variant="success" title="Conformité DGFiP 2026">
          Tous les formats respectent les exigences réglementaires françaises en vigueur.
        </NoticeBanner>

        {/* Period picker */}
        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Période d'export
          </h3>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className={labelCls} style={labelStyle}>
                Du
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className={inputCls}
                style={inputStyle}
              />
            </div>
            <div>
              <label className={labelCls} style={labelStyle}>
                Au
              </label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className={inputCls}
                style={inputStyle}
              />
            </div>
          </div>
          {/* Quick period buttons */}
          <div className="flex flex-wrap gap-2">
            {["T1 2026", "T4 2025", "Année 2025", "Ce mois"].map((p) => (
              <button
                key={p}
                className="px-3 py-1.5 rounded-lg bg-[#f4f6fa] text-[#475569] hover:bg-[#e9ecf0] transition-colors"
                style={{ fontSize: "0.75rem", fontWeight: 500 }}
              >
                {p}
              </button>
            ))}
          </div>
        </Card>

        {/* Format cards */}
        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Formats disponibles
          </h3>
          <div className="space-y-3">
            {formats.map((f) => (
              <div
                key={f.label}
                className="flex items-center gap-4 p-3.5 rounded-xl bg-[#f8fafc] hover:bg-[#f4f6fa] transition-colors"
              >
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: f.bg }}
                >
                  <f.icon className="w-4 h-4" style={{ color: f.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                    {f.label}
                  </p>
                  <p className="text-[#94a3b8] truncate" style={{ fontSize: "0.75rem" }}>
                    {f.desc}
                  </p>
                </div>
                <button
                  className="flex-shrink-0 px-3 py-1.5 rounded-xl text-white transition-all"
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    background: f.primary ? `linear-gradient(135deg,${f.color},#b45309)` : f.bg,
                    color: f.primary ? "white" : f.color,
                    boxShadow: f.primary ? `0 2px 6px ${f.color}40` : "none",
                  }}
                >
                  Exporter la période
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Webhooks
══════════════════════════════════════════════════════════ */
export function SettingsWebhooksPage() {
  const [showSecret, setShowSecret] = useState(false);
  const webhooks = [
    {
      id: "wh1",
      url: "https://api.myerp.com/webhooks/invoices",
      events: ["invoice.sent", "invoice.paid"],
      status: "active",
      lastCall: "Il y a 12 min",
    },
    {
      id: "wh2",
      url: "https://zapier.com/hooks/catch/abc123",
      events: ["payment.received"],
      status: "error",
      lastCall: "Il y a 2h",
    },
  ];

  return (
    <SettingsShell
      title="Webhooks"
      breadcrumb="Paramètres · Webhooks"
      desc="Recevez des événements en temps réel vers vos systèmes externes."
      actions={
        <PrimaryButton>
          <Plus className="w-3.5 h-3.5" /> Ajouter un point d’envoi
        </PrimaryButton>
      }
    >
      <div className="max-w-3xl space-y-5">
        {/* Secret key */}
        <Card>
          <h3 className="text-[#0f172a] mb-3" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Clé secrète de signature
          </h3>
          <div className="flex items-center gap-2 p-3.5 rounded-xl bg-[#f8fafc]">
            <Lock className="w-4 h-4 text-[#64748b] flex-shrink-0" />
            <span className="flex-1 font-mono text-[#374151] truncate" style={{ fontSize: "0.8125rem" }}>
              {showSecret ? "secret_webhook_exemple..." : "whsec_••••••••••••••••••••••••"}
            </span>
            <button
              onClick={() => setShowSecret((o) => !o)}
              className="p-1.5 rounded-lg hover:bg-[#e9ecf0] transition-colors"
            >
              {showSecret ? (
                <EyeOff className="w-3.5 h-3.5 text-[#94a3b8]" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-[#94a3b8]" />
              )}
            </button>
            <button className="p-1.5 rounded-lg hover:bg-[#e9ecf0] transition-colors">
              <Copy className="w-3.5 h-3.5 text-[#94a3b8]" />
            </button>
          </div>
        </Card>

        {/* Endpoints list */}
        <div className="space-y-3">
          {webhooks.map((wh) => (
            <div key={wh.id} className="bg-white rounded-2xl p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusPill
                      status={wh.status === "active" ? "ok" : "danger"}
                      label={wh.status === "active" ? "Actif" : "Erreur"}
                    />
                    <span className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                      <Clock className="w-3 h-3 inline mr-0.5" />
                      {wh.lastCall}
                    </span>
                  </div>
                  <p className="text-[#374151] font-mono truncate mb-2" style={{ fontSize: "0.8125rem" }}>
                    {wh.url}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {wh.events.map((ev) => (
                      <span
                        key={ev}
                        className="px-2 py-0.5 rounded-full bg-[#f4f6fa] text-[#475569]"
                        style={{ fontSize: "0.625rem", fontWeight: 600 }}
                      >
                        {ev}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    className="px-3 py-1.5 rounded-xl bg-[#f4f6fa] text-[#475569] hover:bg-[#e9ecf0] transition-colors"
                    style={{ fontSize: "0.75rem", fontWeight: 500 }}
                  >
                    Tester
                  </button>
                  <button className="p-1.5 rounded-xl text-[#94a3b8] hover:text-[#dc2626] hover:bg-[#fef2f2] transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Dunning (Relances)
══════════════════════════════════════════════════════════ */
export function SettingsDunningPage() {
  useEffect(() => {
    window.location.replace("/app/invoices?status=overdue");
  }, []);

  return (
    <SettingsShell
      title="Relances"
      breadcrumb="Paramètres · Relances"
      desc="Le suivi des relances se fait maintenant directement depuis les factures."
    >
      <Card className="max-w-2xl space-y-3">
        <p className="text-[#475569]" style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>
          Redirection vers les factures en retard. Les relances restent manuelles pour éviter un email envoyé à tort
          quand un règlement n'a pas encore été saisi dans l'outil.
        </p>
        <Link
          to="/app/invoices?status=overdue"
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#1d4ed8] px-4 py-2 text-white transition-colors hover:bg-[#1e40af]"
          style={{ fontSize: "0.875rem", fontWeight: 800 }}
        >
          Ouvrir les factures en retard <ChevronRight className="h-4 w-4" />
        </Link>
      </Card>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Migration
══════════════════════════════════════════════════════════ */
export function SettingsMigrationPage() {
  return (
    <SettingsShell
      title="Migration"
      breadcrumb="Paramètres · Migration"
      desc="Import et export CSV de clients et articles."
    >
      <div className="max-w-2xl space-y-5">
        <NoticeBanner variant="info">
          Les imports sont déduplicables — les doublons (même email ou SIRET) seront ignorés ou mis à jour selon votre
          choix.
        </NoticeBanner>
        {[
          {
            id: "customers",
            label: "Clients",
            desc: "Nom, SIRET, TVA, email, adresse",
            color: "#1d4ed8",
            bg: "#eff6ff",
          },
          {
            id: "items",
            label: "Articles",
            desc: "Désignation, prix unitaire, TVA, unité",
            color: "#059669",
            bg: "#ecfdf5",
          },
        ].map((section) => (
          <Card key={section.id}>
            <div className="flex items-center gap-3 mb-4" id={section.id}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: section.bg }}>
                <Upload className="w-4 h-4" style={{ color: section.color }} />
              </div>
              <div>
                <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                  {section.label}
                </h3>
                <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                  {section.desc}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                style={{
                  background: `linear-gradient(135deg,${section.color},${section.color}cc)`,
                  boxShadow: `0 2px 8px ${section.color}40`,
                }}
              >
                <Upload className="w-3.5 h-3.5" /> Importer CSV
              </PrimaryButton>
              <SecondaryButton>
                <Download className="w-3.5 h-3.5" /> Exporter tous les{" "}
                {section.id === "customers" ? "clients" : "articles"}
              </SecondaryButton>
              <SecondaryButton>
                <Download className="w-3.5 h-3.5" /> Télécharger modèle
              </SecondaryButton>
            </div>
          </Card>
        ))}
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Generic fallback
══════════════════════════════════════════════════════════ */
export function SettingsGenericPage({ title, breadcrumb, desc }: { title: string; breadcrumb: string; desc: string }) {
  return (
    <SettingsShell title={title} breadcrumb={breadcrumb} desc={desc}>
      <Card className="max-w-lg">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl bg-[#f1f5f9] flex items-center justify-center">
            <FlaskConical className="w-4 h-4 text-[#64748b]" />
          </div>
          <span className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
            Configuration à venir
          </span>
        </div>
        <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
          La configuration <strong>{title.toLowerCase()}</strong> sera disponible dans une prochaine mise à jour.
        </p>
      </Card>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Settings Platforms
══════════════════════════════════════════════════════════ */
export function SettingsPlatformsPage() {
  const platforms = [
    {
      id: "chorus",
      label: "Canal public",
      desc: "Canal de transmission des factures de l'État (AIFE).",
      status: "connected" as const,
      detail: "SIRET transmis · accès configuré",
      color: "#1d4ed8",
      bg: "#eff6ff",
    },
    {
      id: "docaposte",
      label: "Docaposte PDP",
      desc: "Plateforme de dématérialisation partenaire agréée DGFiP.",
      status: "pending" as const,
      detail: "En attente d'activation — contactez votre CSM",
      color: "#d97706",
      bg: "#fffbeb",
    },
    {
      id: "piste",
      label: "API Piste (AIFE)",
      desc: "Accès API au canal public pour le suivi des transmissions.",
      status: "disconnected" as const,
      detail: "Non configuré",
      color: "#64748b",
      bg: "#f1f5f9",
    },
  ];

  const statusLabel: Record<string, { text: string; pill: "ok" | "warn" | "muted" }> = {
    connected: { text: "Connecté", pill: "ok" },
    pending: { text: "En attente", pill: "warn" },
    disconnected: { text: "Non connecté", pill: "muted" },
  };

  return (
    <SettingsShell
      title="Plateformes"
      breadcrumb="Paramètres · Plateformes"
      desc="Connecteurs vers les plateformes publiques et PDP agréées DGFiP."
    >
      <div className="max-w-2xl space-y-4">
        {platforms.map((p) => (
          <div key={p.id} className="bg-white rounded-2xl p-5" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: p.bg }}
                >
                  <Globe className="w-5 h-5" style={{ color: p.color, strokeWidth: 1.8 }} />
                </div>
                <div>
                  <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                    {p.label}
                  </h3>
                  <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                    {p.desc}
                  </p>
                  <p className="text-[#94a3b8] mt-0.5" style={{ fontSize: "0.75rem" }}>
                    {p.detail}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <StatusPill status={statusLabel[p.status].pill} label={statusLabel[p.status].text} />
                {p.status === "disconnected" && (
                  <button
                    className="px-3 py-1.5 rounded-xl text-[#1d4ed8] bg-[#eff6ff] hover:bg-[#dbeafe] transition-colors"
                    style={{ fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    Configurer
                  </button>
                )}
                {p.status === "connected" && (
                  <button
                    className="px-3 py-1.5 rounded-xl text-[#64748b] bg-[#f4f6fa] hover:bg-[#e9ecf0] transition-colors"
                    style={{ fontSize: "0.75rem" }}
                  >
                    Gérer
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        <NoticeBanner variant="info" title="Conformité 2026">
          La réforme de facturation électronique impose la transmission via une PDP ou via le PPF d'ici le 1er septembre
          2026 pour les grandes entreprises.
        </NoticeBanner>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Settings Portals
══════════════════════════════════════════════════════════ */
export function SettingsPortalsPage() {
  const [portalEnabled, setPortalEnabled] = useState(true);
  const [quoteEnabled, setQuoteEnabled] = useState(true);
  const [branding, setBranding] = useState(true);

  return (
    <SettingsShell
      title="Portails client"
      breadcrumb="Paramètres · Portails"
      desc="Configurez l'espace client sans compte — accès aux devis et factures."
      actions={<PrimaryButton>Enregistrer</PrimaryButton>}
    >
      <div className="max-w-2xl space-y-5">
        {/* Aperçu */}
        <Card>
          <h3 className="text-[#0f172a] mb-2" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Aperçu du portail
          </h3>
          <p className="text-[#64748b] mb-3" style={{ fontSize: "0.8125rem" }}>
            Lien sécurisé envoyé automatiquement avec chaque facture et devis.
          </p>
          <div className="px-4 py-3 rounded-xl bg-[#f8fafc] font-mono text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
            https://votre-domaine.facturx.pro/c/[token]
          </div>
        </Card>

        {/* Toggles */}
        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Fonctionnalités
          </h3>
          <div className="space-y-4">
            {[
              {
                label: "Portail facturation",
                sub: "Accès aux factures, téléchargement PDF, paiement en ligne",
                val: portalEnabled,
                set: setPortalEnabled,
              },
              {
                label: "Portail devis",
                sub: "Signature électronique et acceptation en ligne",
                val: quoteEnabled,
                set: setQuoteEnabled,
              },
              {
                label: "Branding personnalisé",
                sub: "Logo et couleur de votre marque sur le portail",
                val: branding,
                set: setBranding,
              },
            ].map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between py-3 border-b border-[#f8fafc] last:border-0"
              >
                <div>
                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    {row.label}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {row.sub}
                  </p>
                </div>
                <button
                  onClick={() => row.set((v) => !v)}
                  className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ml-4"
                  style={{ background: row.val ? "#1d4ed8" : "#e2e8f0" }}
                >
                  <span
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md"
                    style={{ left: row.val ? "calc(100% - 18px)" : "2px", transition: "left 150ms" }}
                  />
                </button>
              </div>
            ))}
          </div>
        </Card>

        {/* Domaine */}
        <Card>
          <h3 className="text-[#0f172a] mb-3" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Domaine personnalisé
          </h3>
          <p className="text-[#64748b] mb-3" style={{ fontSize: "0.8125rem" }}>
            Optionnel — nécessite un enregistrement CNAME sur votre DNS.
          </p>
          <div>
            <label className={labelCls} style={labelStyle}>
              Sous-domaine
            </label>
            <input placeholder="factures.monentreprise.fr" className={inputCls} style={inputStyle} />
            <p className="text-[#94a3b8] mt-1.5" style={{ fontSize: "0.75rem" }}>
              Disponible sur le plan Pro et supérieur.
            </p>
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Espace de test
══════════════════════════════════════════════════════════ */
export function SettingsSandboxPage() {
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <SettingsShell
      title="Espace de test"
      breadcrumb="Paramètres · Espace de test"
      desc="Mode données fictives pour tester les flux sans impact réel."
    >
      <div className="max-w-2xl space-y-5">
        {sandboxEnabled && (
          <NoticeBanner variant="warn" title="Espace de test actif">
            Les documents générés sont fictifs et marqués TEST. Ils ne sont pas transmis à la DGFiP ni facturés.
          </NoticeBanner>
        )}

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                Mode test
              </h3>
              <p className="text-[#64748b] mt-0.5" style={{ fontSize: "0.8125rem" }}>
                Génère des factures et devis marqués TEST, sans transmission réelle.
              </p>
            </div>
            <button
              onClick={() => {
                if (!sandboxEnabled) setShowConfirm(true);
                else setSandboxEnabled(false);
              }}
              className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ml-4"
              style={{ background: sandboxEnabled ? "#d97706" : "#e2e8f0" }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md"
                style={{ left: sandboxEnabled ? "calc(100% - 18px)" : "2px", transition: "left 150ms" }}
              />
            </button>
          </div>

          {showConfirm && !sandboxEnabled && (
            <div className="mt-4 p-4 rounded-xl bg-[#fffbeb] border border-[#fde68a]">
              <p className="text-[#92400e] mb-3" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                Activer le mode test ? Les numéros de documents seront préfixés TEST et ne seront pas comptabilisés.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSandboxEnabled(true);
                    setShowConfirm(false);
                  }}
                  className="px-4 py-2 rounded-xl text-white"
                  style={{
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    background: "linear-gradient(135deg,#d97706,#b45309)",
                  }}
                >
                  Activer
                </button>
                <button
                  onClick={() => setShowConfirm(false)}
                  className="px-4 py-2 rounded-xl text-[#64748b] bg-white border border-[#e2e8f0]"
                  style={{ fontSize: "0.8125rem" }}
                >
                  Annuler
                </button>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Données de test
          </h3>
          <div className="space-y-3">
            {[
              { label: "Injecter des clients fictifs", desc: "5 clients avec SIRET, TVA et adresses valides" },
              { label: "Générer des factures test", desc: "3 factures en statuts variés (émise, payée, retard)" },
              { label: "Purger les données de test", desc: "Supprime toutes les données marquées TEST", danger: true },
            ].map((action) => (
              <div
                key={action.label}
                className="flex items-center justify-between py-3 border-b border-[#f8fafc] last:border-0"
              >
                <div>
                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    {action.label}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {action.desc}
                  </p>
                </div>
                <button
                  className="px-3 py-1.5 rounded-xl flex-shrink-0 ml-4 transition-colors"
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    background: (action as any).danger ? "#fef2f2" : "#f4f6fa",
                    color: (action as any).danger ? "#dc2626" : "#475569",
                  }}
                >
                  {(action as any).danger ? "Purger" : "Injecter"}
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}

/* ══════════════════════════════════════════════════════════
   Settings Attachments
══════════════════════════════════════════════════════════ */
export function SettingsAttachmentsPage() {
  const [maxSize, setMaxSize] = useState("10");
  const [allowedTypes, setAllowedTypes] = useState(["pdf", "jpg", "png"]);
  const allTypes = ["pdf", "jpg", "png", "xlsx", "csv", "xml", "docx"];

  const toggleType = (t: string) =>
    setAllowedTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  return (
    <SettingsShell
      title="Pièces jointes"
      breadcrumb="Paramètres · Pièces jointes"
      desc="Formats autorisés, taille maximale et règles de stockage."
      actions={<PrimaryButton>Enregistrer</PrimaryButton>}
    >
      <div className="max-w-xl space-y-5">
        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Taille maximale
          </h3>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="50"
              value={maxSize}
              onChange={(e) => setMaxSize(e.target.value)}
              className="flex-1 accent-[#1d4ed8]"
            />
            <span className="text-[#0f172a] w-16 text-right" style={{ fontSize: "1rem", fontWeight: 700 }}>
              {maxSize} Mo
            </span>
          </div>
          <p className="text-[#94a3b8] mt-2" style={{ fontSize: "0.75rem" }}>
            Par fichier, par document. Limite plateforme : 50 Mo.
          </p>
        </Card>

        <Card>
          <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Formats autorisés
          </h3>
          <div className="flex flex-wrap gap-2">
            {allTypes.map((t) => (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className="px-3 py-1.5 rounded-xl border transition-all"
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  borderColor: allowedTypes.includes(t) ? "#1d4ed8" : "#e2e8f0",
                  background: allowedTypes.includes(t) ? "#eff6ff" : "white",
                  color: allowedTypes.includes(t) ? "#1d4ed8" : "#94a3b8",
                }}
              >
                .{t}
              </button>
            ))}
          </div>
          <p className="text-[#94a3b8] mt-3" style={{ fontSize: "0.75rem" }}>
            {allowedTypes.length} format(s) autorisé(s) · Les PDF sont toujours acceptés pour les factures Factur-X.
          </p>
        </Card>

        <Card>
          <h3 className="text-[#0f172a] mb-3" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Stockage
          </h3>
          <div className="space-y-2">
            {[
              { label: "Fournisseur", value: "Stockage sécurisé hébergé en France" },
              { label: "Rétention", value: "10 ans (obligation légale DGFiP)" },
              { label: "Chiffrement", value: "AES-256 au repos, TLS 1.3 en transit" },
            ].map((row) => (
              <div key={row.label} className="flex justify-between py-2 border-b border-[#f8fafc] last:border-0">
                <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  {row.label}
                </span>
                <span className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}
