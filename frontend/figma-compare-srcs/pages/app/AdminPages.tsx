import { useState } from "react";
import { Link, useParams } from "react-router";
import { motion } from "motion/react";
import {
  AppPageHeader,
  StatusPill,
  StatCard,
  DataTable,
  PrimaryButton,
  SecondaryButton,
  Card,
  NoticeBanner,
  EmptyCard,
} from "../../components/app/AppPageHeader";
import {
  Building2,
  Scale,
  BarChart3,
  RefreshCw,
  CheckCircle2,
  Shield,
  AlertTriangle,
  Activity,
  Gauge,
  Layers,
  Trash2,
  Users,
  FileText,
} from "lucide-react";

const tenants = [
  { id: "t1", name: "Espace principal", plan: "pro", status: "active", users: 3, invoices: 12, duplicates: 0 },
  { id: "t2", name: "Acme Corp", plan: "starter", status: "active", users: 1, invoices: 5, duplicates: 2 },
  { id: "t3", name: "Tech Solutions", plan: "pro", status: "trialing", users: 2, invoices: 0, duplicates: 0 },
  { id: "t4", name: "StartupXYZ", plan: "starter", status: "inactive", users: 1, invoices: 3, duplicates: 1 },
];

export function AdminDashboardPage() {
  const cards = [
    {
      href: "/app/admin/tenants",
      icon: Building2,
      label: "Espaces",
      desc: "Lister, ouvrir et nettoyer les doublons.",
      color: "#1d4ed8",
      bg: "#eff6ff",
    },
    {
      href: "/app/admin/readiness",
      icon: Gauge,
      label: "Préparation",
      desc: "Vérifications critiques avant ouverture commerciale.",
      color: "#059669",
      bg: "#ecfdf5",
    },
    {
      href: "/app/admin/deployment",
      icon: Layers,
      label: "Déploiement",
      desc: "Base de données, cache, stockage, emails, paiement et PDF/A.",
      color: "#7c3aed",
      bg: "#f5f3ff",
    },
    {
      href: "/app/admin/legal-pack",
      icon: Scale,
      label: "Dossier légal",
      desc: "Export CGU, CGV, DPA et sous-traitants.",
      color: "#d97706",
      bg: "#fffbeb",
    },
    {
      href: "/app/admin/usage-pdp",
      icon: BarChart3,
      label: "Usage plateforme partenaire",
      desc: "Suivi transmissions et coûts estimés par espace.",
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
        title="Administration plateforme"
        breadcrumb="Admin"
        description="Vue rapide des stats plateforme et accès aux outils de gestion."
      />
      <div className="p-6 lg:p-8 space-y-6">
        <NoticeBanner variant="warn" title="Accès restreint">
          Cette section est réservée aux administrateurs de la plateforme. Les actions sont auditées.
        </NoticeBanner>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <StatCard
            label="Espaces actifs"
            value={tenants.filter((t) => t.status === "active").length}
            sub="Sur 4 totaux"
            accent="blue"
            icon={<Building2 className="w-4 h-4" />}
          />
          <StatCard
            label="Utilisateurs"
            value="7"
            sub="Total plateforme"
            accent="green"
            icon={<Users className="w-4 h-4" />}
          />
          <StatCard
            label="Factures"
            value="20"
            sub="Tous espaces"
            accent="purple"
            icon={<FileText className="w-4 h-4" />}
          />
          <StatCard
            label="Doublons"
            value="3"
            sub="À nettoyer"
            accent="amber"
            icon={<AlertTriangle className="w-4 h-4" />}
          />
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((card, i) => (
            <motion.div
              key={card.href}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
            >
              <Link
                to={card.href}
                className="block bg-white rounded-2xl p-5 hover:-translate-y-0.5 transition-all group"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: card.bg }}
                  >
                    <card.icon className="w-5 h-5" style={{ color: card.color, strokeWidth: 1.8 }} />
                  </div>
                  <span
                    className="text-[#1d4ed8] opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ fontSize: "0.75rem", fontWeight: 500 }}
                  >
                    Ouvrir →
                  </span>
                </div>
                <h3 className="text-[#0f172a] mb-1" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                  {card.label}
                </h3>
                <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                  {card.desc}
                </p>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AdminTenantsPage() {
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const filtered = onlyDuplicates ? tenants.filter((t) => t.duplicates > 0) : tenants;

  return (
    <div>
      <AppPageHeader
        title="Espaces"
        breadcrumb="Administration · espaces"
        description="Lister, ouvrir et nettoyer les doublons clients."
      />
      <div className="p-6 lg:p-8 space-y-4">
        <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
          <div
            onClick={() => setOnlyDuplicates((o) => !o)}
            className={`w-8 h-4.5 rounded-full transition-colors relative cursor-pointer ${onlyDuplicates ? "bg-[#1d4ed8]" : "bg-[#e2e8f0]"}`}
          >
            <div
              className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${onlyDuplicates ? "translate-x-3.5" : "translate-x-0.5"}`}
            />
          </div>
          <span className="text-[#374151]" style={{ fontSize: "0.8125rem" }}>
            Afficher uniquement ceux avec doublons
          </span>
        </label>

        <DataTable headers={["Nom", "Abonnement", "Utilisateurs", "Factures", "Doublons", "Actions"]}>
          {filtered.map((t) => (
            <tr key={t.id} className="hover:bg-[#f8fafc] transition-colors">
              <td className="px-5 py-3 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                {t.name}
              </td>
              <td className="px-5 py-3">
                <StatusPill
                  status={t.status === "active" ? "ok" : t.status === "trialing" ? "info" : "muted"}
                  label={`${t.plan} · ${t.status === "active" ? "actif" : t.status === "trialing" ? "essai" : "inactif"}`}
                />
              </td>
              <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                {t.users}
              </td>
              <td className="px-5 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                {t.invoices}
              </td>
              <td className="px-5 py-3">
                {t.duplicates > 0 ? (
                  <span
                    className="px-2 py-0.5 rounded-full bg-[#fffbeb] text-[#d97706] border border-[#fde68a]"
                    style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                  >
                    {t.duplicates}
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
                    to={`/app/admin/tenants/${t.id}`}
                    className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
                    style={{ fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    Ouvrir
                  </Link>
                  {t.duplicates > 0 && (
                    <button
                      className="text-[#d97706] hover:text-[#b45309] transition-colors flex items-center gap-1"
                      style={{ fontSize: "0.75rem", fontWeight: 500 }}
                    >
                      <Trash2 className="w-3 h-3" /> Nettoyer
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}

export function AdminTenantDetailPage() {
  const { id } = useParams();
  const t = tenants.find((x) => x.id === id) || tenants[0];
  const statusColor =
    t.status === "active" ? ("ok" as const) : t.status === "trialing" ? ("info" as const) : ("muted" as const);
  return (
    <div>
      <AppPageHeader
        title={t.name}
        breadcrumb={`Administration · Tenants · ${t.name}`}
        backHref="/app/admin/tenants"
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <Trash2 className="w-3.5 h-3.5 text-[#d97706]" /> Nettoyer doublons
            </SecondaryButton>
            <PrimaryButton style={{ background: "linear-gradient(135deg,#059669,#0d9488)" }}>
              Passer au plan Pro
            </PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <div className="grid md:grid-cols-3 gap-4">
          <StatCard
            label="Utilisateurs"
            value={t.users}
            sub="Membres actifs"
            accent="blue"
            icon={<Users className="w-4 h-4" />}
          />
          <StatCard
            label="Factures"
            value={t.invoices}
            sub="Total émis"
            accent="green"
            icon={<FileText className="w-4 h-4" />}
          />
          <StatCard
            label="Doublons clients"
            value={t.duplicates}
            sub={t.duplicates > 0 ? "À nettoyer" : "Aucun"}
            accent={t.duplicates > 0 ? "amber" : undefined}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
              Informations espace
            </h3>
            <StatusPill status={statusColor} label={`${t.plan} · ${t.status}`} />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              ["ID espace", t.id],
              ["Abonnement", t.plan],
              ["Statut", t.status],
              ["Utilisateurs", String(t.users)],
              ["Factures émises", String(t.invoices)],
              ["Doublons clients", String(t.duplicates)],
            ].map(([k, v]) => (
              <div key={k} className="py-2 border-b border-[#f8fafc] flex items-center justify-between">
                <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  {k}
                </span>
                <span className="text-[#374151] font-mono" style={{ fontSize: "0.8125rem" }}>
                  {v}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {t.duplicates > 0 && (
          <NoticeBanner variant="warn" title={`${t.duplicates} doublon(s) détecté(s)`}>
            Des clients semblent en double (même email, SIRET ou TVA). Utilisez le bouton "Nettoyer doublons" pour les
            supprimer.
          </NoticeBanner>
        )}
      </div>
    </div>
  );
}

export function AdminReadinessPage() {
  const checks = [
    { key: "smtp", label: "Emails transactionnels", status: "ok" },
    { key: "storage", label: "Stockage fichiers", status: "ok" },
    { key: "seqino", label: "PA partenaire", status: "warn" },
    { key: "auth", label: "Cookies & CORS", status: "ok" },
    { key: "stripe", label: "Paiement abonnements", status: "ok" },
    { key: "pdfa", label: "Génération PDF/A", status: "warn" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Préparation plateforme"
        breadcrumb="Administration · Préparation"
        description="Vérifiez la configuration critique avant activation commerciale."
        actions={
          <SecondaryButton>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5 max-w-3xl">
        {checks.some((c) => c.status === "warn") && (
          <NoticeBanner variant="warn" title="Avertissements détectés">
            Certains services ne sont pas entièrement configurés. Vérifiez avant ouverture commerciale.
          </NoticeBanner>
        )}
        <Card>
          <div className="divide-y divide-[#f8fafc]">
            {checks.map((c) => (
              <div key={c.key} className="flex items-center justify-between py-3">
                <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                  {c.label}
                </span>
                <div className="flex items-center gap-2">
                  {c.status === "ok" ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-[#16a34a]" />
                      <StatusPill status="ok" label="OK" />
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-4 h-4 text-[#d97706]" />
                      <StatusPill status="warn" label="À configurer" />
                    </>
                  )}
                </div>
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
    { label: "Conditions Générales d'Utilisation (CGU)", ext: "PDF" },
    { label: "Conditions Générales de Vente (CGV)", ext: "PDF" },
    { label: "Accord de Traitement des Données (DPA)", ext: "PDF" },
    { label: "Liste des sous-traitants", ext: "CSV" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Dossier légal"
        breadcrumb="Administration · Dossier légal"
        description="Export rapide des mentions légales, CGU/CGV, DPA et sous-traitants."
      />
      <div className="p-6 lg:p-8 max-w-2xl space-y-4">
        {docs.map((doc) => (
          <div
            key={doc.label}
            className="flex items-center justify-between p-4 bg-white rounded-2xl"
            style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#eff6ff] flex items-center justify-center flex-shrink-0">
                <Scale className="w-4 h-4 text-[#1d4ed8]" />
              </div>
              <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                {doc.label}
              </span>
            </div>
            <button
              className="px-3 py-1.5 rounded-xl text-[#1d4ed8] bg-[#eff6ff] hover:bg-[#dbeafe] transition-colors flex-shrink-0"
              style={{ fontSize: "0.75rem", fontWeight: 600 }}
            >
              Exporter {doc.ext}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/admin/deployment
════════════════════════════════════════════════════════════ */
export function AdminDeploymentPage() {
  const services = [
    { key: "db", label: "Base de données", status: "ok", detail: "PostgreSQL 15 · latence 4ms" },
    { key: "redis", label: "Redis", status: "ok", detail: "v7.2 · mémoire 42%" },
    { key: "storage", label: "Stockage", status: "warn", detail: "S3-compatible · quota 78%" },
    { key: "smtp", label: "Emails transactionnels", status: "ok", detail: "Configurer l’adresse de réponse" },
    { key: "stripe", label: "Paiement abonnements", status: "ok", detail: "Clé active configurée" },
    { key: "pdfa", label: "Génération PDF/A", status: "warn", detail: "outil de conversion non configuré" },
  ];

  return (
    <div>
      <AppPageHeader
        title="Statut de déploiement"
        breadcrumb="Administration · Déploiement"
        description="Vérifications clés pour éviter les incidents en production."
        actions={
          <SecondaryButton>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5 max-w-3xl">
        {services.some((s) => s.status === "warn") && (
          <NoticeBanner variant="warn" title="Avertissements à corriger">
            Certains services nécessitent une attention avant ouverture commerciale.
          </NoticeBanner>
        )}
        <Card>
          <div className="divide-y divide-[#f8fafc]">
            {services.map((s) => (
              <div key={s.key} className="flex items-center justify-between py-3.5">
                <div>
                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    {s.label}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {s.detail}
                  </p>
                </div>
                <StatusPill status={s.status === "ok" ? "ok" : "warn"} label={s.status === "ok" ? "OK" : "Attention"} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/admin/usage-pdp
════════════════════════════════════════════════════════════ */
export function AdminUsageSeqinoPage() {
  const rows = [
    { tenant: "Espace A", invoices: 48, ereporting: 12, cost: "—" },
    { tenant: "Espace B", invoices: 12, ereporting: 3, cost: "—" },
    { tenant: "Espace C", invoices: 0, ereporting: 0, cost: "—" },
  ];

  return (
    <div>
      <AppPageHeader
        title="Usage plateforme partenaire"
        breadcrumb="Administration · Usage"
        description="Suivi mensuel des flux et estimation de coût par espace."
        actions={
          <SecondaryButton>
            <RefreshCw className="w-3.5 h-3.5" /> Actualiser
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <NoticeBanner variant="info">
          Les coûts estimés sont calculés sur la base des tarifs PDP en vigueur. Contactez votre CSM pour un devis
          précis.
        </NoticeBanner>
        <div className="grid grid-cols-3 gap-4">
          <StatCard
            label="Factures transmises"
            value={rows.reduce((s, r) => s + r.invoices, 0)}
            sub="Ce mois"
            accent="blue"
          />
          <StatCard
            label="E-reporting"
            value={rows.reduce((s, r) => s + r.ereporting, 0)}
            sub="Ce mois"
            accent="green"
          />
          <StatCard label="Espaces actifs" value={rows.filter((r) => r.invoices > 0).length} sub="Avec flux" />
        </div>
        <DataTable headers={["Espace", "Factures", "E-reporting", "Coût estimé"]}>
          {rows.map((r) => (
            <tr key={r.tenant} className="hover:bg-[#f8fafc] transition-colors">
              <td className="px-5 py-3 text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                {r.tenant}
              </td>
              <td className="px-5 py-3 text-[#64748b]" style={{ fontSize: "0.875rem" }}>
                {r.invoices}
              </td>
              <td className="px-5 py-3 text-[#64748b]" style={{ fontSize: "0.875rem" }}>
                {r.ereporting}
              </td>
              <td className="px-5 py-3 text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                {r.cost}
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/admin/diagnostic
════════════════════════════════════════════════════════════ */
export function AdminDiagnosticPage() {
  const checks = [
    { label: "Cookies SameSite", value: "Lax (dev) / None (prod)", ok: true },
    { label: "HTTPS origin", value: typeof window !== "undefined" ? window.location.protocol : "—", ok: true },
    { label: "CORS origins", value: "Configuré serveur", ok: true },
    { label: "Jeton de sécurité", value: "Présent", ok: true },
    {
      label: "User Agent",
      value: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) + "…" : "—",
      ok: true,
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="État de session"
        breadcrumb="Administration · Contrôles support"
        description="Session, accès et configuration pour l’aide support."
      />
      <div className="p-6 lg:p-8 max-w-2xl">
        <Card>
          <div className="divide-y divide-[#f8fafc]">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between py-3">
                <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                  {c.label}
                </span>
                <span className="text-[#64748b] font-mono text-right max-w-xs truncate" style={{ fontSize: "0.75rem" }}>
                  {c.value}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
