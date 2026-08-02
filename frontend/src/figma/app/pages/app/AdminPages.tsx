"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { formatDateTimeFr } from "@/lib/dateFormat";
import { Link, useParams } from "@/figma/react-router-compat";
import { api, formatApiError } from "@/lib/api";
import {
  AppPageHeader,
  Card,
  DataTable,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import {
  Activity,
  BarChart3,
  Building2,
  CheckCircle2,
  FileText,
  Gauge,
  Layers,
  RefreshCw,
  Scale,
  Shield,
  TriangleAlert,
  Trash2,
  Users,
} from "lucide-react";

const ADMIN_PREVIEW_ACTION_TITLE = "Action en aperçu tant que le module d’administration complet n’est pas activé.";

const DIAGNOSTIC_LABELS: Record<string, string> = {
  auth: "Cookies et sécurité",
  db: "Base de données",
  jobs: "Workers et files",
  pdfa: "Génération PDF/A",
  periodic_jobs: "Tâches périodiques",
  redis: "Redis",
  seqino: "Seqino",
  smtp: "Emails transactionnels",
  storage: "Stockage",
  stripe: "Paiement abonnements",
};

const normalizeDiagnosticStatus = (value: unknown): "ok" | "warn" | "fail" => {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (status === "ok") return "ok";
  if (["warn", "warning"].includes(status)) return "warn";
  return "fail";
};

const diagnosticRows = (checks: unknown) =>
  Object.entries(checks && typeof checks === "object" ? (checks as Record<string, any>) : {}).map(([key, value]) => ({
    key,
    label: DIAGNOSTIC_LABELS[key] || key.replace(/_/g, " "),
    status: normalizeDiagnosticStatus(value?.status),
    detail: String(value?.message || value?.recommendation || "Contrôle serveur sans détail.").trim(),
    recommendation: String(value?.recommendation || "").trim() || null,
  }));

type ActionButtonProps = ComponentProps<typeof PrimaryButton> & { children: ReactNode };
type SecondaryActionButtonProps = ComponentProps<typeof SecondaryButton> & { children: ReactNode };

function DisabledPrimaryAction({ children, className = "", ...props }: ActionButtonProps) {
  return (
    <PrimaryButton type="button" disabled title={ADMIN_PREVIEW_ACTION_TITLE} className={className} {...props}>
      {children}
    </PrimaryButton>
  );
}

function DisabledSecondaryAction({ children, className = "", ...props }: SecondaryActionButtonProps) {
  return (
    <SecondaryButton
      type="button"
      disabled
      title={ADMIN_PREVIEW_ACTION_TITLE}
      className={`opacity-75 cursor-not-allowed ${className}`.trim()}
      {...props}
    >
      {children}
    </SecondaryButton>
  );
}

function AdminModuleCard({
  href,
  icon: Icon,
  label,
  desc,
  color,
  bg,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  desc: string;
  color: string;
  bg: string;
}) {
  return (
    <Link
      to={href}
      className="group block rounded-2xl bg-white p-5 transition-all hover:-translate-y-0.5"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 10px 26px rgba(15,23,42,0.05)" }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: bg }}>
          <Icon className="h-5 w-5" style={{ color, strokeWidth: 1.8 }} />
        </div>
        <span
          className="text-[#1d4ed8] opacity-0 transition-opacity group-hover:opacity-100"
          style={{ fontSize: "0.75rem", fontWeight: 600 }}
        >
          Ouvrir
        </span>
      </div>
      <h3 className="mb-1 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
        {label}
      </h3>
      <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
        {desc}
      </p>
    </Link>
  );
}

type AdminTenant = {
  id: string;
  name: string;
  plan: string;
  status: string;
  deleted: boolean;
  users: number;
  invoices: number;
  duplicates: number;
  createdAt?: string | null;
};

const normalizeAdminTenant = (row: any): AdminTenant => {
  const deleted = Boolean(row?.deleted_at);
  const status = deleted ? "inactive" : String(row?.subscription_status || row?.status || "inactive").toLowerCase();
  return {
    id: String(row?.id || ""),
    name: String(row?.name || "Espace sans nom"),
    plan: String(row?.plan || "starter").toLowerCase(),
    status,
    deleted,
    users: Number(row?.user_count ?? row?.users ?? 0),
    invoices: Number(row?.invoice_count ?? row?.invoices ?? 0),
    duplicates: Number(row?.duplicate_count ?? row?.duplicates ?? 0),
    createdAt: row?.created_at || null,
  };
};

function useAdminTenants() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api("/api/admin/tenants");
      setTenants(Array.isArray(rows) ? rows.map(normalizeAdminTenant).filter((tenant) => tenant.id) : []);
    } catch (err) {
      setTenants([]);
      setError(formatApiError(err, "Impossible de charger les espaces."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { tenants, loading, error, load };
}

function useAdminTenantDetail(id: string | undefined) {
  const [tenant, setTenant] = useState<AdminTenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setTenant(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [detail, duplicates] = await Promise.all([
        api(`/api/admin/tenants/${id}`),
        api(`/api/admin/tenants/${id}/customers/duplicates`).catch(() => []),
      ]);
      const normalized = normalizeAdminTenant({
        ...detail,
        duplicate_count: Array.isArray(duplicates) ? duplicates.length : 0,
      });
      setTenant(normalized.id ? normalized : null);
    } catch (err) {
      setTenant(null);
      setError(formatApiError(err, "Impossible de charger cet espace."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return { tenant, loading, error, load };
}

export function AdminDashboardPage() {
  const { tenants, loading, error, load } = useAdminTenants();
  const activeCount = tenants.filter((tenant) => tenant.status === "active").length;
  const totalUsers = tenants.reduce((sum, tenant) => sum + tenant.users, 0);
  const totalInvoices = tenants.reduce((sum, tenant) => sum + tenant.invoices, 0);
  const duplicateCount = tenants.reduce((sum, tenant) => sum + tenant.duplicates, 0);
  const cards = [
    {
      href: "/app/admin/tenants",
      icon: Building2,
      label: "Espaces",
      desc: "Liste active des espaces, doublons et accès dossier.",
      color: "#1d4ed8",
      bg: "#eff6ff",
    },
    {
      href: "/app/admin/readiness",
      icon: Gauge,
      label: "Préparation",
      desc: "Contrôles critiques avant ouverture commerciale.",
      color: "#059669",
      bg: "#ecfdf5",
    },
    {
      href: "/app/admin/deployment",
      icon: Layers,
      label: "Déploiement",
      desc: "Lecture rapide de l'infra et des points de fragilité.",
      color: "#7c3aed",
      bg: "#f5f3ff",
    },
    {
      href: "/app/admin/legal-pack",
      icon: Scale,
      label: "Dossier légal",
      desc: "Documents réglementaires, CGU/CGV et exports juridiques.",
      color: "#d97706",
      bg: "#fffbeb",
    },
    {
      href: "/app/admin/usage-pdp",
      icon: BarChart3,
      label: "Usage Seqino",
      desc: "Volumes mensuels et coût estimé par espace.",
      color: "#0891b2",
      bg: "#ecfeff",
    },
    {
      href: "/app/admin/diagnostic",
      icon: Activity,
      label: "Contrôles support",
      desc: "Session, accès et configuration en lecture rapide.",
      color: "#64748b",
      bg: "#f1f5f9",
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="Administration"
        breadcrumb="Admin plateforme"
        description="Modules, contrôles et support."
        actions={
          <SecondaryButton onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="w-full space-y-5 p-5 lg:p-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {loading ? <LoadingCard label="Chargement des données admin…" /> : null}
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard
            label="Espaces actifs"
            value={activeCount}
            sub={`sur ${tenants.length} espaces`}
            accent="blue"
            icon={<Building2 className="h-4 w-4" />}
          />
          <StatCard
            label="Utilisateurs"
            value={totalUsers}
            sub="total plateforme"
            accent="green"
            icon={<Users className="h-4 w-4" />}
          />
          <StatCard
            label="Factures"
            value={totalInvoices}
            sub="tous espaces"
            accent="purple"
            icon={<FileText className="h-4 w-4" />}
          />
          <StatCard
            label="Doublons"
            value={duplicateCount}
            sub="à surveiller"
            accent="amber"
            icon={<TriangleAlert className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <AdminModuleCard key={card.href} {...card} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function AdminTenantsPage() {
  const { tenants, loading, error, load } = useAdminTenants();
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const filtered = onlyDuplicates ? tenants.filter((tenant) => tenant.duplicates > 0) : tenants;

  return (
    <div>
      <AppPageHeader
        title="Espaces"
        breadcrumb="Admin · espaces"
        description="Espaces, doublons et accès rapides."
        actions={
          <SecondaryButton onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {loading ? <LoadingCard label="Chargement des espaces…" /> : null}
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Actifs"
            value={tenants.filter((tenant) => tenant.status === "active").length}
            sub="espaces en production"
            accent="green"
          />
          <StatCard
            label="En essai"
            value={tenants.filter((tenant) => tenant.status === "trialing").length}
            sub="à convertir"
            accent="purple"
          />
          <StatCard
            label="Avec doublons"
            value={tenants.filter((tenant) => tenant.duplicates > 0).length}
            sub="à nettoyer"
            accent="amber"
          />
        </div>

        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
                Liste active
              </div>
              <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                Vue compacte des espaces pour orienter un contrôle ou un support.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOnlyDuplicates((value) => !value)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors ${
                onlyDuplicates ? "bg-[#1d4ed8] text-white" : "bg-[#eff6ff] text-[#1d4ed8]"
              }`}
              style={{ fontSize: "0.75rem", fontWeight: 600 }}
            >
              <span
                className={`h-2 w-2 rounded-full ${onlyDuplicates ? "bg-white" : "bg-[#60a5fa]"}`}
                aria-hidden="true"
              />
              {onlyDuplicates ? "Vue doublons active" : "Afficher uniquement les doublons"}
            </button>
          </div>

          <DataTable headers={["Nom", "Abonnement", "Utilisateurs", "Factures", "Doublons", "Actions"]}>
            {filtered.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-center text-[#94a3b8]" colSpan={6} style={{ fontSize: "0.8125rem" }}>
                  Aucun espace à afficher.
                </td>
              </tr>
            ) : (
              filtered.map((tenant) => (
                <tr key={tenant.id} className="transition-colors hover:bg-[#f8fafc]">
                  <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
                    {tenant.name}
                  </td>
                  <td className="px-5 py-3">
                    <StatusPill
                      status={tenant.status === "active" ? "ok" : tenant.status === "trialing" ? "info" : "muted"}
                      label={`${tenant.plan} · ${tenant.status === "active" ? "actif" : tenant.status === "trialing" ? "essai" : "inactif"}`}
                    />
                  </td>
                  <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                    {tenant.users}
                  </td>
                  <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                    {tenant.invoices}
                  </td>
                  <td className="px-5 py-3">
                    {tenant.duplicates > 0 ? (
                      <span
                        className="inline-flex items-center rounded-full border border-[#fde68a] bg-[#fffbeb] px-2 py-0.5 text-[#d97706]"
                        style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                      >
                        {tenant.duplicates}
                      </span>
                    ) : (
                      <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        to={`/app/admin/tenants/${tenant.id}`}
                        className="text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                        style={{ fontSize: "0.75rem", fontWeight: 650 }}
                      >
                        Ouvrir
                      </Link>
                      {tenant.duplicates > 0 ? (
                        <button
                          type="button"
                          disabled
                          title={ADMIN_PREVIEW_ACTION_TITLE}
                          className="inline-flex items-center gap-1 text-[#d97706] opacity-70"
                          style={{ fontSize: "0.75rem", fontWeight: 600 }}
                        >
                          <Trash2 className="h-3 w-3" />
                          Nettoyer
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </DataTable>
        </Card>
      </div>
    </div>
  );
}

export function AdminTenantDetailPage() {
  const { id } = useParams();
  const tenantId = Array.isArray(id) ? id[0] : id;
  const { tenant, loading, error, load } = useAdminTenantDetail(tenantId);
  const statusTone = tenant?.status === "active" ? "ok" : tenant?.status === "trialing" ? "info" : "muted";
  const [chorusTechnicalLogin, setChorusTechnicalLogin] = useState("");
  const [chorusTechnicalPassword, setChorusTechnicalPassword] = useState("");
  const [chorusSaving, setChorusSaving] = useState(false);
  const [chorusVerifying, setChorusVerifying] = useState(false);
  const [chorusRevoking, setChorusRevoking] = useState(false);
  const [chorusActivating, setChorusActivating] = useState(false);
  const [chorusPilotRecipientSiret, setChorusPilotRecipientSiret] = useState("");
  const [chorusConfigured, setChorusConfigured] = useState(false);
  const [chorusVerified, setChorusVerified] = useState(false);
  const [chorusRevoked, setChorusRevoked] = useState(false);
  const [chorusConnectionStatus, setChorusConnectionStatus] = useState("unknown");
  const [chorusVerifiedAt, setChorusVerifiedAt] = useState<string | null>(null);
  const [chorusSummaryLoading, setChorusSummaryLoading] = useState(false);
  const [chorusStructureCount, setChorusStructureCount] = useState<number | null>(null);
  const [chorusError, setChorusError] = useState<string | null>(null);
  const [chorusNotice, setChorusNotice] = useState<string | null>(null);
  const chorusSummaryRequestRef = useRef(0);

  useEffect(() => {
    setChorusTechnicalLogin("");
    setChorusTechnicalPassword("");
    setChorusVerifying(false);
    setChorusRevoking(false);
    setChorusActivating(false);
    setChorusPilotRecipientSiret("");
    setChorusConfigured(false);
    setChorusVerified(false);
    setChorusRevoked(false);
    setChorusConnectionStatus("unknown");
    setChorusVerifiedAt(null);
    setChorusSummaryLoading(false);
    setChorusStructureCount(null);
    setChorusError(null);
    setChorusNotice(null);
  }, [tenantId]);

  const loadChorusSummary = useCallback(async () => {
    if (!tenantId) return;
    const requestId = chorusSummaryRequestRef.current + 1;
    chorusSummaryRequestRef.current = requestId;
    setChorusSummaryLoading(true);
    setChorusError(null);
    try {
      const result: any = await api(
        `/api/platforms/admin/tenants/${encodeURIComponent(tenantId)}/choruspro/connection`,
      );
      if (requestId !== chorusSummaryRequestRef.current) return;
      if (typeof result?.configured !== "boolean") {
        throw new Error("Le statut de la connexion Chorus Pro est incomplet.");
      }
      const connectionStatus = String(result?.status || (result.configured ? "configured" : "missing"))
        .trim()
        .toLowerCase();
      const configured = result.configured === true;
      setChorusConfigured(configured);
      setChorusVerified(configured && ["verified", "connected"].includes(connectionStatus));
      setChorusRevoked(!configured && connectionStatus === "revoked");
      setChorusConnectionStatus(connectionStatus);
      setChorusVerifiedAt(result?.verified_at || null);
      setChorusStructureCount(null);
      if (connectionStatus !== "verified") setChorusPilotRecipientSiret("");
    } catch (err) {
      if (requestId !== chorusSummaryRequestRef.current) return;
      setChorusError(formatApiError(err, "Lecture du statut Chorus Pro impossible."));
    } finally {
      if (requestId === chorusSummaryRequestRef.current) setChorusSummaryLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadChorusSummary();
  }, [loadChorusSummary]);

  const configureChorus = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tenantId || chorusSaving || chorusVerifying || chorusRevoking || chorusActivating || chorusSummaryLoading) {
      return;
    }
    const technicalLogin = chorusTechnicalLogin.trim();
    if (!technicalLogin || !chorusTechnicalPassword) {
      setChorusError("Renseignez le login technique et le mot de passe Chorus Pro.");
      return;
    }
    if (chorusConfigured && !window.confirm("Remplacer les identifiants existants Chorus Pro pour cet espace ?")) {
      return;
    }

    setChorusSaving(true);
    setChorusError(null);
    setChorusNotice(null);
    try {
      const result: any = await api(
        `/api/platforms/admin/tenants/${encodeURIComponent(tenantId)}/choruspro/connection`,
        {
          method: "PUT",
          body: JSON.stringify({
            technical_login: technicalLogin,
            technical_password: chorusTechnicalPassword,
          }),
        },
      );
      const configured = result?.configured === true || String(result?.status || "").toLowerCase() === "configured";
      if (!configured) throw new Error("La configuration Chorus Pro n’a pas été confirmée.");
      setChorusConfigured(true);
      setChorusVerified(false);
      setChorusRevoked(false);
      setChorusConnectionStatus("configured");
      setChorusVerifiedAt(null);
      setChorusStructureCount(null);
      setChorusPilotRecipientSiret("");
      setChorusTechnicalLogin("");
      setChorusNotice(
        "Connexion Chorus Pro configurée pour cet espace. Une vérification reste requise avant tout dépôt.",
      );
    } catch (err) {
      setChorusError(formatApiError(err, "Configuration Chorus Pro impossible."));
    } finally {
      // Le secret reste uniquement en mémoire le temps de la requête.
      setChorusTechnicalPassword("");
      setChorusSaving(false);
    }
  };

  const verifyChorus = async () => {
    if (!tenantId || !chorusConfigured || chorusSaving || chorusVerifying || chorusRevoking || chorusActivating) {
      return;
    }

    setChorusVerifying(true);
    setChorusVerified(false);
    setChorusConnectionStatus("configured");
    setChorusVerifiedAt(null);
    setChorusStructureCount(null);
    setChorusError(null);
    setChorusNotice(null);
    try {
      const result: any = await api(`/api/platforms/admin/tenants/${encodeURIComponent(tenantId)}/choruspro/verify`, {
        method: "POST",
      });
      const structureCount = Number(result?.structure_count);
      const verifiedStatus = String(result?.status || "verified")
        .trim()
        .toLowerCase();
      if (
        result?.verified !== true ||
        !["verified", "connected"].includes(verifiedStatus) ||
        !Number.isInteger(structureCount) ||
        structureCount < 0
      ) {
        throw new Error("La vérification du compte technique n’a pas été confirmée.");
      }
      setChorusVerified(true);
      setChorusConnectionStatus(verifiedStatus);
      setChorusVerifiedAt(result?.updated_at || null);
      setChorusStructureCount(structureCount);
      setChorusPilotRecipientSiret("");
      setChorusNotice(
        verifiedStatus === "connected"
          ? `Compte revérifié — pilote toujours connecté (${structureCount} structure(s) rattachée(s))`
          : `Compte vérifié — ${structureCount} structure(s) rattachée(s)`,
      );
    } catch (err) {
      setChorusError(formatApiError(err, "Vérification du compte technique Chorus Pro impossible."));
    } finally {
      setChorusVerifying(false);
    }
  };

  const revokeChorus = async () => {
    if (!tenantId || !chorusConfigured || chorusSaving || chorusVerifying || chorusRevoking || chorusActivating) {
      return;
    }
    const confirmed = window.confirm(
      "Révoquer les identifiants Chorus Pro de cet espace ? La connexion devra être configurée de nouveau.",
    );
    if (!confirmed) return;

    setChorusRevoking(true);
    setChorusError(null);
    setChorusNotice(null);
    try {
      const result: any = await api(
        `/api/platforms/admin/tenants/${encodeURIComponent(tenantId)}/choruspro/connection`,
        { method: "DELETE" },
      );
      const status = String(result?.status || "")
        .trim()
        .toLowerCase();
      const revoked =
        result?.revoked === true ||
        result?.configured === false ||
        ["revoked", "deleted", "not_configured"].includes(status);
      if (!revoked) throw new Error("La révocation des identifiants Chorus Pro n’a pas été confirmée.");
      setChorusTechnicalLogin("");
      setChorusTechnicalPassword("");
      setChorusConfigured(false);
      setChorusVerified(false);
      setChorusRevoked(true);
      setChorusConnectionStatus("revoked");
      setChorusVerifiedAt(null);
      setChorusStructureCount(null);
      setChorusPilotRecipientSiret("");
      setChorusNotice("Identifiants Chorus Pro révoqués pour cet espace.");
    } catch (err) {
      setChorusError(formatApiError(err, "Révocation des identifiants Chorus Pro impossible."));
    } finally {
      setChorusTechnicalPassword("");
      setChorusRevoking(false);
    }
  };

  const activateChorusPilot = async () => {
    if (
      !tenantId ||
      chorusConnectionStatus !== "verified" ||
      chorusSaving ||
      chorusVerifying ||
      chorusRevoking ||
      chorusActivating
    ) {
      return;
    }
    const recipientSiret = chorusPilotRecipientSiret.replace(/\D+/g, "");
    if (recipientSiret.length !== 14) {
      setChorusError("Renseignez le SIRET destinataire pilote sur 14 chiffres.");
      return;
    }
    const confirmed = window.confirm(
      "Activer le pilote Chorus pour ce destinataire ? Après levée des garde-fous serveur (mode export-only et listes d’autorisation), des dépôts réels pourront être transmis.",
    );
    if (!confirmed) return;

    setChorusActivating(true);
    setChorusError(null);
    setChorusNotice(null);
    try {
      const result: any = await api(
        `/api/platforms/admin/tenants/${encodeURIComponent(tenantId)}/choruspro/pilot/activate`,
        {
          method: "POST",
          body: JSON.stringify({ recipient_siret: recipientSiret }),
        },
      );
      const status = String(result?.status || "")
        .trim()
        .toLowerCase();
      if (status !== "connected" && result?.connected !== true) {
        throw new Error("L’activation du pilote Chorus n’a pas été confirmée.");
      }
      setChorusConfigured(true);
      setChorusVerified(true);
      setChorusRevoked(false);
      setChorusConnectionStatus("connected");
      setChorusPilotRecipientSiret("");
      setChorusNotice("Pilote Chorus connecté. Les dépôts restent soumis aux garde-fous et autorisations du serveur.");
    } catch (err) {
      setChorusError(formatApiError(err, "Activation du pilote Chorus impossible."));
    } finally {
      setChorusActivating(false);
    }
  };

  return (
    <div>
      <AppPageHeader
        title={tenant?.name || "Espace"}
        breadcrumb={`Admin · espace${tenant?.name ? ` · ${tenant.name}` : ""}`}
        backHref="/app/admin/tenants"
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              disabled={chorusSaving || chorusVerifying || chorusRevoking || chorusActivating || chorusSummaryLoading}
              onClick={() => {
                void load();
                void loadChorusSummary();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
            </SecondaryButton>
            <DisabledSecondaryAction>
              <Trash2 className="h-3.5 w-3.5 text-[#d97706]" />
              Nettoyer doublons
            </DisabledSecondaryAction>
            <DisabledPrimaryAction>Passer au plan Pro</DisabledPrimaryAction>
          </div>
        }
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {loading ? <LoadingCard label="Chargement de l’espace…" /> : null}
        {!loading && !tenant ? (
          <EmptyCard title="Espace introuvable" description="Aucune donnée réelle n’est disponible pour cet espace." />
        ) : tenant ? (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <StatCard
                label="Utilisateurs"
                value={tenant.users}
                sub="membres actifs"
                accent="blue"
                icon={<Users className="h-4 w-4" />}
              />
              <StatCard
                label="Factures"
                value={tenant.invoices}
                sub="documents émis"
                accent="green"
                icon={<FileText className="h-4 w-4" />}
              />
              <StatCard
                label="Doublons"
                value={tenant.duplicates}
                sub={tenant.duplicates > 0 ? "à traiter" : "aucun"}
                accent={tenant.duplicates > 0 ? "amber" : undefined}
              />
            </div>

            <Card>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
                  Informations espace
                </h3>
                <StatusPill status={statusTone} label={`${tenant.plan} · ${tenant.status}`} />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {[
                  ["ID espace", tenant.id],
                  ["Plan", tenant.plan],
                  ["Statut", tenant.status],
                  ["Utilisateurs", String(tenant.users)],
                  ["Factures", String(tenant.invoices)],
                  ["Doublons", String(tenant.duplicates)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between border-b border-[#f1f5f9] py-2.5">
                    <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      {label}
                    </span>
                    <span className="font-mono text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
                    Connexion Chorus Pro
                  </h3>
                  <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                    Compte technique dédié à cet espace pilote. Les identifiants ne sont ni relus ni enregistrés dans le
                    navigateur.
                  </p>
                </div>
                <StatusPill
                  status={chorusSummaryLoading ? "muted" : chorusVerified ? "ok" : chorusConfigured ? "warn" : "muted"}
                  label={
                    chorusSummaryLoading
                      ? "Lecture du statut…"
                      : chorusConnectionStatus === "connected"
                        ? "Pilote connecté"
                        : chorusVerified
                          ? "Vérifié, pilote non activé"
                          : chorusConfigured
                            ? "Configuré, vérification requise"
                            : chorusRevoked || chorusConnectionStatus === "missing"
                              ? "Non configuré"
                              : "Statut non vérifié"
                  }
                />
              </div>

              {chorusError ? <NoticeBanner tone="danger">{chorusError}</NoticeBanner> : null}
              {chorusNotice ? <NoticeBanner tone="success">{chorusNotice}</NoticeBanner> : null}

              <form autoComplete="off" className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={configureChorus}>
                <label className="block">
                  <span className="mb-1.5 block text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                    Login technique Chorus Pro
                  </span>
                  <input
                    aria-label="Login technique Chorus Pro"
                    type="password"
                    value={chorusTechnicalLogin}
                    onChange={(event) => setChorusTechnicalLogin(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    data-1p-ignore
                    data-lpignore="true"
                    className="w-full rounded-xl border border-[#dbe4f0] px-3.5 py-2 text-sm text-[#0f172a] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/15"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                    Mot de passe technique Chorus Pro
                  </span>
                  <input
                    aria-label="Mot de passe technique Chorus Pro"
                    type="password"
                    value={chorusTechnicalPassword}
                    onChange={(event) => setChorusTechnicalPassword(event.target.value)}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    data-1p-ignore
                    data-lpignore="true"
                    className="w-full rounded-xl border border-[#dbe4f0] px-3.5 py-2 text-sm text-[#0f172a] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/15"
                  />
                </label>
                <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#f1f5f9] pt-4">
                  <p className="text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                    Cette action configure seulement l’espace. Elle ne teste pas la connexion et ne transmet aucune
                    facture.
                  </p>
                  <PrimaryButton
                    type="submit"
                    disabled={
                      chorusSaving ||
                      chorusVerifying ||
                      chorusRevoking ||
                      chorusActivating ||
                      chorusSummaryLoading ||
                      !tenantId
                    }
                  >
                    <Shield className="h-3.5 w-3.5" /> {chorusSaving ? "Configuration…" : "Configurer Chorus Pro"}
                  </PrimaryButton>
                </div>
              </form>

              {chorusConfigured ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fbff] px-4 py-3">
                  <div>
                    <p className="text-[#1e3a8a]" style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
                      {chorusVerified
                        ? chorusStructureCount !== null
                          ? `Compte vérifié — ${chorusStructureCount} structure(s) rattachée(s)`
                          : `Compte vérifié${
                              chorusVerifiedAt ? ` le ${formatDateTimeFr(chorusVerifiedAt, "date indisponible")}` : ""
                            }`
                        : "Compte configuré, vérification requise"}
                    </p>
                    <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                      {chorusConnectionStatus === "connected"
                        ? "Pilote déjà connecté. Cette vérification reste en lecture seule et ne transmet aucune facture."
                        : "Vérification en lecture seule : aucune facture transmise et aucun pilote activé."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton
                      type="button"
                      onClick={() => void verifyChorus()}
                      disabled={chorusSaving || chorusVerifying || chorusRevoking || chorusActivating}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {chorusVerifying ? "Vérification…" : "Vérifier le compte technique"}
                    </SecondaryButton>
                    <SecondaryButton
                      type="button"
                      onClick={() => void revokeChorus()}
                      disabled={chorusSaving || chorusVerifying || chorusRevoking || chorusActivating}
                      className="border-[#fecaca] text-[#b91c1c] hover:bg-[#fef2f2]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {chorusRevoking ? "Révocation…" : "Révoquer les identifiants Chorus"}
                    </SecondaryButton>
                  </div>
                </div>
              ) : null}

              {chorusConnectionStatus === "verified" ? (
                <div className="mt-4 rounded-xl border border-[#f59e0b] bg-[#fffbeb] px-4 py-4">
                  <div className="flex items-start gap-2 text-[#92400e]">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="text-[0.8125rem] font-bold">Activation du pilote Chorus</p>
                      <p className="mt-1 text-[0.75rem] leading-relaxed">
                        Action de production explicite. Elle ne contourne ni le mode export-only ni les listes
                        d’autorisation : le serveur peut refuser l’activation.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                    <label className="block">
                      <span className="mb-1.5 block text-[0.8125rem] font-semibold text-[#78350f]">
                        SIRET destinataire pilote
                      </span>
                      <input
                        aria-label="SIRET destinataire pilote"
                        value={chorusPilotRecipientSiret}
                        onChange={(event) => {
                          setChorusPilotRecipientSiret(event.target.value.replace(/\D+/g, "").slice(0, 14));
                          setChorusError(null);
                        }}
                        inputMode="numeric"
                        maxLength={14}
                        autoComplete="off"
                        placeholder="12345678901234"
                        className="w-full rounded-xl border border-[#fcd34d] bg-white px-3.5 py-2 text-sm text-[#0f172a] focus:border-[#d97706] focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/20"
                      />
                    </label>
                    <PrimaryButton
                      type="button"
                      onClick={() => void activateChorusPilot()}
                      disabled={chorusActivating || chorusPilotRecipientSiret.length !== 14}
                      className="bg-[#b45309] hover:bg-[#92400e]"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      {chorusActivating ? "Activation…" : "Activer le pilote Chorus"}
                    </PrimaryButton>
                  </div>
                </div>
              ) : null}
            </Card>

            {tenant.duplicates > 0 ? (
              <NoticeBanner variant="warn" title={`${tenant.duplicates} doublon(s) détecté(s)`}>
                Des clients semblent en double. L’action de fusion reste neutralisée tant que le module d’administration
                complet n’est pas activé.
              </NoticeBanner>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function AdminReadinessPage() {
  const [payload, setPayload] = useState<any>(null);
  const [stripe, setStripe] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [readinessResult, stripeResult] = await Promise.all([
        api("/api/diagnostic/readiness"),
        api("/api/diagnostic/stripe").catch(() => null),
      ]);
      setPayload(readinessResult || null);
      setStripe(stripeResult || null);
    } catch (err) {
      setPayload(null);
      setStripe(null);
      setError(formatApiError(err, "Impossible de charger les preuves de préparation."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checks = diagnosticRows({
    ...(payload?.checks || {}),
    ...(stripe ? { stripe } : {}),
  });
  const issueCount = checks.filter((check) => check.status !== "ok").length;
  const generatedAt = payload?.generated_at ? new Date(payload.generated_at).toLocaleString("fr-FR") : null;

  return (
    <div>
      <AppPageHeader
        title="Préparation plateforme"
        breadcrumb="Admin · préparation"
        description="Contrôles clés avant ouverture."
        actions={
          <SecondaryButton type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
            {loading ? "Contrôle…" : "Rafraîchir"}
          </SecondaryButton>
        }
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {loading ? <LoadingCard label="Exécution des diagnostics serveur…" /> : null}
        {!loading && checks.length === 0 ? (
          <NoticeBanner tone="danger">
            Aucune preuve serveur disponible. Cet écran ne peut pas conclure à un GO.
          </NoticeBanner>
        ) : null}
        {issueCount > 0 ? (
          <NoticeBanner variant="warn" title="Ouverture non démontrée">
            {issueCount} contrôle(s) ne sont pas au vert. Un badge de cet écran ne remplace pas le préflight, les tests
            de restauration ni la validation de release.
          </NoticeBanner>
        ) : null}
        {generatedAt ? (
          <p className="text-xs text-[#64748b]">Mesure serveur générée le {generatedAt}. Valeurs non mises en cache.</p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Contrôles"
            value={checks.length}
            sub="mesures serveur reçues"
            accent="blue"
            icon={<Shield className="h-4 w-4" />}
          />
          <StatCard
            label="OK"
            value={checks.filter((check) => check.status === "ok").length}
            sub="mesurés au vert"
            accent="green"
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
          <StatCard
            label="À revoir"
            value={issueCount}
            sub="avertissement(s) ou échec(s)"
            accent="amber"
            icon={<TriangleAlert className="h-4 w-4" />}
          />
        </div>

        <Card>
          <div className="divide-y divide-[#f1f5f9]">
            {checks.map((check) => (
              <div key={check.key} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div>
                  <h3 className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    {check.label}
                  </h3>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {check.detail}
                  </p>
                </div>
                <StatusPill
                  status={check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "danger"}
                  label={check.status === "ok" ? "Mesuré OK" : check.status === "warn" ? "Avertissement" : "Échec"}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function AdminDeploymentPage() {
  const [payload, setPayload] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload((await api("/api/diagnostic/deployment")) || null);
    } catch (err) {
      setPayload(null);
      setError(formatApiError(err, "Impossible de charger le diagnostic de déploiement."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const services = diagnosticRows(payload?.checks);
  const issueCount = services.filter((service) => service.status !== "ok").length;
  const generatedAt = payload?.generated_at ? new Date(payload.generated_at).toLocaleString("fr-FR") : null;

  return (
    <div>
      <AppPageHeader
        title="Déploiement"
        breadcrumb="Admin · déploiement"
        description="État infra avant diagnostic détaillé."
        actions={
          <SecondaryButton type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
            {loading ? "Contrôle…" : "Rafraîchir"}
          </SecondaryButton>
        }
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {loading ? <LoadingCard label="Exécution des diagnostics d’infrastructure…" /> : null}
        {generatedAt ? <p className="text-xs text-[#64748b]">Mesure serveur générée le {generatedAt}.</p> : null}
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Services" value={services.length} sub="briques suivies" accent="blue" />
          <StatCard
            label="Sains"
            value={services.filter((service) => service.status === "ok").length}
            sub="prêts"
            accent="green"
          />
          <StatCard label="À surveiller" value={issueCount} sub="requièrent une revue" accent="amber" />
        </div>

        <Card>
          <div className="divide-y divide-[#f1f5f9]">
            {services.map((service) => (
              <div key={service.key} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div>
                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    {service.label}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {service.detail}
                  </p>
                </div>
                <StatusPill
                  status={service.status === "ok" ? "ok" : service.status === "warn" ? "warn" : "danger"}
                  label={service.status === "ok" ? "Mesuré OK" : service.status === "warn" ? "Attention" : "Échec"}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function AdminLegalPackPage() {
  const docs = [
    { label: "Conditions générales d’utilisation", ext: "Page web", meta: "Référence produit" },
    { label: "Conditions générales de vente", ext: "Page web", meta: "Version commerciale" },
    { label: "Accord de traitement des données", ext: "Page web", meta: "Conformité RGPD" },
    { label: "Politique de confidentialité", ext: "Page web", meta: "Publication publique" },
    { label: "Politique cookies", ext: "Page web", meta: "Référentiel consentement" },
  ];

  return (
    <div>
      <AppPageHeader
        title="Dossier légal"
        breadcrumb="Admin · dossier légal"
        description="Documents réglementaires et exports juridiques."
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Documents"
            value={docs.length}
            sub="dossier actif"
            accent="blue"
            icon={<Scale className="h-4 w-4" />}
          />
          <StatCard
            label="Formats"
            value="Web"
            sub="versions publiées"
            accent="purple"
            icon={<FileText className="h-4 w-4" />}
          />
          <StatCard
            label="Statut"
            value="À valider"
            sub="aucune preuve automatisée"
            accent="amber"
            icon={<TriangleAlert className="h-4 w-4" />}
          />
        </div>

        <NoticeBanner tone="warning">
          Cette liste décrit les pages juridiques attendues ; elle ne prouve ni leur validation par un conseil, ni la
          présence des versions PDF signées. Les exports restent volontairement désactivés.
        </NoticeBanner>

        <Card className="space-y-2">
          {docs.map((doc) => (
            <div
              key={doc.label}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#f1f5f9] px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#eff6ff]">
                  <Scale className="h-4 w-4 text-[#1d4ed8]" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    {doc.label}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                      {doc.meta}
                    </span>
                    <StatusPill status="muted" label={doc.ext} />
                    <StatusPill status="warn" label="Validation requise" />
                  </div>
                </div>
              </div>
              <DisabledSecondaryAction className="!px-3 !py-1.5 !text-xs">Exporter</DisabledSecondaryAction>
            </div>
          ))}

          <div className="flex flex-wrap gap-2 pt-3">
            <DisabledPrimaryAction>Télécharger en Markdown</DisabledPrimaryAction>
            <DisabledSecondaryAction>Copier le Markdown</DisabledSecondaryAction>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function AdminUsageSeqinoPage() {
  const defaultPeriod = new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState(defaultPeriod);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api("/api/admin/usage/seqino?period=" + encodeURIComponent(period));
      setRows(Array.isArray(payload?.items) ? payload.items : []);
    } catch (err) {
      setRows([]);
      setError(formatApiError(err, "Impossible de charger les usages Seqino."));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const invoiceTotal = rows.reduce((total, row) => total + Number(row?.invoice_count || 0), 0);
  const ereportingTotal = rows.reduce((total, row) => total + Number(row?.reporting_count || 0), 0);
  const activeTenants = rows.filter(
    (row) => Number(row?.invoice_count || 0) + Number(row?.reporting_count || 0) > 0,
  ).length;
  const formatCost = (value: any) => {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount) || amount <= 0) return "—";
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(amount);
  };

  return (
    <div>
      <AppPageHeader
        title="Usage Seqino"
        breadcrumb="Admin · usage PA"
        description="Volumes mensuels réels par espace."
        actions={
          <SecondaryButton type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
            Actualiser
          </SecondaryButton>
        }
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Factures transmises"
            value={invoiceTotal}
            sub="période sélectionnée"
            accent="blue"
            icon={<FileText className="h-4 w-4" />}
          />
          <StatCard
            label="E-reporting"
            value={ereportingTotal}
            sub="période sélectionnée"
            accent="green"
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <StatCard
            label="Espaces actifs"
            value={activeTenants}
            sub="avec transmissions"
            accent="cyan"
            icon={<Building2 className="h-4 w-4" />}
          />
        </div>

        <Card className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
                Lecture mensuelle
              </div>
              <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                Volumes Seqino par espace. Les coûts restent estimatifs selon la configuration.
              </p>
            </div>
            <div className="w-full max-w-[220px]">
              <label className="mb-1.5 block text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                Période
              </label>
              <input
                type="month"
                value={period}
                onChange={(event) => setPeriod(event.target.value || defaultPeriod)}
                className="w-full rounded-xl border border-[#dbe4f0] px-3.5 py-2 text-sm text-[#0f172a] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/15"
              />
            </div>
          </div>

          {loading ? (
            <LoadingCard label="Chargement des usages…" />
          ) : rows.length > 0 ? (
            <DataTable headers={["Espace", "Factures", "E-reporting", "Coût estimé"]}>
              {rows.map((row) => (
                <tr key={row.tenant_id || row.tenant_name} className="transition-colors hover:bg-[#f8fafc]">
                  <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                    {row.tenant_name || "Espace sans nom"}
                  </td>
                  <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                    {Number(row.invoice_count || 0)}
                  </td>
                  <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                    {Number(row.reporting_count || 0)}
                  </td>
                  <td className="px-5 py-3 text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    {formatCost(row.estimated_cost_eur)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-[#eef2f7] bg-[#fbfdff]">
                <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                  Total
                </td>
                <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                  {invoiceTotal}
                </td>
                <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                  {ereportingTotal}
                </td>
                <td className="px-5 py-3 text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  —
                </td>
              </tr>
            </DataTable>
          ) : (
            <EmptyCard
              title="Aucune donnée"
              description="Aucune transmission disponible pour la période sélectionnée."
              compact
            />
          )}
        </Card>
      </div>
    </div>
  );
}

export function AdminDiagnosticPage() {
  const checks = [
    {
      label: "Origin navigateur",
      value: typeof window !== "undefined" ? window.location.origin : "—",
      status: "info" as const,
      badge: "origine",
    },
    { label: "Adresse de service", value: "/api", status: "muted" as const, badge: "préfixe" },
    { label: "COOKIE_SAMESITE", value: "lax", status: "ok" as const, badge: "cookie" },
    { label: "COOKIE_SECURE", value: "true", status: "ok" as const, badge: "sécurité" },
    {
      label: "HTTPS",
      value: typeof window !== "undefined" ? window.location.protocol : "—",
      status: "ok" as const,
      badge: "transport",
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="État de session"
        breadcrumb="Admin · diagnostic"
        description={"Session, cookies et accès sécurisé côté navigateur."}
      />
      <div className="w-full space-y-4 p-5 lg:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Transport"
            value="HTTPS"
            sub="côté navigateur"
            accent="blue"
            icon={<Shield className="h-4 w-4" />}
          />
          <StatCard
            label="Cookie secure"
            value="Actif"
            sub="cookie protégé"
            accent="green"
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
          <StatCard
            label="API"
            value="/api"
            sub="prefixe attendu"
            accent="purple"
            icon={<Activity className="h-4 w-4" />}
          />
        </div>

        <Card>
          <h3 className="mb-4 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 650 }}>
            Résumé configuration
          </h3>
          <div className="divide-y divide-[#f1f5f9]">
            {checks.map((check) => (
              <div key={check.label} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    {check.label}
                  </span>
                  <StatusPill status={check.status} label={check.badge} />
                </div>
                <span className="font-mono text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                  {check.value}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
