import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import {
  AppPageHeader,
  StatusPill,
  StatCard,
  DataTable,
  PrimaryButton,
  SecondaryButton,
  Card,
} from "../../components/app/AppPageHeader";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { useSession } from "@/lib/useSession";
import {
  Plus,
  Users,
  FileText,
  CheckCircle,
  Circle,
  ArrowRight,
  Send,
  CheckCircle2,
  Building2,
  Zap,
  ArrowUpRight,
  Star,
  Sparkles,
  CreditCard,
  Package,
  ChevronRight,
  Lock,
  Mail,
  Phone,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";

function deriveAccountIdentity(user: any) {
  const explicit = String(user?.name || user?.full_name || user?.display_name || "").trim();
  const composed = [user?.first_name, user?.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const email = String(user?.email || "").trim();
  const fallback = (email.split("@")[0] || "mon compte")
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const name = explicit || composed || fallback || "Mon compte";
  const parts = name.split(/\s+/g).filter(Boolean);
  const firstName = String(user?.first_name || parts[0] || "").trim();
  const lastName = String(user?.last_name || parts.slice(1).join(" ") || "").trim();
  const initials =
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
      .slice(0, 2) || "MC";

  return {
    name,
    firstName: firstName || "Non renseigné",
    lastName: lastName || "Non renseigné",
    initials,
    email: email || "Non renseigné",
    phone: String(user?.phone || user?.telephone || "").trim() || "Non renseigné",
  };
}

function roleLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    owner: "Propriétaire",
    admin: "Administrateur",
    accountant: "Comptable",
    sales: "Commercial",
    viewer: "Lecture seule",
    client: "Client",
  };
  const key = String(value || "").toLowerCase();
  return labels[key] || value || "Compte";
}

function AccountInfoSection({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: ReactNode; icon?: ReactNode; href?: string }>;
}) {
  return (
    <Card className="overflow-hidden" padding={false}>
      <div className="border-b border-[#edf2f7] bg-[#f8fafc] px-4 py-3">
        <p
          className="text-[#94a3b8]"
          style={{
            fontSize: "var(--pf-app-text-overline)",
            fontWeight: 800,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </p>
      </div>
      <div>
        {rows.map((row, index) => {
          const content = (
            <>
              <div className="min-w-0 text-[#64748b]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                {row.label}
              </div>
              <div className="flex min-w-0 items-center gap-2 text-right">
                <div
                  className="min-w-0 flex-1 truncate text-[#0f172a]"
                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                >
                  {row.value}
                </div>
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[#cbd5e1]">
                  {row.icon || <Settings className="h-3.5 w-3.5" style={{ strokeWidth: 1.8 }} />}
                </span>
              </div>
            </>
          );
          const className = `grid grid-cols-[minmax(0,1fr)_minmax(160px,1.5fr)] items-center gap-3 px-4 py-3 ${
            index > 0 ? "border-t border-[#f1f5f9]" : ""
          }`;
          return row.href ? (
            <Link key={row.label} to={row.href} className={`${className} transition-colors hover:bg-[#f8fafc]`}>
              {content}
            </Link>
          ) : (
            <div key={row.label} className={className}>
              {content}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function AccountPage() {
  const { user, plan } = useSession();
  const identity = deriveAccountIdentity(user);
  const planText = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Starter";
  const roleText = roleLabel(user?.role);

  return (
    <div>
      <AppPageHeader title="Mon compte" breadcrumb="Compte" description="Informations personnelles" />
      <div className="px-4 pb-8 pt-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[560px] space-y-4">
          <Card className="flex items-center gap-4 p-4">
            <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#4f46e5] to-[#7c3aed] shadow-[0_10px_24px_rgba(79,70,229,0.22)]">
              <span className="text-white" style={{ fontSize: "1.1rem", fontWeight: 850 }}>
                {identity.initials}
              </span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                {identity.name}
              </p>
              <p className="truncate text-[#64748b]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                {identity.email} · {roleText} · {planText}
              </p>
            </div>
          </Card>

          <AccountInfoSection
            title="Informations"
            rows={[
              { label: "Prénom", value: identity.firstName, icon: <UserRound className="h-3.5 w-3.5" /> },
              { label: "Nom", value: identity.lastName, icon: <UserRound className="h-3.5 w-3.5" /> },
              { label: "Email", value: identity.email, icon: <Mail className="h-3.5 w-3.5" /> },
              { label: "Téléphone", value: identity.phone, icon: <Phone className="h-3.5 w-3.5" /> },
            ]}
          />

          <AccountInfoSection
            title="Sécurité"
            rows={[
              {
                label: "Mot de passe",
                value: "••••••••",
                href: "/app/settings/security",
                icon: <Lock className="h-3.5 w-3.5" />,
              },
              {
                label: "2FA",
                value: user?.mfa_enabled ? "Activée" : "Désactivée",
                href: "/app/settings/security",
                icon: <ShieldCheck className="h-3.5 w-3.5" />,
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

export function AuditPage() {
  const entries = [
    {
      id: "a1",
      date: "Aujourd'hui 14:32",
      action: "send_email",
      entity: "invoice",
      actor: "utilisateur",
      payload: '{"invoice":"FAC-2026-012"}',
    },
    {
      id: "a2",
      date: "Aujourd'hui 10:15",
      action: "create",
      entity: "invoice",
      actor: "utilisateur",
      payload: '{"number":"FAC-2026-012"}',
    },
    {
      id: "a3",
      date: "Hier 16:00",
      action: "update",
      entity: "customer",
      actor: "utilisateur",
      payload: '{"field":"email"}',
    },
    {
      id: "a4",
      date: "Hier 09:30",
      action: "create",
      entity: "quote",
      actor: "utilisateur",
      payload: '{"number":"DEV-2026-003"}',
    },
  ];
  return (
    <div>
      <AppPageHeader
        title="Journal d'actions"
        breadcrumb="Paramètres > Audit"
        description="Actions horodatées, filtrables et masquées côté PII."
      />
      <div className="p-6 lg:p-8 space-y-4">
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="ex: create, send_email"
            className="px-3.5 py-2 border border-[#d1d5db] rounded-lg placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
            style={{ fontSize: "0.8125rem" }}
          />
          <input
            placeholder="ex: invoice, payment"
            className="px-3.5 py-2 border border-[#d1d5db] rounded-lg placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
            style={{ fontSize: "0.8125rem" }}
          />
          <PrimaryButton>Filtrer</PrimaryButton>
          <SecondaryButton>Réinitialiser</SecondaryButton>
        </div>
        <div className="text-[#9ca3af]" style={{ fontSize: "0.75rem" }}>
          {entries.length} entrée(s)
        </div>
        <DataTable headers={["Date", "Action", "Entité", "Acteur", "Payload"]}>
          {entries.map((e) => (
            <tr key={e.id} className="hover:bg-[#f9fafb]/60 transition-colors">
              <td className="px-4 py-2.5 text-[#374151]" style={{ fontSize: "0.75rem" }}>
                {e.date}
              </td>
              <td className="px-4 py-2.5">
                <StatusPill status="muted" label={e.action} />
              </td>
              <td className="px-4 py-2.5 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                {e.entity}
              </td>
              <td className="px-4 py-2.5 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                {e.actor}
              </td>
              <td
                className="px-4 py-2.5 text-[#9ca3af] font-mono max-w-[200px] truncate"
                style={{ fontSize: "0.6875rem" }}
              >
                {e.payload}
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}

export function TeamPage() {
  const roleLabels: Record<string, string> = {
    owner: "Propriétaire",
    admin: "Admin",
    accountant: "Comptable",
    sales: "Commercial",
    viewer: "Lecture seule",
  };
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("accountant");
  const [inviteBusy, setInviteBusy] = useState(false);

  const loadMembers = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await rawApi("/api/users");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(data, res.status, "Impossible de charger l'équipe."));
      }
      const data = await res.json().catch(() => []);
      setMembers(Array.isArray(data) ? data : []);
    } catch (err) {
      setMembers([]);
      setError(formatApiError(err, "Impossible de charger l'équipe."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMembers();
  }, []);

  const sendInvite = async () => {
    setInviteBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/users/invites", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setNotice(inviteRole === "accountant" ? "Invitation comptable envoyée." : "Invitation envoyée.");
      setInviteEmail("");
      setInviteRole("accountant");
      setInviteOpen(false);
      await loadMembers();
    } catch (err) {
      setError(formatApiError(err, "Invitation impossible."));
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Équipe & comptable"
        breadcrumb="Compte > Équipe"
        description="Invitez votre comptable ou vos collaborateurs. Ils créent leur compte depuis l'invitation et rejoignent cet espace avec le bon rôle."
        actions={
          <PrimaryButton onClick={() => setInviteOpen((v) => !v)}>
            <Plus className="w-3.5 h-3.5" /> Inviter un comptable
          </PrimaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-4">
        {error ? (
          <div
            className="rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-[#92400e]"
            style={{ fontSize: "0.8125rem", fontWeight: 600 }}
          >
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            className="rounded-xl border border-[#bbf7d0] bg-[#f0fdf4] px-4 py-3 text-[#166534]"
            style={{ fontSize: "0.8125rem", fontWeight: 600 }}
          >
            {notice}
          </div>
        ) : null}
        {inviteOpen ? (
          <Card>
            <div className="grid gap-3 md:grid-cols-[1fr_180px_auto] md:items-end">
              <label className="grid gap-1.5">
                <span className="text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                  Email
                </span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="cabinet@example.fr"
                  className="h-10 rounded-xl border border-[#dbe4ef] bg-white px-3 text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                  style={{ fontSize: "0.875rem" }}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                  Rôle
                </span>
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  className="h-10 rounded-xl border border-[#dbe4ef] bg-white px-3 text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                  style={{ fontSize: "0.875rem" }}
                >
                  <option value="accountant">Comptable</option>
                  <option value="admin">Admin</option>
                  <option value="sales">Commercial</option>
                  <option value="viewer">Lecture seule</option>
                </select>
              </label>
              <PrimaryButton onClick={sendInvite} disabled={inviteBusy || !inviteEmail.trim()}>
                <Send className="w-3.5 h-3.5" /> Envoyer
              </PrimaryButton>
            </div>
            <p className="mt-3 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
              Le rôle comptable peut consulter et traiter factures, achats, trésorerie, paiements et exports. Le compte
              du comptable est créé depuis le lien d'invitation, et seuls owner/admin gèrent l'équipe.
            </p>
          </Card>
        ) : null}
        <DataTable headers={["Nom", "Email", "Rôle", ""]}>
          {loading ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                Chargement…
              </td>
            </tr>
          ) : members.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                Aucun membre affichable.
              </td>
            </tr>
          ) : (
            members.map((m) => (
              <tr key={m.id} className="hover:bg-[#f9fafb]/60 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#1d4ed8] to-[#7c3aed] flex items-center justify-center flex-shrink-0">
                      <span className="text-white" style={{ fontSize: "0.6rem", fontWeight: 600 }}>
                        {String(m.email || "U")
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                    </div>
                    <span className="text-[#111827]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {String(m.email || "Utilisateur").split("@")[0]}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                  {m.email}
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={m.role === "owner" ? "ok" : "muted"} label={roleLabels[m.role] || m.role} />
                </td>
                <td className="px-4 py-3 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                  {m.is_admin ? "Plateforme" : ""}
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </div>
    </div>
  );
}

export function ItemsPage() {
  const items = [
    { id: "1", name: "Abonnement SaaS Facturation", unit: "mois", price: "59,00", vat: "20" },
    { id: "2", name: "Module e-invoicing B2B", unit: "mois", price: "30,00", vat: "20" },
    { id: "3", name: "Support premium", unit: "mois", price: "25,00", vat: "20" },
    { id: "4", name: "Formation initiale (1h)", unit: "heure", price: "150,00", vat: "20" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Articles"
        breadcrumb="Catalogue"
        description="Catalogue de prestations et produits."
        actions={
          <PrimaryButton>
            <Plus className="w-3.5 h-3.5" /> Nouvel article
          </PrimaryButton>
        }
      />
      <div className="p-6 lg:p-8">
        <DataTable headers={["Désignation", "Unité", "PU HT", "TVA %", ""]}>
          {items.map((item) => (
            <tr key={item.id} className="hover:bg-[#f9fafb]/60 transition-colors">
              <td className="px-4 py-3 text-[#111827]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                {item.name}
              </td>
              <td className="px-4 py-3 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                {item.unit}
              </td>
              <td className="px-4 py-3 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                {item.price} €
              </td>
              <td className="px-4 py-3 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                {item.vat}%
              </td>
              <td className="px-4 py-3">
                <button
                  className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
                  style={{ fontSize: "0.75rem", fontWeight: 500 }}
                >
                  Modifier
                </button>
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}

export function ReceivablesPage() {
  return (
    <div>
      <AppPageHeader title="Factures en retard" breadcrumb="Factures" description="Suivi simple des factures échues." />
      <div className="p-6 lg:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total créances" value="3 200 €" sub="Factures échues" accent="red" />
          <StatCard label="En retard" value="1" sub="Facture(s)" accent="amber" />
          <StatCard label="Relances envoyées" value="2" sub="Ce mois" />
          <StatCard label="Taux encaissé" value="94%" sub="12 derniers mois" accent="green" />
        </div>
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <h3 className="text-[#111827] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
            Factures en retard
          </h3>
          <div className="flex items-center justify-between py-3 border-b border-[#f3f4f6]">
            <div>
              <Link
                to="/app/invoices/i3"
                className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
              >
                FAC-2026-010
              </Link>
              <span className="text-[#9ca3af] ml-2" style={{ fontSize: "0.75rem" }}>
                StartupXYZ · 3 200,00 €
              </span>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill status="danger" label="En retard" />
              <button
                className="px-3 py-1.5 bg-[#d97706] text-white rounded-lg hover:bg-[#b45309] transition-colors"
                style={{ fontSize: "0.75rem", fontWeight: 500 }}
              >
                Relancer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GetStartedPage() {
  const steps = [
    {
      n: 1,
      title: "Compléter votre entreprise",
      desc: "SIRET, TVA (ou exonération), IBAN, mentions légales.",
      done: true,
      href: "/app/company",
      icon: Building2,
      color: "#1d4ed8",
      bg: "#eff6ff",
    },
    {
      n: 2,
      title: "Ajouter votre premier client",
      desc: "Nom, adresse et SIRET si client entreprise FR.",
      done: true,
      href: "/app/customers/new",
      icon: Users,
      color: "#059669",
      bg: "#ecfdf5",
    },
    {
      n: 3,
      title: "Créer un premier document",
      desc: "Préparez directement un devis ou une facture.",
      done: false,
      href: "/app/new",
      icon: Package,
      color: "#7c3aed",
      bg: "#f5f3ff",
    },
    {
      n: 4,
      title: "Envoyer un premier devis",
      desc: "Lien client + acceptation + preuve d'intégrité.",
      done: false,
      href: "/app/quotes/new",
      icon: Send,
      color: "#0891b2",
      bg: "#ecfeff",
    },
    {
      n: 5,
      title: "Émettre une première facture",
      desc: "PDF/Factur-X, portail client, paiement en ligne.",
      done: false,
      href: "/app/invoices/new",
      icon: FileText,
      color: "#d97706",
      bg: "#fffbeb",
    },
  ];
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  const nextStep = steps.find((s) => !s.done);

  return (
    <div>
      <AppPageHeader
        title="Démarrage en 5 minutes"
        breadcrumb="Aide"
        description="Le parcours le plus rapide pour envoyer vos premiers devis et factures B2B."
        actions={
          <Link to="/app/onboarding">
            <PrimaryButton>Lancer l'onboarding</PrimaryButton>
          </Link>
        }
      />
      <div className="p-6 lg:p-8 space-y-6 max-w-4xl">
        {/* Progress hero */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative overflow-hidden rounded-2xl p-6"
          style={{ background: "linear-gradient(135deg,#0f1e36 0%,#1a2f55 100%)" }}
        >
          <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-[#1d4ed8]/20 blur-[60px] pointer-events-none" />
          <div className="relative flex items-center gap-6">
            {/* Arc progress */}
            <div className="relative w-20 h-20 flex-shrink-0">
              <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
                <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
                <circle
                  cx="40"
                  cy="40"
                  r="32"
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="6"
                  strokeDasharray={`${2 * Math.PI * 32}`}
                  strokeDashoffset={`${2 * Math.PI * 32 * (1 - pct / 100)}`}
                  strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 0.8s ease" }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-white" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                  {pct}%
                </span>
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-white mb-1" style={{ fontSize: "1.0625rem", fontWeight: 600 }}>
                {done === steps.length ? "🎉 Vous êtes prêt à facturer !" : `${done}/${steps.length} étapes complètes`}
              </h3>
              <p className="text-white/50" style={{ fontSize: "0.8125rem" }}>
                {nextStep ? `Prochaine étape : ${nextStep.title}` : "Toutes les étapes sont validées."}
              </p>
              {nextStep && (
                <Link
                  to={nextStep.href}
                  className="inline-flex items-center gap-1.5 mt-3 px-4 py-1.5 rounded-xl text-white border border-white/20 hover:bg-white/10 transition-all"
                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                >
                  Commencer maintenant <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          </div>
        </motion.div>

        {/* Steps */}
        <div className="space-y-3">
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: i * 0.06 }}
            >
              <div
                className={`bg-white rounded-2xl p-4 flex items-center gap-4 transition-all ${
                  !s.done ? "hover:-translate-y-0.5 cursor-pointer" : "opacity-75"
                }`}
                style={{
                  boxShadow: s.done
                    ? "0 1px 3px rgba(0,0,0,0.04)"
                    : "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
                }}
              >
                {/* Icon */}
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: s.done ? "#f0fdf4" : s.bg }}
                >
                  {s.done ? (
                    <CheckCircle2 className="w-5 h-5 text-[#16a34a]" />
                  ) : (
                    <s.icon className="w-5 h-5" style={{ color: s.color }} />
                  )}
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                      {s.title}
                    </span>
                    {s.done && <StatusPill label="Complété" color="ok" />}
                  </div>
                  <p className="text-[#64748b] mt-0.5 truncate" style={{ fontSize: "0.8125rem" }}>
                    {s.desc}
                  </p>
                </div>
                {/* Action */}
                {!s.done && (
                  <Link
                    to={s.href}
                    className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all"
                    style={{ fontSize: "0.75rem", fontWeight: 600, background: s.bg, color: s.color }}
                  >
                    Ouvrir <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState({ name: "", siret: "", tva: "" });
  const [client, setClient] = useState({ name: "", email: "" });

  const steps = [
    { id: 0, label: "Entreprise", icon: Building2, color: "#1d4ed8" },
    { id: 1, label: "Premier client", icon: Users, color: "#059669" },
    { id: 2, label: "Premier document", icon: FileText, color: "#7c3aed" },
  ];

  return (
    <div>
      <AppPageHeader
        title="Démarrage rapide"
        breadcrumb="Onboarding"
        description="Configurez votre espace en 3 étapes pour être prêt à facturer."
        backHref="/app/get-started"
      />
      <div className="p-6 lg:p-8 max-w-2xl space-y-6">
        {/* Step indicator */}
        <div
          className="flex items-center gap-0 bg-white rounded-2xl p-1.5"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
        >
          {steps.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(s.id)}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl transition-all"
              style={{
                background: step === s.id ? "white" : "transparent",
                boxShadow: step === s.id ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
              }}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${i < step ? "bg-[#059669]" : step === s.id ? "bg-[#1d4ed8]" : "bg-[#f1f5f9]"}`}
              >
                {i < step ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                ) : (
                  <span style={{ fontSize: "0.6875rem", fontWeight: 700, color: step === s.id ? "white" : "#94a3b8" }}>
                    {i + 1}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: step === s.id ? 600 : 400,
                  color: step === s.id ? "#0f172a" : "#94a3b8",
                }}
              >
                {s.label}
              </span>
            </button>
          ))}
        </div>

        {/* Step content */}
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25 }}
        >
          {step === 0 && (
            <Card>
              <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                Votre entreprise
              </h3>
              <div className="space-y-4">
                {[
                  { label: "Raison sociale", key: "name", placeholder: "SAS, SARL, EI…" },
                  { label: "SIRET (14 chiffres)", key: "siret", placeholder: "12345678901234" },
                  { label: "N° TVA intracommunautaire", key: "tva", placeholder: "FR12345678901" },
                ].map((f) => (
                  <div key={f.key}>
                    <label className="block mb-1.5 text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {f.label}
                    </label>
                    <input
                      value={(company as any)[f.key]}
                      onChange={(e) => setCompany((c) => ({ ...c, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#f8fafc] text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 transition-all"
                      style={{ fontSize: "0.875rem", border: "1px solid rgba(0,0,0,0.08)" }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-6">
                <button
                  className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                >
                  Préremplir via SIRENE →
                </button>
                <button
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-white transition-all"
                  style={{
                    background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    boxShadow: "0 2px 8px rgba(29,78,216,0.3)",
                  }}
                >
                  Enregistrer et continuer <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                Premier client
              </h3>
              <div className="space-y-4">
                {[
                  { label: "Nom / Raison sociale", key: "name", placeholder: "Acme Corp" },
                  { label: "Email de facturation", key: "email", placeholder: "compta@client.fr" },
                ].map((f) => (
                  <div key={f.key}>
                    <label className="block mb-1.5 text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {f.label}
                    </label>
                    <input
                      value={(client as any)[f.key]}
                      onChange={(e) => setClient((c) => ({ ...c, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#f8fafc] text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 transition-all"
                      style={{ fontSize: "0.875rem", border: "1px solid rgba(0,0,0,0.08)" }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-6">
                <button
                  onClick={() => setStep(0)}
                  className="text-[#94a3b8] hover:text-[#64748b] transition-colors"
                  style={{ fontSize: "0.8125rem" }}
                >
                  ← Retour
                </button>
                <button
                  onClick={() => setStep(2)}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-white transition-all"
                  style={{
                    background: "linear-gradient(135deg,#059669,#0d9488)",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    boxShadow: "0 2px 8px rgba(5,150,105,0.3)",
                  }}
                >
                  Créer le client <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <h3 className="text-[#0f172a] mb-2" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                Créer votre premier document
              </h3>
              <p className="text-[#64748b] mb-5" style={{ fontSize: "0.8125rem" }}>
                Choisissez le type de document à créer en premier.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    href: "/app/quotes/new",
                    icon: Send,
                    label: "Devis",
                    desc: "Envoyer une offre client",
                    color: "#7c3aed",
                    bg: "#f5f3ff",
                  },
                  {
                    href: "/app/invoices/new",
                    icon: FileText,
                    label: "Facture",
                    desc: "Émettre directement",
                    color: "#1d4ed8",
                    bg: "#eff6ff",
                  },
                ].map((opt) => (
                  <Link
                    key={opt.href}
                    to={opt.href}
                    className="flex flex-col items-center text-center p-5 rounded-2xl transition-all hover:-translate-y-0.5"
                    style={{ background: opt.bg, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
                  >
                    <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center mb-3 shadow-sm">
                      <opt.icon className="w-5 h-5" style={{ color: opt.color }} />
                    </div>
                    <span className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                      {opt.label}
                    </span>
                    <span className="text-[#64748b] mt-0.5" style={{ fontSize: "0.75rem" }}>
                      {opt.desc}
                    </span>
                  </Link>
                ))}
              </div>
              <button
                onClick={() => setStep(1)}
                className="mt-4 text-[#94a3b8] hover:text-[#64748b] transition-colors block"
                style={{ fontSize: "0.8125rem" }}
              >
                ← Retour
              </button>
            </Card>
          )}
        </motion.div>
      </div>
    </div>
  );
}

export function NewDocumentPage() {
  const recommended = {
    href: "/app/invoices/new",
    icon: FileText,
    label: "Nouvelle facture",
    desc: "Émettez une facture conforme Factur-X, préremplie depuis vos clients et articles.",
    color: "#1d4ed8",
    bg: "from-[#1d4ed8] to-[#4f46e5]",
  };
  const alternatives = [
    {
      href: "/app/quotes/new",
      icon: Send,
      label: "Nouveau devis",
      desc: "Créez et envoyez un devis client avec lien d'acceptation.",
      color: "#7c3aed",
      bg: "#f5f3ff",
      text: "#7c3aed",
    },
    {
      href: "/app/customers/new",
      icon: Users,
      label: "Nouveau client",
      desc: "Ajoutez un client avec SIRET, TVA et préférences de facturation.",
      color: "#059669",
      bg: "#ecfdf5",
      text: "#059669",
    },
  ];
  const recent = [
    { label: "Acme Corp", sub: "Dernière facture il y a 3 jours", href: "/app/invoices/new" },
    { label: "Tech Solutions", sub: "Devis envoyé hier", href: "/app/quotes/new" },
  ];

  return (
    <div>
      <AppPageHeader title="Créer" breadcrumb="Nouveau" description="Que souhaitez-vous créer ?" />
      <div className="p-6 lg:p-8 max-w-3xl space-y-5">
        {/* Recommended */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <p
            className="text-[#94a3b8] mb-2.5"
            style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            <Sparkles className="w-3 h-3 inline mr-1" />
            Recommandé
          </p>
          <Link
            to={recommended.href}
            className="relative overflow-hidden flex items-center gap-5 p-5 rounded-2xl text-white transition-all hover:opacity-95 hover:-translate-y-0.5 group"
            style={{
              background: `linear-gradient(135deg,${recommended.color},#4f46e5)`,
              boxShadow: "0 4px 24px rgba(29,78,216,0.3)",
            }}
          >
            <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-white/5 blur-[40px] pointer-events-none" />
            <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0 group-hover:bg-white/20 transition-colors">
              <recommended.icon className="w-7 h-7 text-white" />
            </div>
            <div className="flex-1 relative">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-white" style={{ fontSize: "1.0625rem", fontWeight: 700 }}>
                  {recommended.label}
                </span>
                <span
                  className="px-2 py-0.5 rounded-full bg-white/15 text-white/80"
                  style={{ fontSize: "0.625rem", fontWeight: 600 }}
                >
                  ACTION PRINCIPALE
                </span>
              </div>
              <p className="text-white/70" style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>
                {recommended.desc}
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-white/60 group-hover:translate-x-1 transition-transform flex-shrink-0 relative" />
          </Link>
        </motion.div>

        {/* Alternatives */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.08 }}
        >
          <p
            className="text-[#94a3b8] mb-2.5"
            style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            Autres options
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {alternatives.map((alt) => (
              <Link
                key={alt.href}
                to={alt.href}
                className="flex items-center gap-3.5 p-4 bg-white rounded-2xl hover:-translate-y-0.5 transition-all group"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: alt.bg }}
                >
                  <alt.icon className="w-5 h-5" style={{ color: alt.text }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    {alt.label}
                  </p>
                  <p className="text-[#64748b] truncate" style={{ fontSize: "0.75rem" }}>
                    {alt.desc}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-[#cbd5e1] group-hover:text-[#94a3b8] transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </motion.div>

        {/* Recent clients quick-create */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.14 }}
        >
          <p
            className="text-[#94a3b8] mb-2.5"
            style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            Accès rapide — clients récents
          </p>
          <div
            className="bg-white rounded-2xl divide-y divide-[#f8fafc]"
            style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
          >
            {recent.map((r, i) => (
              <Link
                key={i}
                to={r.href}
                className="flex items-center gap-3 px-4 py-3 hover:bg-[#f8fafc] transition-colors group"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1d4ed8] to-[#4f46e5] flex items-center justify-center flex-shrink-0">
                  <span className="text-white" style={{ fontSize: "0.625rem", fontWeight: 700 }}>
                    {r.label.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                    {r.label}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {r.sub}
                  </p>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-[#cbd5e1] group-hover:text-[#94a3b8] transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export function SessionDebugPage() {
  return (
    <div>
      <AppPageHeader
        title="Diagnostic session"
        breadcrumb="Diagnostic session"
        description="Contrôle de session et de configuration d’accès."
      />
      <div className="p-6 lg:p-8">
        <Card className="max-w-2xl space-y-3">
          {[
            ["User Agent", navigator.userAgent],
            ["Cookie support", navigator.cookieEnabled ? "Oui" : "Non"],
            ["Origin", window.location.origin],
            ["Protocol", window.location.protocol],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between py-1.5 border-b border-[#f8fafc] last:border-0">
              <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                {k}
              </span>
              <span
                className="text-[#374151] font-mono text-right max-w-[60%] truncate"
                style={{ fontSize: "0.75rem" }}
              >
                {v}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

export function PortalPage() {
  return (
    <div>
      <AppPageHeader title="Portail" breadcrumb="Portail client" description="Gestion du portail client." />
      <div className="p-6 lg:p-8">
        <Card className="max-w-2xl">
          <p className="text-[#64748b]" style={{ fontSize: "0.875rem" }}>
            Configuration du portail client — interface en cours de développement.
          </p>
        </Card>
      </div>
    </div>
  );
}

export function PdpPage() {
  return (
    <div>
      <AppPageHeader
        title="PDP"
        breadcrumb="Plateforme de Dématérialisation"
        description="Gestion de la PA partenaire."
      />
      <div className="p-6 lg:p-8">
        <Card className="max-w-2xl">
          <p className="text-[#64748b]" style={{ fontSize: "0.875rem" }}>
            Configuration PDP — interface en cours de développement.
          </p>
        </Card>
      </div>
    </div>
  );
}

export function SetupPage() {
  return (
    <div>
      <AppPageHeader title="Configuration" breadcrumb="Setup" description="Configuration initiale de votre espace." />
      <div className="p-6 lg:p-8">
        <Link
          to="/app/setup/einvoicing"
          className="block max-w-2xl p-5 bg-white rounded-2xl hover:-translate-y-0.5 transition-all group"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#ecfdf5] flex items-center justify-center flex-shrink-0">
              <Zap className="w-5 h-5 text-[#059669]" />
            </div>
            <div className="flex-1">
              <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                E-facturation 2026–2027
              </h3>
              <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                Préparer la facturation électronique obligatoire.
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-[#cbd5e1] group-hover:text-[#94a3b8] transition-colors" />
          </div>
        </Link>
      </div>
    </div>
  );
}

export function PaywallPage() {
  const plans = [
    {
      name: "Starter",
      price: "29 €",
      period: "/mois",
      features: [
        "Clients, devis, factures et PDF",
        "Suivi simple des paiements",
        "Branding de base",
        "Sans connecteurs avancés",
      ],
      cta: "Voir Starter",
      current: false,
      color: "#0f8ec7",
      href: "/app/billing",
    },
    {
      name: "Pro",
      price: "59 €",
      period: "/mois",
      features: [
        "Tout Starter",
        "Factur-X et UBL selon configuration",
        "E-facturation via PA selon activation",
        "50 jetons offerts une seule fois à l'activation puis packs",
      ],
      cta: "Choisir Pro",
      current: false,
      color: "#6d4aff",
      highlight: true,
      href: "/app/billing",
    },
    {
      name: "Volume",
      price: "Sur devis",
      period: "",
      features: ["Contrat adapté", "Volumétrie sur mesure", "Accompagnement dédié", "Support prioritaire"],
      cta: "Nous contacter",
      current: false,
      color: "#0f7f73",
      href: "/contact",
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="Abonnement requis"
        breadcrumb="Facturation"
        description="Cette fonctionnalité est disponible avec le plan Pro, selon activation et configuration."
      />
      <div className="p-6 lg:p-8 max-w-4xl">
        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`bg-white rounded-2xl p-5 relative transition-all ${plan.highlight ? "ring-2 ring-[#1d4ed8]" : ""}`}
              style={{ boxShadow: plan.highlight ? "0 4px 24px rgba(29,78,216,0.15)" : "0 1px 3px rgba(0,0,0,0.06)" }}
            >
              {plan.highlight && (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-white"
                  style={{
                    fontSize: "0.625rem",
                    fontWeight: 700,
                    background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                  }}
                >
                  RECOMMANDÉ
                </div>
              )}
              <div className="mb-4">
                <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                  {plan.name}
                </h3>
                <div className="flex items-baseline gap-0.5 mt-1">
                  <span style={{ fontSize: "1.75rem", fontWeight: 800, color: plan.color }}>{plan.price}</span>
                  <span className="text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                    {plan.period}
                  </span>
                </div>
              </div>
              <ul className="space-y-2 mb-5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: plan.color }} />
                    <span className="text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                      {f}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to={plan.href}
                className={`w-full flex items-center justify-center py-2.5 rounded-xl transition-all ${plan.current ? "bg-[#f1f5f9] text-[#64748b]" : "text-white hover:opacity-90"}`}
                style={{
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  background: plan.current ? undefined : `linear-gradient(135deg,${plan.color},${plan.color}dd)`,
                  boxShadow: plan.current ? undefined : `0 2px 8px ${plan.color}40`,
                }}
              >
                {plan.current ? "Plan actuel" : plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
