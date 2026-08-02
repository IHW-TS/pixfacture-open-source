"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, apiFetch, apiUrl, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { emailDeliveryProof } from "@/lib/emailDeliveryProof";
import onboardingFlow from "@/lib/onboardingFlow";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession } from "@/lib/useSession";
import { can } from "@/lib/permissions";
import { SEQINO_MANDATE_CONSENT_TEXT } from "@/lib/seqinoConsent";
import { TRIAL_DAYS } from "@/lib/billingConstants";
import { useWorkspaceSummary } from "@/lib/useWorkspaceSummary";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import {
  companyLegalMentionsDefaults,
  detectFrenchBusinessIdKind,
  digitsOnly,
  formatFrenchBusinessIdInput,
  formatSiretInput,
  formatVatNumberInput,
} from "@/lib/businessRules";
import {
  AppPageHeader,
  StatusPill,
  StatCard,
  DataTable,
  PrimaryButton,
  PrimaryLinkButton,
  SecondaryButton,
  InputField,
  Card,
  DisclosureCard,
  SectionTitle,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { SeqinoTokenNotice } from "../../components/app/SeqinoTokenNotice";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import { SalesListBlock, SalesMetricCard, SalesMetricsGrid } from "../../components/app/SalesModuleLayout";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import InvoiceEmailModal, { type InvoiceEmailPayload } from "@/components/InvoiceEmailModal";
import { AccountingExportPanel } from "./SettingsPages";
import {
  Plus,
  Users,
  FileText,
  CheckCircle,
  ArrowRight,
  RefreshCw,
  AlertCircle,
  Shield,
  ShieldCheck,
  Package2,
  Archive,
  Trash2,
  CheckSquare,
  Search,
  Copy,
  Lock,
  Mail,
  MailCheck,
  Clock3,
  Phone,
  Settings,
  Upload,
  UserRound,
  Wallet,
  Send,
  X,
} from "lucide-react";

const COMPANY_PROFILE_UPDATED_EVENT = "pixfacture:company-profile-updated";
const { isCompanyProfileReady, isSubscriptionAccessReady } = onboardingFlow;

const roleLabels: Record<string, string> = {
  owner: "Propriétaire",
  admin: "Admin",
  accountant: "Comptable",
  sales: "Commercial",
  viewer: "Lecture seule",
  client: "Client",
};

const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
  draft: { label: "Brouillon", color: "muted" },
  issued: { label: "Émise", color: "warn" },
  sent: { label: "Envoyée", color: "info" },
  partial: { label: "Partielle", color: "warn" },
  paid: { label: "Payée", color: "ok" },
  overdue: { label: "En retard", color: "danger" },
  canceled: { label: "Annulée", color: "muted" },
};

const money = (value: any, currency = "EUR") =>
  `${Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "EUR" ? "€" : currency}`;

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function invoiceFollowupBlockLabel(code: any) {
  switch (String(code || "")) {
    case "invoice_followup_missing_recipient":
      return "Ajoutez un email client ou un contact facturation avant de relancer.";
    case "invoice_followup_no_balance":
      return "Aucune relance prévue : le document est soldé.";
    case "invoice_followup_not_due":
      return "Émettez la facture avant toute relance.";
    case "invoice_followup_credit_note":
      return "Les relances client ne s'appliquent pas aux avoirs.";
    case "invoice_followup_limit":
      return "La limite de relances est atteinte pour cette facture.";
    case "invoice_followup_too_soon":
      return "Une relance a déjà été enregistrée récemment.";
    default:
      return "";
  }
}

function FigmaBadge({
  children,
  v = "gray",
}: {
  children: ReactNode;
  v?: "gray" | "indigo" | "green" | "amber" | "red" | "blue" | "purple";
}) {
  const variants: Record<string, string> = {
    gray: "bg-slate-100 text-slate-500 border-slate-200",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-600 border-red-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border",
        variants[v],
      )}
    >
      {children}
    </span>
  );
}

function FigmaAvatar({ name, bg }: { name: string; bg: string }) {
  const initials = name
    .split(/[._\s@]/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return (
    <div
      className={cn(
        "w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0",
        bg,
      )}
    >
      {initials || "U"}
    </div>
  );
}

type ItemFilterMode = "active" | "all" | "archived";

const parseErrorFromResponse = async (res: Response, fallback: string) => {
  const payload = await res.json().catch(() => null);
  return extractUserFacingApiMessage(payload, res.status, fallback);
};

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

function getAccountRoleLabel(value: string | null | undefined) {
  const key = String(value || "").toLowerCase();
  return roleLabels[key] || value || "Compte";
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
  const planText = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Plan à confirmer";
  const roleText = getAccountRoleLabel(user?.role);

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
  const [actionInput, setActionInput] = useState("");
  const [entityInput, setEntityInput] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0, page_size: 20 });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", "20");
      if (actionFilter) params.set("action", actionFilter);
      if (entityFilter) params.set("entity_type", entityFilter);
      try {
        const res = await rawApi(`/api/audit/logs?${params.toString()}`);
        if (!res.ok) {
          const message = await parseErrorFromResponse(res, "Impossible de charger le journal d'actions.");
          throw new Error(message);
        }
        const data = await res.json().catch(() => ({ items: [] }));
        if (cancelled) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        setEntries(items);
        setMeta({
          page: Number(data?.page || page || 1),
          pages: Number(data?.pages || 1),
          total: Number(data?.total || items.length),
          page_size: Number(data?.page_size || 20),
        });
      } catch (err) {
        if (!cancelled) {
          setError(formatApiError(err, "Impossible de charger le journal d'actions."));
          setEntries([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [actionFilter, entityFilter, page]);

  const applyFilters = () => {
    setPage(1);
    setActionFilter(actionInput.trim());
    setEntityFilter(entityInput.trim());
  };

  const resetFilters = () => {
    setActionInput("");
    setEntityInput("");
    setActionFilter("");
    setEntityFilter("");
    setPage(1);
  };

  return (
    <div>
      <AppPageHeader
        title="Journal d'actions"
        breadcrumb="Paramètres > Audit"
        description="Actions horodatées, filtrables et masquées côté PII."
      />
      <div className="p-5 lg:p-7 w-full space-y-4">
        <div className="flex flex-wrap gap-2">
          <input
            value={actionInput}
            onChange={(e) => setActionInput(e.target.value)}
            placeholder="ex: create, send_email"
            className="px-3.5 py-2 border border-[#d1d5db] rounded-lg placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all text-sm"
          />
          <input
            value={entityInput}
            onChange={(e) => setEntityInput(e.target.value)}
            placeholder="ex: invoice, payment"
            className="px-3.5 py-2 border border-[#d1d5db] rounded-lg placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all text-sm"
          />
          <PrimaryButton onClick={applyFilters}>Filtrer</PrimaryButton>
          <SecondaryButton onClick={resetFilters}>Réinitialiser</SecondaryButton>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-lg px-3 py-2 text-xs">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        <div className="text-[#9ca3af] flex items-center justify-between text-xs">
          <span>{meta.total} entrée(s)</span>
          <span>
            Page {meta.page} / {Math.max(meta.pages, 1)}
          </span>
        </div>

        <DataTable headers={["Date", "Action", "Entité", "Acteur", "Payload"]}>
          {loading ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-[#94a3b8] text-sm">
                Chargement…
              </td>
            </tr>
          ) : entries.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-[#94a3b8] text-sm">
                Aucune entrée pour ces filtres.
              </td>
            </tr>
          ) : (
            entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-[#f9fafb]/60 transition-colors">
                <td className="px-4 py-2.5 text-[#374151] text-xs">{formatDateFr(entry.created_at, "—")}</td>
                <td className="px-4 py-2.5">
                  <StatusPill status="muted" label={entry.action || "—"} />
                </td>
                <td className="px-4 py-2.5 text-[#374151] text-sm">{entry.entity_type || "—"}</td>
                <td className="px-4 py-2.5 text-[#374151] text-sm">{entry.actor_email || "—"}</td>
                <td
                  className="px-4 py-2.5 text-[#9ca3af] font-mono max-w-[280px] truncate"
                  style={{ fontSize: "0.6875rem" }}
                >
                  {entry.payload ? JSON.stringify(entry.payload) : "{}"}
                </td>
              </tr>
            ))
          )}
        </DataTable>

        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={meta.page <= 1 || loading}>
            Précédent
          </SecondaryButton>
          <SecondaryButton
            onClick={() => setPage((p) => Math.min(meta.pages || 1, p + 1))}
            disabled={meta.page >= (meta.pages || 1) || loading}
          >
            Suivant
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

export function TeamPage() {
  const { user, plan } = useSession();
  const roleLower = String(user?.role || "").toLowerCase();
  const isTenantAdmin = Boolean((user as any)?.is_admin) || ["owner", "admin"].includes(roleLower);
  const isAccountant = roleLower === "accountant";
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("accountant");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const normalizedPlan = (plan || "starter").toLowerCase();
  const canInviteMembers = normalizedPlan === "pro" || normalizedPlan === "enterprise";
  const canManageTeam = isTenantAdmin && canInviteMembers;
  const canAssignAdmin = Boolean((user as any)?.is_admin) || roleLower === "owner";
  const memberRoleOptions = useMemo(
    () => [
      ...(canAssignAdmin ? [{ value: "admin", label: "Admin" }] : []),
      { value: "accountant", label: "Comptable" },
      { value: "sales", label: "Commercial" },
      { value: "viewer", label: "Lecture seule" },
    ],
    [canAssignAdmin],
  );

  const loadMembers = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      if (!isTenantAdmin) {
        setMembers([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await rawApi("/api/users");
        if (!res.ok) {
          const message = await parseErrorFromResponse(res, "Impossible de charger l'équipe.");
          throw new Error(message);
        }
        const data = await res.json().catch(() => []);
        if (!cancelledRef?.current) {
          setMembers(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!cancelledRef?.current) {
          setMembers([]);
          setError(formatApiError(err, "Impossible de charger l'équipe."));
        }
      } finally {
        if (!cancelledRef?.current) setLoading(false);
      }
    },
    [isTenantAdmin],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void loadMembers(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [loadMembers]);

  const sendInvite = async () => {
    if (!canInviteMembers) {
      setError(
        "Le plan Starter permet un seul utilisateur. Passez au plan Pro pour inviter un comptable ou un collaborateur.",
      );
      setNotice(null);
      return;
    }
    setInviteBusy(true);
    setError(null);
    setNotice(null);
    const invitedEmail = inviteEmail.trim();
    try {
      const result: any = await api("/api/users/invites", {
        method: "POST",
        body: JSON.stringify({ email: invitedEmail, role: inviteRole }),
      });
      if (result?.delivery === "already_member") {
        setNotice("Ce compte a déjà accès à l'espace : aucun nouvel email n'a été envoyé.");
      } else if (result?.delivery === "role_updated") {
        setNotice("Le rôle du membre existant a été mis à jour : aucun nouvel email n'a été envoyé.");
      } else if (result?.email_sent === false) {
        setNotice(
          "Invitation créée, mais l'email n'a pas pu être envoyé. Réessayez dans quelques instants ou contactez le support.",
        );
      } else {
        setNotice(
          inviteRole === "accountant"
            ? `Invitation comptable envoyée à ${invitedEmail}.`
            : `Invitation envoyée à ${invitedEmail}.`,
        );
      }
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

  const updateMemberRole = async (memberId: string, role: string) => {
    setMemberBusy(`role:${memberId}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/users/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setNotice("Rôle du membre mis à jour.");
      await loadMembers();
    } catch (err) {
      setError(formatApiError(err, "Modification du rôle impossible."));
    } finally {
      setMemberBusy(null);
    }
  };

  const removeMember = async (member: any) => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Retirer l'accès de ${member.email || member.name} à cet espace ?`);
      if (!ok) return;
    }
    setMemberBusy(`remove:${member.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/users/${member.id}`, { method: "DELETE" });
      setNotice("Accès retiré. Les sessions du membre sur cet espace ont été révoquées.");
      await loadMembers();
    } catch (err) {
      setError(formatApiError(err, "Retrait du membre impossible."));
    } finally {
      setMemberBusy(null);
    }
  };

  const teamRows = members.map((member, index) => {
    const email = member.email || "";
    const fallbackName = (email.split("@")[0] || "Utilisateur")
      .split(/[._-]/g)
      .filter(Boolean)
      .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    const name = member.name || member.full_name || member.display_name || fallbackName || "Utilisateur";
    const isCurrent = Boolean(user?.id && user.id === member.id);
    const roleLabel = roleLabels[(member.role || "").toLowerCase()] || member.role || "Membre";
    const isOwner = (member.role || "").toLowerCase() === "owner";
    const rawRole = (member.role || "").toLowerCase();
    return {
      id: member.id || email || String(index),
      name,
      email: email || "—",
      rawRole,
      role: roleLabel,
      roleVariant: isOwner ? "green" : "indigo",
      isCurrent,
      isOwner,
      lastAccess: member.last_login_at
        ? formatDateTimeFr(member.last_login_at, "—")
        : isCurrent
          ? "Session active"
          : "—",
      bg: ["bg-indigo-500", "bg-purple-500", "bg-sky-500", "bg-emerald-500", "bg-slate-500"][index % 5],
    };
  });
  return (
    <div>
      <AppPageHeader title={isAccountant ? "Dossier comptable" : "Équipe & Comptable"} />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {isTenantAdmin && error ? (
          <div className="flex items-center gap-2 text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-xl px-4 py-3 text-[12px] font-semibold">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-[12px] font-semibold">
            <MailCheck className="w-3.5 h-3.5" />
            {notice}
          </div>
        ) : null}

        {isTenantAdmin ? (
          <div className="bg-white rounded-2xl border border-[#E8EAF0] shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-[#F0F3F8] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                  <Shield size={14} className="text-[#5B5FEE]" />
                </div>
                <p className="text-[14px] font-bold text-gray-900">Accès équipe et comptable</p>
                <span className="text-[11px] text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 font-semibold">
                  {members.length} membre{members.length > 1 ? "s" : ""}
                </span>
              </div>
              {canManageTeam ? (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-white rounded-xl px-3.5 py-2 hover:opacity-90 shadow-md shadow-indigo-200/40 transition-all"
                  style={{ background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" }}
                >
                  <Plus size={12} /> Inviter un membre
                </button>
              ) : (
                <Link
                  to="/app/billing"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-white rounded-xl px-3.5 py-2 hover:opacity-90 shadow-md shadow-indigo-200/40 transition-all"
                  style={{ background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" }}
                >
                  <Plus size={12} /> Passer Pro pour inviter
                </Link>
              )}
            </div>

            <table className="w-full">
              <thead>
                <tr className="bg-[#FAFBFE] border-b border-[#F0F3F8]">
                  {[
                    { label: "Membre", w: "w-[28%]" },
                    { label: "Email", w: "w-[30%]" },
                    { label: "Rôle", w: "w-[18%]" },
                    { label: "Dernier accès", w: "w-[18%]" },
                    { label: "", w: "" },
                  ].map((col, i) => (
                    <th
                      key={col.label || i}
                      className={cn(
                        col.w,
                        "py-3 text-[11px] font-bold text-gray-400 uppercase tracking-wider",
                        i === 0 ? "px-6 text-left" : i === 4 ? "px-4" : "px-4 text-left",
                      )}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-[13px] font-semibold text-gray-400">
                      Chargement…
                    </td>
                  </tr>
                ) : teamRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-[13px] font-semibold text-gray-400">
                      Aucun membre affichable.
                    </td>
                  </tr>
                ) : (
                  teamRows.map((member) => (
                    <tr
                      key={member.id}
                      className="border-b border-[#F5F6FA] last:border-0 hover:bg-[#FAFBFE] transition-colors group"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <FigmaAvatar name={member.name} bg={member.bg} />
                          <p className="text-[13px] font-semibold text-gray-800">{member.name}</p>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-[13px] text-gray-500">{member.email}</td>
                      <td className="px-4 py-4">
                        {canManageTeam && !member.isOwner && !member.isCurrent ? (
                          <select
                            value={member.rawRole}
                            disabled={memberBusy === `role:${member.id}`}
                            onChange={(event) => void updateMemberRole(member.id, event.target.value)}
                            className="min-w-[140px] rounded-xl border border-[#E8EAF0] bg-white px-3 py-2 text-[12px] font-semibold text-gray-700 focus:border-[#5B5FEE] focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {memberRoleOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <FigmaBadge v={member.roleVariant as "green" | "indigo"}>
                            <span
                              className={cn(
                                "w-1.5 h-1.5 rounded-full inline-block",
                                member.roleVariant === "green" ? "bg-emerald-500" : "bg-indigo-500",
                              )}
                            />
                            {member.role}
                          </FigmaBadge>
                        )}
                      </td>
                      <td className="px-4 py-4 text-[12px] text-gray-400">{member.lastAccess}</td>
                      <td className="px-4 py-4 text-right">
                        {canManageTeam && !member.isOwner && !member.isCurrent ? (
                          <button
                            type="button"
                            onClick={() => void removeMember(member)}
                            disabled={memberBusy === `remove:${member.id}`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-red-100 bg-red-50 px-3 py-1.5 text-[12px] font-bold text-red-600 transition-all hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 size={12} />
                            Retirer
                          </button>
                        ) : (
                          <span className="text-[11px] font-semibold text-gray-300">
                            {member.isCurrent ? "Votre accès" : member.isOwner ? "Protégé" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}

        {isTenantAdmin || isAccountant ? <AccountingExportPanel /> : null}

        {!isTenantAdmin && !isAccountant ? (
          <div className="rounded-2xl border border-[#E8EAF0] bg-white px-6 py-8 text-center shadow-sm">
            <p className="text-[13px] font-semibold text-gray-500">Vous n'avez pas accès à la gestion d'équipe.</p>
          </div>
        ) : null}
      </div>

      {inviteOpen && canManageTeam ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="team-invite-title"
        >
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-[#E8EAF0] bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#F0F3F8] px-5 py-4">
              <div className="min-w-0">
                <h2 id="team-invite-title" className="text-[16px] font-extrabold text-gray-900">
                  Inviter un membre
                </h2>
                <p className="mt-1 text-[12px] font-semibold text-gray-500">
                  Envoie une invitation avec le rôle adapté à son accès.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                disabled={inviteBusy}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#E8EAF0] bg-white text-gray-500 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Fermer l'invitation"
              >
                <X size={16} />
              </button>
            </div>
            <div className="grid gap-4 px-5 py-5">
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-gray-500">Email</span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="cabinet@example.fr"
                  className="text-[13px] border border-[#E8EAF0] bg-white rounded-xl px-3.5 py-2.5 text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-[#5B5FEE] transition-all"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-gray-500">Rôle</span>
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  className="text-[13px] border border-[#E8EAF0] bg-white rounded-xl px-3.5 py-2.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-[#5B5FEE] transition-all"
                >
                  <option value="accountant">Comptable</option>
                  <option value="admin">Admin</option>
                  <option value="sales">Commercial</option>
                  <option value="viewer">Lecture seule</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#F0F3F8] bg-[#FAFBFE] px-5 py-4">
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                disabled={inviteBusy}
                className="rounded-xl border border-[#E8EAF0] bg-white px-3.5 py-2 text-[12px] font-bold text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={sendInvite}
                disabled={inviteBusy || !inviteEmail.trim()}
                className="flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white rounded-xl px-3.5 py-2 hover:opacity-90 shadow-md shadow-indigo-200/40 transition-all disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" }}
              >
                <Send size={12} /> {inviteBusy ? "Envoi..." : "Envoyer l'invitation"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ItemsPage() {
  const { user } = useSession({ autoRefresh: false });
  const canWriteItems = can(user, "items:write");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<ItemFilterMode>("active");
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.items.pageSize.v1");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState({
    name: "",
    description: "",
    unit_price: "0",
    vat_rate: "20",
    unit_code: "C62",
    active: true,
  });

  const loadItems = async (query = search) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      params.set("include_inactive", "true");
      const res = await rawApi(`/api/items?${params.toString()}`);
      if (!res.ok) {
        const message = await parseErrorFromResponse(res, "Impossible de charger les articles.");
        throw new Error(message);
      }
      const data = await res.json().catch(() => []);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setItems([]);
      setError(formatApiError(err, "Impossible de charger les articles."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      await loadItems(search);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const resetEditor = (item?: any) => {
    if (!canWriteItems) return;
    setEditingItemId(item?.id || null);
    setItemForm({
      name: item?.name || "",
      description: item?.description || "",
      unit_price: item?.unit_price != null ? String(item.unit_price) : "0",
      vat_rate: item?.vat_rate != null ? String(item.vat_rate) : "20",
      unit_code: item?.unit_code || "C62",
      active: item?.active !== false,
    });
    setEditorError(null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (editorBusy) return;
    setEditorOpen(false);
    setEditingItemId(null);
    setEditorError(null);
  };

  const itemName = (itemForm.name || "").trim();
  const parsedUnitPrice = Number(String(itemForm.unit_price || "0").replace(",", "."));
  const parsedVatRate = Number(String(itemForm.vat_rate || "20").replace(",", "."));
  const itemFormCanSave =
    Boolean(itemName) &&
    Number.isFinite(parsedUnitPrice) &&
    parsedUnitPrice >= 0 &&
    Number.isFinite(parsedVatRate) &&
    parsedVatRate >= 0;

  const onExport = () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (filterMode === "archived") {
      params.set("include_inactive", "true");
      params.set("active", "false");
    } else if (filterMode === "all") {
      params.set("include_inactive", "true");
    }
    window.location.assign(apiUrl(`/api/items/export.csv${params.toString() ? `?${params.toString()}` : ""}`));
  };

  const onImportClick = () => {
    if (!canWriteItems) return;
    fileInputRef.current?.click();
  };

  const onImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!canWriteItems) return;
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response: any = await apiFetch("/api/items/import", {
        method: "POST",
        body,
      });
      const created = Number(response?.created || 0);
      const updated = Number(response?.updated || 0);
      const skipped = Number(response?.skipped || 0);
      setImportResult(`Import terminé : ${created} créé(s), ${updated} mis à jour, ${skipped} ignoré(s).`);
      await loadItems(search);
    } catch (err) {
      setError(formatApiError(err, "Import impossible."));
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  };

  const saveItem = async () => {
    if (editorBusy || !canWriteItems) return;
    const payload = {
      name: itemName,
      description: (itemForm.description || "").trim() || null,
      unit_price: parsedUnitPrice,
      vat_rate: parsedVatRate,
      unit_code: (itemForm.unit_code || "C62").trim() || "C62",
      active: itemForm.active !== false,
    };

    if (!payload.name) {
      setEditorError("Le nom de l'article est requis.");
      return;
    }
    if (!Number.isFinite(payload.unit_price) || payload.unit_price < 0) {
      setEditorError("Prix unitaire HT invalide.");
      return;
    }
    if (!Number.isFinite(payload.vat_rate) || payload.vat_rate < 0) {
      setEditorError("Taux de TVA invalide.");
      return;
    }

    setEditorBusy(true);
    setEditorError(null);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(editingItemId ? `/api/items/${editingItemId}` : "/api/items", {
        method: editingItemId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setNotice(editingItemId ? "Article mis à jour." : "Article créé.");
      closeEditor();
      await loadItems(search);
    } catch (err) {
      setEditorError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setEditorBusy(false);
    }
  };

  const setItemActive = async (item: any, active: boolean) => {
    if (editorBusy || !canWriteItems) return;
    setEditorBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (active) {
        await apiFetch(`/api/items/${item.id}`, {
          method: "PUT",
          body: JSON.stringify({ active: true }),
        });
        setNotice(`Article réactivé : ${item.name || "article"}.`);
      } else {
        if (typeof window !== "undefined" && !window.confirm(`Archiver l'article « ${item.name || "Sans nom"} » ?`)) {
          return;
        }
        await apiFetch(`/api/items/${item.id}`, { method: "DELETE" });
        setNotice(`Article archivé : ${item.name || "article"}.`);
      }
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        next.delete(String(item.id));
        return next;
      });
      await loadItems(search);
    } catch (err) {
      setError(formatApiError(err, active ? "Réactivation impossible." : "Archivage impossible."));
    } finally {
      setEditorBusy(false);
    }
  };

  const deleteItemPermanently = async (item: any) => {
    if (editorBusy || !item?.id || !canWriteItems) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Supprimer définitivement l'article « ${item.name || "Sans nom"} » ?`)
    ) {
      return;
    }
    setEditorBusy(true);
    setError(null);
    setNotice(null);
    setEditorError(null);
    try {
      await apiFetch(`/api/items/${encodeURIComponent(String(item.id))}?permanent=true`, { method: "DELETE" });
      setNotice(`Article supprimé : ${item.name || "article"}.`);
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        next.delete(String(item.id));
        return next;
      });
      setEditorOpen(false);
      setEditingItemId(null);
      await loadItems(search);
    } catch (err) {
      setEditorError(formatApiError(err, "Suppression impossible."));
    } finally {
      setEditorBusy(false);
    }
  };

  const activeItems = useMemo(() => items.filter((item) => item.active !== false), [items]);
  const archivedItems = useMemo(() => items.filter((item) => item.active === false), [items]);
  const visibleItems = useMemo(() => {
    if (filterMode === "archived") return archivedItems;
    if (filterMode === "all") return items;
    return activeItems;
  }, [activeItems, archivedItems, filterMode, items]);
  const pageItems = useMemo(() => paginateList(visibleItems, page, pageSize), [visibleItems, page, pageSize]);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedItemIds.has(String(item.id))),
    [items, selectedItemIds],
  );
  const selectedItemCount = selectedItems.length;
  const pageItemIds = useMemo(() => pageItems.map((item) => String(item.id)), [pageItems]);
  const pageSelectionChecked = pageItemIds.length > 0 && pageItemIds.every((itemId) => selectedItemIds.has(itemId));
  const toggleItemSelection = (itemId: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };
  const togglePageSelection = () => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (pageSelectionChecked) {
        pageItemIds.forEach((itemId) => next.delete(itemId));
      } else {
        pageItemIds.forEach((itemId) => next.add(itemId));
      }
      return next;
    });
  };
  const clearItemSelection = () => setSelectedItemIds(new Set());

  useEffect(() => {
    const visibleIds = new Set(items.map((item) => String(item.id)));
    setSelectedItemIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const bulkArchiveSelected = async () => {
    if (!selectedItems.length || editorBusy || !canWriteItems) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Archiver ${selectedItems.length} article${selectedItems.length > 1 ? "s" : ""} ?`)
    ) {
      return;
    }
    setEditorBusy(true);
    setError(null);
    setNotice(null);
    try {
      await Promise.all(
        selectedItems.map((item) =>
          apiFetch(`/api/items/${encodeURIComponent(String(item.id))}`, { method: "DELETE" }),
        ),
      );
      setNotice(`${selectedItems.length} article${selectedItems.length > 1 ? "s archivés" : " archivé"}.`);
      clearItemSelection();
      await loadItems(search);
    } catch (err) {
      setError(formatApiError(err, "Archivage impossible."));
    } finally {
      setEditorBusy(false);
    }
  };

  const bulkDeleteSelected = async () => {
    if (!selectedItems.length || editorBusy || !canWriteItems) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Supprimer définitivement ${selectedItems.length} article${selectedItems.length > 1 ? "s" : ""} ?`,
      )
    ) {
      return;
    }
    setEditorBusy(true);
    setError(null);
    setNotice(null);
    try {
      await Promise.all(
        selectedItems.map((item) =>
          apiFetch(`/api/items/${encodeURIComponent(String(item.id))}?permanent=true`, { method: "DELETE" }),
        ),
      );
      setNotice(`${selectedItems.length} article${selectedItems.length > 1 ? "s supprimés" : " supprimé"}.`);
      clearItemSelection();
      await loadItems(search);
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setEditorBusy(false);
    }
  };
  const editingItem = useMemo(
    () => items.find((item) => String(item.id) === String(editingItemId)) || null,
    [editingItemId, items],
  );

  useEffect(() => {
    setPage(1);
  }, [filterMode, search]);
  const emptyState = useMemo(() => {
    if (search.trim()) {
      return {
        title: "Aucun article trouvé",
        description: `Aucun résultat pour « ${search.trim()} » avec ce filtre.`,
      };
    }
    if (filterMode === "archived") {
      return {
        title: "Aucun article archivé",
        description: "Les articles archivés apparaîtront ici quand vous voudrez les réactiver.",
      };
    }
    if (filterMode === "all") {
      return {
        title: "Aucun article pour le moment",
        description:
          "Créez vos premières prestations ou importez un CSV pour disposer d'un catalogue homogène dans toute l'application.",
      };
    }
    return {
      title: "Aucun article actif",
      description: "Créez un premier article ou réactivez un article archivé pour alimenter vos devis et factures.",
    };
  }, [filterMode, search]);
  const exportLabel =
    filterMode === "archived"
      ? "Exporter les archivés"
      : filterMode === "all"
        ? "Exporter tout le catalogue"
        : search.trim()
          ? "Exporter la vue filtrée"
          : "Exporter les actifs";
  const exportTitle =
    filterMode === "all"
      ? "Exporte tout le catalogue d'articles."
      : "Exporte les articles correspondant au filtre et à la recherche affichés.";

  return (
    <div>
      <AppPageHeader
        title="Articles"
        breadcrumb="Lignes réutilisables"
        description="Prestations et produits réutilisables dans les devis et factures."
        actions={
          <div className="flex items-center gap-2">
            {canWriteItems ? (
              <>
                <SecondaryButton onClick={() => resetEditor()}>
                  <Plus className="w-3.5 h-3.5" /> Nouvel article
                </SecondaryButton>
                <SecondaryButton onClick={onImportClick} disabled={importing}>
                  <Upload className="w-3.5 h-3.5" /> Import CSV
                </SecondaryButton>
              </>
            ) : null}
            <PrimaryButton onClick={onExport} aria-label={exportLabel} title={exportTitle}>
              {exportLabel}
            </PrimaryButton>
          </div>
        }
      />
      <div className="w-full space-y-5 p-5 lg:p-6">
        <NoticeBanner tone="info">
          Le catalogue d'articles sert de base commune aux devis et aux factures. Vous gagnez du temps, vous
          homogénéisez vos libellés et vous limitez les erreurs de TVA.
        </NoticeBanner>

        {importResult && <NoticeBanner tone="success">{importResult}</NoticeBanner>}
        {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
        {error && <NoticeBanner tone="warning">{error}</NoticeBanner>}

        {canWriteItems ? (
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onImportChange} />
        ) : null}
        <SalesListBlock
          tone="catalog"
          density="client"
          filters={[
            { value: "all", label: "Tous", count: items.length, accent: "module" },
            { value: "active", label: "Actifs", count: activeItems.length, accent: "success" },
            { value: "archived", label: "Archivés", count: archivedItems.length, accent: "muted" },
          ]}
          filterValue={filterMode}
          onFilterChange={(value) => setFilterMode(value as ItemFilterMode)}
          searchValue={search}
          onSearchChange={(value) => setSearch(value)}
          searchPlaceholder="Rechercher un article, un code unité…"
          searchWidth="26rem"
          rightExtras={
            canWriteItems && selectedItemCount > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <SecondaryButton type="button" onClick={clearItemSelection} disabled={editorBusy}>
                  <CheckSquare className="h-3.5 w-3.5" /> {selectedItemCount} sélectionné
                </SecondaryButton>
                <button
                  type="button"
                  onClick={() => void bulkArchiveSelected()}
                  disabled={editorBusy}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#99f6e4] bg-white px-3 text-xs font-semibold text-[#0f766e] transition-colors hover:bg-[#f0fdfa] disabled:cursor-wait disabled:opacity-60"
                >
                  <Archive className="h-3.5 w-3.5" /> Archiver
                </button>
                <button
                  type="button"
                  onClick={() => void bulkDeleteSelected()}
                  disabled={editorBusy}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#fecaca] bg-white px-3 text-xs font-semibold text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:cursor-wait disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Supprimer
                </button>
              </div>
            ) : null
          }
        >
          {loading ? (
            <div className="px-5 py-14">
              <LoadingCard label="Chargement du catalogue…" className="shadow-none border-0" />
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-8 py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                <Package2 className="h-5 w-5 text-[#cbd5e1]" />
              </div>
              <h3 className="mb-1 text-[#374151]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                {emptyState.title}
              </h3>
              <p className="mb-5 max-w-sm text-[#94a3b8]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                {emptyState.description}
              </p>
              {canWriteItems ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <PrimaryButton onClick={() => resetEditor()}>
                    <Plus className="w-3.5 h-3.5" /> Créer un article
                  </PrimaryButton>
                  <SecondaryButton onClick={onImportClick}>
                    <Upload className="w-3.5 h-3.5" /> Importer un CSV
                  </SecondaryButton>
                </div>
              ) : (
                <p className="text-xs font-medium text-[#64748b]">Consultation seule pour votre rôle.</p>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="pf-data-table w-full">
                  <thead>
                    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                      {canWriteItems ? (
                        <th className="px-4 py-3.5 text-left">
                          <input
                            type="checkbox"
                            checked={pageSelectionChecked}
                            onChange={togglePageSelection}
                            aria-label="Sélectionner les articles affichés"
                          />
                        </th>
                      ) : null}
                      {["Article", "Prix HT", "TVA", "Statut", ""].map((header, index) => (
                        <th
                          key={`${header || "action"}-${index}`}
                          className="px-5 py-3.5 text-left"
                          style={{
                            fontSize: "0.625rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "#94a3b8",
                            background: "#fafbfd",
                          }}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((item) => {
                      const isArchived = item.active === false;
                      const itemId = String(item.id);
                      return (
                        <tr key={item.id} className="hover:bg-[#f9fafb]/60 transition-colors">
                          {canWriteItems ? (
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={selectedItemIds.has(itemId)}
                                onChange={() => toggleItemSelection(itemId)}
                                aria-label={`Sélectionner ${item.name || "article"}`}
                              />
                            </td>
                          ) : null}
                          <td className="px-4 py-3">
                            <div className="min-w-0">
                              <div className="pf-row-title truncate">{item.name || "—"}</div>
                              <div className="pf-row-subtitle truncate">
                                {item.description || "Sans commentaire"}
                                {String(item.unit_code || "C62")
                                  .trim()
                                  .toUpperCase() !== "C62"
                                  ? ` · unité ${String(item.unit_code || "")
                                      .trim()
                                      .toUpperCase()}`
                                  : ""}
                              </div>
                              <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                                <span className="rounded-full bg-[#eef2ff] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#4338ca]">
                                  TVA {Number(item.vat_rate || 0)}%
                                </span>
                                <StatusPill
                                  status={isArchived ? "muted" : "ok"}
                                  label={isArchived ? "Archivé" : "Actif"}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="pf-table-amount">{money(item.unit_price || 0)}</span>
                          </td>
                          <td className="px-4 py-3 text-[#475569]">{Number(item.vat_rate || 0)}%</td>
                          <td className="px-4 py-3">
                            <StatusPill status={isArchived ? "muted" : "ok"} label={isArchived ? "Archivé" : "Actif"} />
                          </td>
                          <td className="px-4 py-3">
                            {canWriteItems ? (
                              <button
                                type="button"
                                onClick={() => resetEditor(item)}
                                className="pf-action-icon"
                                aria-label={`Modifier ${item.name || "article"}`}
                                title="Modifier"
                              >
                                <ArrowRight className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPagination
                page={page}
                totalItems={visibleItems.length}
                pageSize={pageSize}
                pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                itemLabel="article"
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1);
                  setPageSize(nextPageSize);
                }}
                pageSizeAriaLabel="Articles par page"
              />
            </>
          )}
        </SalesListBlock>
      </div>

      {editorOpen && canWriteItems && (
        <div className="fixed inset-0 z-50 bg-[#0f172a]/45 backdrop-blur-sm flex justify-end" onClick={closeEditor}>
          <div
            className="w-full max-w-xl h-full bg-white border-l border-[#e2e8f0] shadow-2xl overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="p-6 border-b border-[#eef2f7] flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                  {editingItemId ? "Modifier l'article" : "Nouvel article"}
                </h2>
              </div>
              <SecondaryButton onClick={closeEditor}>Fermer</SecondaryButton>
            </div>
            <div className="p-6 space-y-5">
              {editorError && <NoticeBanner tone="warning">{editorError}</NoticeBanner>}
              <Card className="space-y-4">
                <InputField
                  label="Désignation"
                  aria-label="Nom"
                  required
                  value={itemForm.name}
                  onChange={(event) => {
                    setItemForm((prev: any) => ({ ...prev, name: event.target.value }));
                    if (editorError === "Le nom de l'article est requis.") setEditorError(null);
                  }}
                  placeholder="Ex. Audit de sécurité applicative"
                />
                {!itemName ? (
                  <p className="-mt-2 text-xs font-medium text-[#dc2626]">
                    Renseignez une désignation avant d'enregistrer l'article.
                  </p>
                ) : null}
                <div>
                  <label className="block text-[#374151] mb-1.5 text-sm font-medium">Commentaire</label>
                  <textarea
                    rows={4}
                    value={itemForm.description}
                    onChange={(event) => setItemForm((prev: any) => ({ ...prev, description: event.target.value }))}
                    placeholder="Commentaire repris sous la ligne du document"
                    className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] resize-none text-sm"
                  />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <InputField
                    label="Prix unitaire HT"
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.unit_price}
                    onChange={(event) => setItemForm((prev: any) => ({ ...prev, unit_price: event.target.value }))}
                    placeholder="0.00"
                  />
                  <InputField
                    label="TVA (%)"
                    aria-label="TVA %"
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.vat_rate}
                    onChange={(event) => setItemForm((prev: any) => ({ ...prev, vat_rate: event.target.value }))}
                    placeholder="20"
                  />
                  <InputField
                    label="Code unité"
                    value={itemForm.unit_code}
                    onChange={(event) =>
                      setItemForm((prev: any) => ({ ...prev, unit_code: event.target.value.toUpperCase() }))
                    }
                    placeholder="C62"
                  />
                </div>
                {editingItemId && editingItem ? (
                  <div className="flex flex-col gap-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#94a3b8]">Statut article</p>
                      <div className="mt-1">
                        <StatusPill
                          status={editingItem.active === false ? "muted" : "ok"}
                          label={editingItem.active === false ? "Archivé" : "Actif"}
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {editingItem.active === false ? (
                        <button
                          type="button"
                          onClick={() => void setItemActive(editingItem, true)}
                          disabled={editorBusy}
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-white px-3 text-xs font-semibold text-[#059669] transition-colors hover:bg-[#f0fdf4] disabled:cursor-wait disabled:opacity-60"
                        >
                          Réactiver
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void setItemActive(editingItem, false)}
                          disabled={editorBusy}
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#99f6e4] bg-white px-3 text-xs font-semibold text-[#0f766e] transition-colors hover:bg-[#f0fdfa] disabled:cursor-wait disabled:opacity-60"
                        >
                          <Archive className="h-3.5 w-3.5" /> Archiver
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void deleteItemPermanently(editingItem)}
                        disabled={editorBusy}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#fecaca] bg-white px-3 text-xs font-semibold text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:cursor-wait disabled:opacity-60"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Supprimer
                      </button>
                    </div>
                  </div>
                ) : null}
              </Card>
              <div className="flex justify-end gap-2">
                <SecondaryButton type="button" onClick={closeEditor} disabled={editorBusy}>
                  Annuler
                </SecondaryButton>
                <PrimaryButton type="button" onClick={saveItem} disabled={editorBusy || !itemFormCanSave}>
                  {editorBusy
                    ? "Enregistrement…"
                    : !itemFormCanSave
                      ? "Désignation requise"
                      : editingItemId
                        ? "Enregistrer"
                        : "Créer l'article"}
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReceivablesPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const paymentsGate = resolveProFeatureGate(capabilities, "payments");
  const paymentsEnabled = paymentsGate.enabled;
  const [bucket, setBucket] = useState<"all" | "overdue" | "due_soon" | "open">("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [dashboard, setDashboard] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null);
  const [followupRow, setFollowupRow] = useState<any | null>(null);
  const [followupSending, setFollowupSending] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.receivables.pageSize.v1");

  const loadReceivables = async (currentBucket = bucket, currentQuery = query) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentBucket !== "all") params.set("bucket", currentBucket);
      if (currentQuery.trim()) params.set("q", currentQuery.trim());
      const [listRes, dashboardRes] = await Promise.allSettled([
        rawApi(`/api/collections/receivables?${params.toString()}`),
        rawApi("/api/collections/dashboard"),
      ]);

      if (listRes.status !== "fulfilled" || !listRes.value.ok) {
        const payload = listRes.status === "fulfilled" ? await listRes.value.json().catch(() => null) : null;
        throw new Error(
          extractUserFacingApiMessage(
            payload,
            listRes.status === "fulfilled" ? listRes.value.status : undefined,
            "Impossible de charger les factures ouvertes.",
          ),
        );
      }
      const data = await listRes.value.json().catch(() => ({ items: [], summary: null }));
      setRows(Array.isArray(data?.items) ? data.items : []);
      setSummary(data?.summary || null);

      if (dashboardRes.status === "fulfilled" && dashboardRes.value.ok) {
        const dashboardData = await dashboardRes.value.json().catch(() => null);
        setDashboard(dashboardData || null);
      } else {
        setDashboard(null);
      }
    } catch (err) {
      setRows([]);
      setSummary(null);
      setDashboard(null);
      setError(formatApiError(err, "Impossible de charger les factures ouvertes."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading || !paymentsEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      await loadReceivables(bucket, query);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, paymentsEnabled, query, sessionLoading]);

  const exportCsv = () => {
    const params = new URLSearchParams();
    if (bucket !== "all") params.set("bucket", bucket);
    if (query.trim()) params.set("q", query.trim());
    window.location.assign(
      apiUrl(`/api/collections/receivables.csv${params.toString() ? `?${params.toString()}` : ""}`),
    );
  };

  const refresh = async () => {
    setNotice(null);
    await loadReceivables(bucket, query);
  };

  const copyPortalLink = async (row: any) => {
    if (!row?.id || busyInvoiceId) return;
    setBusyInvoiceId(row.id);
    setError(null);
    setNotice(null);
    try {
      let absoluteUrl = row.public_path ? new URL(row.public_path, window.location.origin).toString() : "";
      if (!absoluteUrl) {
        const share: any = await apiFetch(`/api/invoices/${row.id}/share`, { method: "POST" });
        absoluteUrl = String(share?.public_url || "");
      }
      if (!absoluteUrl) {
        throw new Error("Lien portail indisponible pour cette facture.");
      }
      await copyTextToClipboard(absoluteUrl);
      setNotice(`Lien public copié pour ${row.number || "la facture"}.`);
      if (!row.public_path) {
        await loadReceivables(bucket, query);
      }
    } catch (err) {
      setError(formatApiError(err, "Activation ou copie du lien impossible."));
    } finally {
      setBusyInvoiceId(null);
    }
  };

  const openFollowup = (row: any) => {
    if (!row?.id || busyInvoiceId) return;
    setFollowupRow(row);
    setError(null);
    setNotice(null);
  };

  const sendFollowup = async (payload: InvoiceEmailPayload) => {
    const row = followupRow;
    if (!row?.id || busyInvoiceId) return;
    setBusyInvoiceId(row.id);
    setFollowupSending(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await apiFetch(`/api/invoices/${row.id}/followup`, {
        method: "POST",
        body: JSON.stringify({
          to: payload.to || null,
          subject: payload.subject,
          body: payload.body,
          include_pdf: payload.attachInvoice,
          include_link: true,
        }),
      });
      setFollowupRow(null);
      if (result?.delivery === "log_only" || result?.email_sent === false || result?.status === "log_only") {
        setNotice(
          `Relance enregistrée pour ${row.number || "la facture"} : le canal email n'est pas configuré, aucun email n'a été envoyé.`,
        );
      } else {
        setNotice(`Relance mise en file pour ${row.number || "la facture"}.`);
      }
      await loadReceivables(bucket, query);
    } catch (err) {
      setError(formatApiError(err, "Relance impossible."));
    } finally {
      setBusyInvoiceId(null);
      setFollowupSending(false);
    }
  };

  const eligibleNowCount = useMemo(
    () => rows.filter((row) => row.followup_state === "eligible_now" && row.can_followup).length,
    [rows],
  );
  const scheduledCount = useMemo(
    () => rows.filter((row) => row.followup_state === "scheduled" && row.can_followup).length,
    [rows],
  );

  const topDebtors = Array.isArray(dashboard?.top_debtors) ? dashboard.top_debtors : [];
  const pageRows = useMemo(() => paginateList(rows, page, pageSize), [rows, page, pageSize]);
  const followupSubject = `Relance - facture ${followupRow?.number || ""}`.trim();
  const followupBody = [
    `Bonjour ${followupRow?.customer_name || ""},`.trim(),
    "",
    `Sauf erreur de notre part, la facture ${followupRow?.number || ""} reste à régler.`,
    `Solde dû : ${money(followupRow?.balance_due || 0, followupRow?.currency || "EUR")}.`,
    ...(followupRow?.due_date ? [`Échéance : ${formatDateFr(followupRow.due_date, "—")}.`] : []),
    "",
    "Si le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue.",
  ].join("\n");

  useEffect(() => {
    setPage(1);
  }, [bucket, query]);

  const buckets = [
    { key: "all", label: "Toutes les créances" },
    { key: "overdue", label: "En retard" },
    { key: "due_soon", label: "À échéance proche" },
    { key: "open", label: "À venir" },
  ] as const;
  const bucketCounts = {
    all: Number(summary?.count_total || rows.length),
    overdue: Number(summary?.count_overdue || rows.filter((row) => Number(row?.days_overdue || 0) > 0).length),
    due_soon: Number(
      summary?.count_due_soon ||
        rows.filter((row) => Number(row?.days_overdue || 0) <= 0 && Number(row?.days_until_due || 999) <= 7).length,
    ),
    open: Number(
      summary?.count_open ||
        rows.filter((row) => Number(row?.days_overdue || 0) <= 0 && Number(row?.days_until_due || 999) > 7).length,
    ),
  };

  const priorityPill = (row: any) => {
    const days = Number(row?.days_overdue || 0);
    if (days >= 30) return { status: "danger", label: "Urgent 30j+" };
    if (row?.followup_state === "eligible_now" && row?.can_followup) return { status: "warn", label: "Relancer" };
    if (days > 0) return { status: "danger", label: `Retard ${days}j` };
    if (row?.followup_state === "scheduled") return { status: "info", label: "Planifié" };
    return { status: "muted", label: "Suivi" };
  };

  const emailProofLine = (row: any) => {
    const proof = emailDeliveryProof(row);
    const dateLabel = proof.date ? formatDateTimeFr(proof.date, "") : "";
    const className =
      proof.status === "ok"
        ? "text-[#16a34a]"
        : proof.status === "danger"
          ? "text-[#dc2626]"
          : proof.status === "warn"
            ? "text-[#d97706]"
            : proof.status === "info"
              ? "text-[#1d4ed8]"
              : "text-[#94a3b8]";
    return {
      label: dateLabel && proof.status !== "muted" ? `${proof.shortLabel} · ${dateLabel}` : proof.label,
      className,
      title: proof.title,
    };
  };

  if (!sessionLoading && !paymentsEnabled) {
    return (
      <div>
        <AppPageHeader
          title="Factures en retard"
          breadcrumb="Facturation"
          description="Le suivi des créances, règlements et relances est disponible avec le plan Pro."
        />
        <WorkbenchPage>
          <UpgradeNoticeCard
            title={
              paymentsGate.reactivationRequired
                ? paymentsGate.statusLabel
                : "Suivi des paiements disponible avec le plan Pro"
            }
            description={
              paymentsGate.reactivationDescription ||
              "Starter reste limité aux clients, devis, factures classiques et PDF. Le plan Pro ajoute les règlements, les relances fondées sur le solde réel et le suivi des créances."
            }
            ctaLabel={paymentsGate.ctaLabel}
            ctaHref={paymentsGate.ctaHref}
            note={paymentsGate.reactivationNote || undefined}
          />
        </WorkbenchPage>
      </div>
    );
  }

  return (
    <div>
      <AppPageHeader
        title="Factures en retard"
        breadcrumb="Trésorerie"
        description="Factures ouvertes à suivre et paiements attendus."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={() => window.location.assign("/app/cash")}>Trésorerie</SecondaryButton>
            <SecondaryButton onClick={() => void refresh()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
            <PrimaryButton
              onClick={exportCsv}
              aria-label="Exporter la vue filtrée des factures ouvertes"
              title="Exporte les factures ouvertes correspondant aux filtres affichés."
            >
              Exporter la vue filtrée
            </PrimaryButton>
          </div>
        }
      />
      <WorkbenchPage>
        {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
        {error && <NoticeBanner tone="warning">{error}</NoticeBanner>}
        <NoticeBanner tone="info" title="Suivi manuel">
          Les factures ouvertes sont suivies depuis les échéances et les paiements saisis. Prépare les relances au cas
          par cas pour éviter d'écrire à un client déjà réglé hors outil.
        </NoticeBanner>

        <SalesMetricsGrid>
          <SalesMetricCard
            tone="receivables"
            density="client"
            accent="danger"
            label="Créances ouvertes"
            value={money(summary?.total_balance_due || 0)}
            detail={`${summary?.count_total || 0} facture(s)`}
            icon={<Wallet className="h-4 w-4" />}
          />
          <SalesMetricCard
            tone="receivables"
            density="client"
            accent="warning"
            label="En retard"
            value={money(summary?.overdue_balance_due || 0)}
            detail={`${summary?.count_overdue || 0} facture(s)`}
            icon={<AlertCircle className="h-4 w-4" />}
          />
          <SalesMetricCard
            tone="receivables"
            density="client"
            accent="success"
            label="Relances à lancer"
            value={eligibleNowCount}
            detail={scheduledCount ? `${scheduledCount} planifiée(s)` : "Aucune planifiée"}
            icon={<MailCheck className="h-4 w-4" />}
          />
          <SalesMetricCard
            tone="receivables"
            density="client"
            accent="info"
            label="Clients ouverts"
            value={topDebtors.length}
            detail={topDebtors.length > 0 ? "Suivi prioritaire" : "Rien à surveiller"}
            icon={<Users className="h-4 w-4" />}
          />
        </SalesMetricsGrid>

        <SalesListBlock
          tone="receivables"
          density="client"
          filters={buckets.map((item) => ({
            value: item.key,
            label: item.label,
            count: bucketCounts[item.key],
            accent:
              item.key === "overdue"
                ? "danger"
                : item.key === "due_soon"
                  ? "warning"
                  : item.key === "open"
                    ? "info"
                    : "module",
          }))}
          filterValue={bucket}
          onFilterChange={(value) => setBucket(value as typeof bucket)}
          searchValue={query}
          onSearchChange={(value) => setQuery(value)}
          searchPlaceholder="Rechercher un client, une facture, un PO…"
          searchWidth="26rem"
        >
          {loading ? (
            <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
              Chargement des factures ouvertes…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-14 text-center">
              <div className="flex flex-col items-center gap-2">
                <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                  <Wallet className="h-5 w-5 text-[#cbd5e1]" />
                </div>
                <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                  Aucune créance à afficher
                </p>
                <p className="max-w-xl text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  Aucune facture ouverte ne correspond aux filtres en cours. Vous pouvez revenir sur “Toutes les
                  créances” ou rechercher un autre client.
                </p>
                {bucket !== "all" || query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setBucket("all");
                      setQuery("");
                    }}
                    className="mt-1 text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                    style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                  >
                    Réinitialiser les filtres
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div role="table" aria-label="Créances clients" className="overflow-x-auto">
              <div className="min-w-[1060px]">
                <div
                  role="row"
                  className="grid grid-cols-[minmax(180px,1.15fr)_minmax(150px,0.9fr)_132px_132px_146px_132px_200px] border-b border-[#f1f5f9] bg-[#fafbfd] px-4 py-3.5 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]"
                >
                  <div role="columnheader">Facture</div>
                  <div role="columnheader">Client</div>
                  <div role="columnheader">Échéance</div>
                  <div role="columnheader">Solde</div>
                  <div role="columnheader">Priorité</div>
                  <div role="columnheader">Portail</div>
                  <div role="columnheader" className="text-right">
                    Actions
                  </div>
                </div>
                {pageRows.map((row) => {
                  const dueDateLabel = formatDateFr(row.due_date, "—");
                  const isOverdue = Number(row.days_overdue || 0) > 0;
                  const portalUrl = row.public_path
                    ? new URL(
                        row.public_path,
                        typeof window !== "undefined" ? window.location.origin : "http://localhost",
                      ).toString()
                    : null;
                  const priority = priorityPill(row);
                  const emailProof = emailProofLine(row);
                  const followupBlockLabel = invoiceFollowupBlockLabel(row.followup_block_reason);
                  return (
                    <div
                      role="row"
                      key={row.id}
                      className="grid grid-cols-[minmax(180px,1.15fr)_minmax(150px,0.9fr)_132px_132px_146px_132px_200px] items-center border-b border-[#f1f5f9] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#f8fafc]"
                    >
                      <div role="cell" className="min-w-0">
                        <Link
                          to={`/app/invoices/${row.id}`}
                          className="truncate text-sm font-semibold text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                        >
                          {row.number || row.id}
                        </Link>
                      </div>

                      <div role="cell" className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#111827]">
                          {row.customer_name || "Client"}
                        </div>
                        <div className="mt-0.5 truncate text-[0.6875rem] text-[#94a3b8]">
                          {row.currency || "EUR"} · {row.reminder_count || 0} relance(s)
                        </div>
                      </div>

                      <div role="cell">
                        <div className="text-sm font-semibold text-[#111827]">{dueDateLabel}</div>
                        <div
                          className={
                            isOverdue
                              ? "mt-0.5 text-[0.6875rem] font-bold text-[#dc2626]"
                              : "mt-0.5 text-[0.6875rem] font-medium text-[#94a3b8]"
                          }
                        >
                          {isOverdue ? `${row.days_overdue} j retard` : "Dans les temps"}
                        </div>
                      </div>

                      <div role="cell">
                        <div className="text-sm font-bold text-[#0f172a]">{money(row.balance_due || 0)}</div>
                        <div className="mt-0.5 text-[0.6875rem] text-[#94a3b8]">
                          Total {money(row.total_inc_vat || 0)}
                        </div>
                      </div>

                      <div role="cell">
                        <StatusPill status={priority.status as any} label={priority.label} />
                        <div className="mt-0.5 text-[0.6875rem] text-[#94a3b8]">
                          {row.followup_state === "scheduled"
                            ? formatDateFr(row.next_followup_at, "Planifiée")
                            : row.followup_state === "eligible_now" && row.can_followup
                              ? "À lancer"
                              : followupBlockLabel || "Aucune prévue"}
                        </div>
                        <div
                          className={`mt-0.5 truncate text-[0.6875rem] font-semibold ${emailProof.className}`}
                          title={emailProof.title}
                        >
                          {emailProof.label}
                        </div>
                      </div>

                      <div role="cell">
                        {portalUrl ? (
                          <button
                            type="button"
                            onClick={() => void copyPortalLink(row)}
                            disabled={busyInvoiceId === row.id}
                            className="inline-flex h-8 w-[5.75rem] items-center justify-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-white px-3 text-xs font-semibold leading-none text-[#475569] transition-colors hover:bg-[#f8fafc]"
                            style={{ fontSize: "0.75rem" }}
                            title="Copier le lien public"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copier
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void copyPortalLink(row)}
                            disabled={busyInvoiceId === row.id}
                            className="inline-flex h-8 w-[5.75rem] items-center justify-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3 text-xs font-semibold leading-none text-[#1d4ed8] transition-colors hover:bg-[#dbeafe] disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ fontSize: "0.75rem" }}
                            title="Activer puis copier le lien public"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Activer
                          </button>
                        )}
                      </div>

                      <div role="cell" className="flex items-center justify-end gap-2">
                        <Link
                          to={`/app/invoices/${row.id}`}
                          className="inline-flex h-8 w-[5.75rem] items-center justify-center rounded-lg border border-[#e2e8f0] bg-white px-3 text-xs font-semibold leading-none text-[#111827] transition-colors hover:bg-[#f8fafc]"
                          style={{ fontSize: "0.75rem" }}
                        >
                          Ouvrir
                        </Link>
                        <button
                          type="button"
                          onClick={() => openFollowup(row)}
                          disabled={!row.can_followup || busyInvoiceId === row.id}
                          title={!row.can_followup ? followupBlockLabel || "Relance indisponible" : undefined}
                          className="inline-flex h-8 w-[5.75rem] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold leading-none text-white transition-all disabled:cursor-not-allowed disabled:opacity-60"
                          style={{
                            background: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
                            fontSize: "0.75rem",
                          }}
                        >
                          {busyInvoiceId === row.id ? (
                            <Clock3 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                          ) : (
                            <MailCheck className="h-3.5 w-3.5 shrink-0" />
                          )}
                          <span>{busyInvoiceId === row.id ? "Envoi…" : "Relancer"}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <ListPagination
            page={page}
            totalItems={rows.length}
            pageSize={pageSize}
            pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
            itemLabel="créance"
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPage(1);
              setPageSize(nextPageSize);
            }}
            pageSizeAriaLabel="Créances par page"
            action={
              bucket !== "all" || query ? (
                <button
                  type="button"
                  onClick={() => {
                    setBucket("all");
                    setQuery("");
                  }}
                  className="text-xs font-medium text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                >
                  Réinitialiser
                </button>
              ) : (
                <span className="text-xs text-[#94a3b8]">Vue factures en retard</span>
              )
            }
          />
        </SalesListBlock>
      </WorkbenchPage>
      <InvoiceEmailModal
        open={Boolean(followupRow)}
        previewEndpoint={followupRow?.id ? `/api/invoices/${followupRow.id}/followup/preview` : null}
        previewKind="followup"
        title="Relancer la facture par email"
        submitLabel="Envoyer la relance"
        defaultEmail=""
        allowEmptyRecipient
        recipientPlaceholder="Contacts facturation du client"
        defaultFrom={null}
        defaultSubject={followupSubject}
        defaultBody={followupBody}
        defaultAttachmentName={`facture-${followupRow?.number || "document"}.pdf`}
        defaultAttachInvoice={false}
        showAttachmentFormat={false}
        showCopySender={false}
        showCcBcc={false}
        attachmentLabel="Ajouter le PDF de la facture en pièce jointe"
        helperText="L'aperçu reprend exactement le contenu qui sera envoyé au client."
        submitting={followupSending}
        onSubmit={sendFollowup}
        onClose={() => setFollowupRow(null)}
      />
    </div>
  );
}

export function GetStartedPage() {
  const { capabilities } = useSession({ autoRefresh: false });
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const [stepsState, setStepsState] = useState({
    company: false,
    customer: false,
    quote: false,
    invoice: false,
  });
  const { summary } = useWorkspaceSummary();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [companyRes, customersRes, quotesRes, invoicesRes] = await Promise.allSettled([
          rawApi("/api/company/profile"),
          rawApi("/api/customers?limit=1&offset=0"),
          rawApi("/api/quotes?limit=1&offset=0"),
          rawApi("/api/invoices?limit=1&offset=0"),
        ]);

        const next = {
          company: false,
          customer: false,
          quote: false,
          invoice: false,
        };

        if (companyRes.status === "fulfilled" && companyRes.value.ok) {
          const company = await companyRes.value.json().catch(() => null);
          const hasAddress = Boolean(company?.address_line1 || company?.address);
          next.company = Boolean(
            company?.name &&
            company?.siret &&
            (company?.vat_number || company?.vat_exemption_notice || company?.vat_regime) &&
            hasAddress &&
            company?.postal_code &&
            company?.city,
          );
        }

        if (customersRes.status === "fulfilled" && customersRes.value.ok) {
          const customers = await customersRes.value.json().catch(() => []);
          next.customer = Array.isArray(customers) && customers.length > 0;
        }

        if (quotesRes.status === "fulfilled" && quotesRes.value.ok) {
          const quotes = await quotesRes.value.json().catch(() => []);
          next.quote = Array.isArray(quotes) && quotes.length > 0;
        }

        if (invoicesRes.status === "fulfilled" && invoicesRes.value.ok) {
          const invoices = await invoicesRes.value.json().catch(() => []);
          next.invoice = Array.isArray(invoices) && invoices.length > 0;
        }

        if (!cancelled) {
          setStepsState(next);
        }
      } catch {
        if (!cancelled) {
          setStepsState((prev) => ({ ...prev }));
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const statusFromSummary = summary
    ? {
        company: Boolean(summary?.company?.complete),
        customer: Number(summary?.customers?.count || 0) > 0,
        quote: Number(summary?.quotes?.count || 0) > 0,
        invoice: Number(summary?.invoices?.count || 0) > 0,
      }
    : stepsState;

  const steps = [
    {
      n: 1,
      title: "Compléter votre entreprise",
      desc: "Obligatoire en France : SIRET, TVA (ou exonération), mentions légales.",
      note: "Débloque une base propre pour les devis, factures et contrôles réglementaires.",
      done: statusFromSummary.company,
      href: "/app/company",
      icon: ShieldCheck,
      accent: "#1d4ed8",
      tint: "#eff6ff",
    },
    {
      n: 2,
      title: "Ajouter votre premier client",
      desc: "Nom + adresse, puis SIRET si c’est une entreprise française.",
      note: "Vous pourrez ensuite générer un devis ou une facture en quelques clics.",
      done: statusFromSummary.customer,
      href: "/app/customers/new",
      icon: Users,
      accent: "#059669",
      tint: "#ecfdf5",
    },
    {
      n: 3,
      title: "Envoyer un premier devis",
      desc: "Valide le parcours client avec partage, consultation et acceptation.",
      note: "Vous confirmez que votre tunnel commercial fonctionne déjà en conditions réelles.",
      done: statusFromSummary.quote,
      href: "/app/quotes/new",
      icon: MailCheck,
      accent: "#0891b2",
      tint: "#ecfeff",
    },
    {
      n: 4,
      title: "Émettre une première facture",
      desc:
        einvoicingEnabled && paymentsEnabled
          ? "Vérifiez le PDF, Factur-X, le portail client et le suivi d’encaissement."
          : "Vérifiez le PDF, le lien client et les mentions obligatoires.",
      note: "C’est la validation finale avant vos premiers usages clients réels.",
      done: statusFromSummary.invoice,
      href: "/app/invoices/new",
      icon: FileText,
      accent: "#d97706",
      tint: "#fffbeb",
    },
  ];

  const completedSteps = steps.filter((step) => step.done).length;
  const progress = summary ? Number(summary?.setup?.percent || 0) : Math.round((completedSteps / steps.length) * 100);
  const companyReady = statusFromSummary.company;
  const customersCount = Number(summary?.customers?.count || 0);
  const quotesCount = Number(summary?.quotes?.count || 0);
  const invoicesCount = Number(summary?.invoices?.count || 0);

  return (
    <div>
      <AppPageHeader
        title="Démarrage en 5 minutes"
        breadcrumb="Démarrage"
        description="Le parcours le plus simple pour être prêt à envoyer vos premiers devis et factures B2B."
      />
      <div className="w-full px-5 pb-8 pt-5 lg:px-7">
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <div className="space-y-3">
              <SectionTitle
                action={
                  <span className="text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                    {completedSteps}/{steps.length} validée(s)
                  </span>
                }
              >
                Checklist essentielle
              </SectionTitle>
              <div className="grid gap-3 md:grid-cols-2">
                {steps.map((step) => {
                  const StepIcon = step.icon;
                  return (
                    <div
                      key={step.n}
                      className={`rounded-2xl border bg-white p-4 ${
                        step.done ? "border-[#bbf7d0]" : "border-[#e2e8f0]"
                      }`}
                      style={{ boxShadow: "0 10px 24px rgba(15,23,42,0.04)" }}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                          style={{
                            background: step.done ? "#ecfdf5" : step.tint,
                            color: step.done ? "#16a34a" : step.accent,
                          }}
                        >
                          {step.done ? <CheckCircle className="h-4 w-4" /> : <StepIcon className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-[0.66rem] font-[820] uppercase tracking-[0.08em] text-[#94a3b8]">
                              Étape {step.n}
                            </span>
                            <StatusPill status={step.done ? "ok" : "warn"} label={step.done ? "Validée" : "À faire"} />
                          </div>
                          <h3 className="text-[0.92rem] font-[780] leading-tight text-[#0f172a]">{step.title}</h3>
                          <p className="mt-2 text-[0.78rem] leading-5 text-[#64748b]">{step.desc}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center justify-between gap-3 border-t border-[#eef2f7] pt-3">
                        <span className="min-w-0 text-[0.72rem] leading-5 text-[#94a3b8]">{step.note}</span>
                        {step.done ? (
                          <span className="shrink-0 rounded-full border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-1.5 text-[0.72rem] font-bold text-[#16a34a]">
                            En place
                          </span>
                        ) : (
                          <PrimaryLinkButton to={step.href} className="shrink-0 px-3 py-1.5 text-[0.72rem]">
                            Ouvrir
                          </PrimaryLinkButton>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-20">
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Progression</div>
                  <div className="mt-2 text-[1.55rem] font-[850] text-[#0f172a]">{progress}%</div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff6ff] text-[#2563eb]">
                  <ShieldCheck className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-3 text-[0.76rem] text-[#64748b]">
                {completedSteps} étape(s) validée(s) sur {steps.length}
              </div>
            </Card>

            <Card>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Base métier</div>
                <StatusPill status={companyReady ? "ok" : "warn"} label={companyReady ? "OK" : "À finir"} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["Clients", customersCount],
                  ["Devis", quotesCount],
                  ["Factures", invoicesCount],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-2 py-3 text-center">
                    <div className="text-[0.68rem] font-bold text-[#94a3b8]">{label}</div>
                    <div className="mt-1 text-sm font-[850] tabular-nums text-[#0f172a]">{value}</div>
                  </div>
                ))}
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

export function OnboardingPage() {
  const { summary, reload: reloadSummary } = useWorkspaceSummary();
  const { subscriptionStatus, plan } = useSession({ autoRefresh: false });
  const [loading, setLoading] = useState(true);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lookupInput, setLookupInput] = useState("");
  const [customersCountFallback, setCustomersCountFallback] = useState<number | null>(null);
  const [skippedSteps, setSkippedSteps] = useState<Record<string, boolean>>({});
  const [billingHref, setBillingHref] = useState("/app/billing?onboarding=subscription");
  const [checkoutRequested, setCheckoutRequested] = useState(false);
  const [profile, setProfile] = useState<any>({
    name: "",
    siret: "",
    vat_number: "",
    legal_form: "",
    address_line1: "",
    address_line2: "",
    postal_code: "",
    city: "",
    country_code: "FR",
    legal_mentions: "",
  });
  const skipStorageKey = "pixfacture:onboarding:skipped";

  useUnsavedChanges(dirty);

  const updateProfile = useCallback((patch: any) => {
    setProfile((prev: any) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(skipStorageKey);
      setSkippedSteps(stored ? JSON.parse(stored) || {} : {});
    } catch {
      setSkippedSteps({});
    }
  }, [skipStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const planParam = (params.get("plan") || window.localStorage.getItem("preferred_plan") || "").trim().toLowerCase();
    const periodParam = (params.get("period") || window.localStorage.getItem("preferred_billing_period") || "")
      .trim()
      .toLowerCase();
    const wantsCheckout = params.get("checkout") === "1" || window.localStorage.getItem("preferred_checkout") === "1";
    const billingParams = new URLSearchParams({ onboarding: "subscription" });
    if (planParam === "starter" || planParam === "pro") billingParams.set("plan", planParam);
    if (periodParam === "monthly" || periodParam === "yearly") billingParams.set("period", periodParam);
    if (wantsCheckout) billingParams.set("checkout", "1");
    setCheckoutRequested(wantsCheckout);
    setBillingHref(`/app/billing?${billingParams.toString()}`);
  }, []);

  const persistSkippedSteps = useCallback(
    (next: Record<string, boolean>) => {
      setSkippedSteps(next);
      try {
        window.localStorage.setItem(skipStorageKey, JSON.stringify(next));
      } catch {
        // Local storage can be disabled in hardened browsers; the visible state still updates.
      }
    },
    [skipStorageKey],
  );

  const setStepSkipped = useCallback(
    (stepId: string, skipped: boolean) => {
      persistSkippedSteps({ ...skippedSteps, [stepId]: skipped });
    },
    [persistSkippedSteps, skippedSteps],
  );

  const resetSkippedSteps = useCallback(() => {
    persistSkippedSteps({});
  }, [persistSkippedSteps]);

  const loadCustomersCountFallback = useCallback(async () => {
    try {
      const res = await rawApi("/api/customers?limit=1");
      if (!res.ok) return;
      const payload = await res.json().catch(() => null);
      if (Array.isArray(payload)) {
        setCustomersCountFallback(payload.length);
        return;
      }
      if (Array.isArray(payload?.items)) {
        setCustomersCountFallback(Number(payload?.total ?? payload.items.length));
        return;
      }
      if (Array.isArray(payload?.customers)) {
        setCustomersCountFallback(Number(payload?.total ?? payload.customers.length));
        return;
      }
      if (Array.isArray(payload?.data)) {
        setCustomersCountFallback(Number(payload?.total ?? payload.data.length));
      }
    } catch {
      // The workspace summary remains the source of truth if this lightweight fallback fails.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await rawApi("/api/company/profile");
        if (!res.ok) {
          const message = await parseErrorFromResponse(res, "Impossible de charger le dossier entreprise.");
          throw new Error(message);
        }
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        setProfile({
          name: payload?.name || "",
          siret: formatFrenchBusinessIdInput(payload?.siret || ""),
          vat_number: formatVatNumberInput(payload?.vat_number || ""),
          legal_form: payload?.legal_form || "",
          address_line1: payload?.address_line1 || payload?.address || "",
          address_line2: payload?.address_line2 || "",
          postal_code: payload?.postal_code || "",
          city: payload?.city || "",
          country_code: (payload?.country_code || "FR").toUpperCase(),
          legal_mentions: payload?.legal_mentions || "",
        });
        setLookupInput(formatFrenchBusinessIdInput(payload?.siret || ""));
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Impossible de charger le dossier entreprise."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadCustomersCountFallback();
  }, [loadCustomersCountFallback]);

  const companyReady = isCompanyProfileReady(profile);
  const subscriptionActive = isSubscriptionAccessReady(subscriptionStatus);
  const subscriptionReady = subscriptionActive;
  const billingFollowupRequested = checkoutRequested && subscriptionActive;
  const customersCount = Math.max(Number(summary?.customers?.count || 0), customersCountFallback ?? 0);
  const documentsCount = Number(summary?.quotes?.count || 0) + Number(summary?.invoices?.count || 0);
  const completedSteps = [companyReady, subscriptionReady, customersCount > 0, documentsCount > 0].filter(
    Boolean,
  ).length;
  const completion = Math.round((completedSteps / 4) * 100);
  const businessIdDigits = digitsOnly(lookupInput || profile.siret);
  const lookupKind = detectFrenchBusinessIdKind(businessIdDigits);
  const lookupReady = businessIdDigits.length === 9 || businessIdDigits.length === 14;
  const nextHref = !companyReady
    ? "/app/company"
    : !subscriptionReady
      ? billingHref
      : customersCount === 0
        ? "/app/customers/new"
        : documentsCount === 0
          ? "/app/new"
          : "/app/dashboard";
  const nextLabel = !companyReady
    ? "Finaliser l'entreprise"
    : !subscriptionReady
      ? checkoutRequested
        ? "Finaliser l'abonnement"
        : "Choisir mon abonnement"
      : customersCount === 0
        ? "Créer mon premier client"
        : documentsCount === 0
          ? "Créer mon premier document"
          : "Ouvrir le tableau de bord";
  const customerSkipped = Boolean(skippedSteps.customer) && customersCount === 0;
  const hasSkippedSteps = Object.values(skippedSteps).some(Boolean);
  const customerStatus = customersCount > 0 ? "ok" : !subscriptionReady ? "muted" : customerSkipped ? "muted" : "warn";
  const customerStatusLabel =
    customersCount > 0
      ? `${customersCount} client(s)`
      : !subscriptionReady
        ? "Après abonnement"
        : customerSkipped
          ? "Ignoré"
          : "À faire";
  const steps = [
    {
      title: "Entreprise",
      ok: companyReady,
      href: "/app/company",
      helper: companyReady
        ? "SIRET, adresse et mentions prêts."
        : "Renseignez le SIREN/SIRET puis préremplissez les données légales.",
      cta: companyReady ? "Vérifier" : "Compléter",
    },
    {
      title: "Abonnement",
      ok: subscriptionReady,
      href: billingHref,
      helper: subscriptionReady
        ? billingFollowupRequested
          ? `Essai Pro de ${TRIAL_DAYS} jours actif, limité aux brouillons et prévisualisations. Le plan demandé pourra être confirmé depuis la facturation.`
          : `Accès ${plan ? `plan ${String(plan).toUpperCase()}` : "abonnement"} actif.`
        : checkoutRequested
          ? "Terminez la confirmation du plan demandé avant les écrans métier."
          : "Choisissez Starter ou Pro avant d'utiliser l'application.",
      cta: billingFollowupRequested ? "Finaliser" : subscriptionReady ? "Vérifier" : "Choisir",
    },
    {
      title: "Client",
      ok: customersCount > 0,
      href: subscriptionReady ? "/app/customers/new" : billingHref,
      helper:
        customersCount > 0
          ? `${customersCount} client(s) déjà disponible(s).`
          : !subscriptionReady
            ? "Disponible juste après l'abonnement."
            : customerSkipped
              ? "Étape ignorée temporairement."
              : "Ajoutez un client avant d'envoyer un devis propre.",
      cta:
        customersCount > 0 ? "Voir" : !subscriptionReady ? "Après abonnement" : customerSkipped ? "Réactiver" : "Créer",
    },
    {
      title: "Premier document",
      ok: documentsCount > 0,
      href: subscriptionReady ? "/app/new" : billingHref,
      helper:
        documentsCount > 0
          ? `${documentsCount} document(s) déjà créé(s).`
          : !subscriptionReady
            ? "Disponible dès que le profil et l'abonnement sont prêts."
            : "Passez vite à un devis ou une facture depuis le mode guidé.",
      cta: documentsCount > 0 ? "Créer à nouveau" : !subscriptionReady ? "Après abonnement" : "Créer",
    },
  ];

  const lookupHint = !businessIdDigits
    ? "Renseignez un SIREN ou un SIRET pour éviter les fautes de saisie."
    : lookupKind === "partial"
      ? "Continue jusqu'à 9 ou 14 chiffres."
      : lookupKind === "siren"
        ? "SIREN détecté : on récupère automatiquement le siège si l'annuaire répond."
        : "SIRET détecté : prêt pour un préremplissage rapide.";

  const runLookup = async () => {
    if (!lookupReady || lookupBusy) return;
    setLookupBusy(true);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (businessIdDigits.length === 14) params.set("siret", businessIdDigits);
      else params.set("siren", businessIdDigits);
      const res = await rawApi(`/api/lookup/sirene?${params.toString()}`);
      if (!res.ok) {
        const message = await parseErrorFromResponse(res, "Préremplissage annuaire impossible.");
        throw new Error(message);
      }
      const payload = await res.json().catch(() => null);
      setProfile((prev: any) => ({
        ...prev,
        name: payload?.name || prev.name,
        siret: formatFrenchBusinessIdInput(payload?.siret || businessIdDigits || prev.siret),
        address_line1: payload?.address_line1 || prev.address_line1,
        address_line2: payload?.address_line2 || prev.address_line2,
        postal_code: payload?.postal_code || prev.postal_code,
        city: payload?.city || prev.city,
        country_code: (payload?.country || prev.country_code || "FR").toUpperCase(),
      }));
      setLookupInput(formatFrenchBusinessIdInput(payload?.siret || businessIdDigits));
      setNotice("Entreprise préremplie depuis l'annuaire.");
    } catch (err) {
      setError(formatApiError(err, "Préremplissage annuaire impossible."));
    } finally {
      setLookupBusy(false);
    }
  };

  const saveProfile = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify({
          name: String(profile.name || "").trim() || null,
          siret: digitsOnly(profile.siret) || null,
          vat_number:
            String(profile.vat_number || "")
              .replace(/\s+/g, "")
              .toUpperCase() || null,
          legal_form: String(profile.legal_form || "").trim() || null,
          address_line1: String(profile.address_line1 || "").trim() || null,
          address_line2: String(profile.address_line2 || "").trim() || null,
          address: [profile.address_line1, profile.address_line2].filter(Boolean).join(" ") || null,
          postal_code: String(profile.postal_code || "").trim() || null,
          city: String(profile.city || "").trim() || null,
          country_code:
            String(profile.country_code || "FR")
              .trim()
              .toUpperCase() || "FR",
          country:
            String(profile.country_code || "FR")
              .trim()
              .toUpperCase() || "FR",
          legal_mentions:
            String(profile.legal_mentions || "").trim() || companyLegalMentionsDefaults({ vatRegime: null }),
        }),
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(COMPANY_PROFILE_UPDATED_EVENT));
      }
      setNotice(
        subscriptionReady
          ? "Dossier entreprise enregistré."
          : "Dossier entreprise enregistré. Choisissez maintenant l'abonnement.",
      );
      setDirty(false);
      reloadSummary?.();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Démarrage rapide"
        breadcrumb="Onboarding"
        description="Un point d'entrée simple : société, abonnement, premier client, premier document. Le reste vient après."
        backHref="/app/get-started"
        actions={<PrimaryLinkButton to={nextHref}>{nextLabel}</PrimaryLinkButton>}
      />
      <div className="space-y-6 p-6 lg:p-8">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="info">{notice}</NoticeBanner> : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_360px]">
          <Card className="border-[#dbeafe] bg-[linear-gradient(135deg,#f8fbff_0%,#eff6ff_100%)]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    status={completion === 100 ? "ok" : completion >= 34 ? "info" : "warn"}
                    label={`${completion}% prêt`}
                  />
                  <span className="text-[#1d4ed8] text-xs font-bold">4 étapes maximum avant de vendre</span>
                </div>
                <h3 className="mt-3 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                  Va droit au but : société, abonnement, client, premier document.
                </h3>
                <p className="mt-2 max-w-2xl text-[#475569]" style={{ fontSize: "0.875rem", lineHeight: 1.65 }}>
                  L'idée est d'éviter les écrans techniques. Complétez le dossier entreprise, validez le plan, créez un
                  client, puis lancez un devis ou une facture depuis le mode document.
                </p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/90">
                  <div
                    className="h-full rounded-full bg-[#1d4ed8] transition-all"
                    style={{ width: `${completion}%` }}
                  />
                </div>
              </div>
              <div className="flex flex-shrink-0 flex-col gap-2">
                <PrimaryLinkButton to={nextHref}>{nextLabel}</PrimaryLinkButton>
                <SecondaryButton onClick={() => reloadSummary?.()}>Actualiser</SecondaryButton>
                {hasSkippedSteps ? <SecondaryButton onClick={resetSkippedSteps}>Réinitialiser</SecondaryButton> : null}
              </div>
            </div>
          </Card>

          <Card>
            <div className="text-[#0f172a] text-[0.9375rem] font-bold">Checklist ultra courte</div>
            <div className="mt-4 space-y-3">
              {steps.map((step, index) => (
                <div
                  key={step.title}
                  className={`rounded-xl border px-4 py-3 ${step.ok ? "border-[#bbf7d0] bg-[#ecfdf5]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[#0f172a] text-sm font-bold">
                        {index + 1}. {step.title}
                      </div>
                      <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                        {step.helper}
                      </div>
                    </div>
                    <Link
                      to={step.href}
                      className="inline-flex items-center gap-1.5 text-[#1d4ed8] hover:text-[#1e40af] text-xs font-bold"
                    >
                      {step.cta} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[#0f172a] text-[0.9375rem] font-bold">1. Mon entreprise</div>
                <p className="mt-1 text-[#64748b] text-xs leading-relaxed">
                  Renseignez un SIREN ou un SIRET, préremplissez, puis enregistrez. Le but est d'éviter les fautes et
                  d'aller vite.
                </p>
              </div>
              <StatusPill status={companyReady ? "ok" : "warn"} label={companyReady ? "Prêt" : "À compléter"} />
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div>
                <label className="mb-1.5 block text-[#64748b] text-xs font-semibold">SIREN ou SIRET</label>
                <input
                  value={lookupInput}
                  onChange={(event) => {
                    const formatted = formatFrenchBusinessIdInput(event.target.value);
                    setLookupInput(formatted);
                    setProfile((prev: any) => ({ ...prev, siret: formatted }));
                  }}
                  placeholder="123 456 789 ou 123 456 789 00012"
                  className="w-full rounded-xl border border-[#d6deea] bg-white px-3 py-2.5 text-[#0f172a] text-sm"
                />
                <div className="mt-2 text-[#94a3b8]" style={{ fontSize: "0.6875rem", lineHeight: 1.5 }}>
                  {lookupHint}
                </div>
              </div>
              <div className="flex items-end">
                <SecondaryButton onClick={runLookup} disabled={!lookupReady || lookupBusy || loading}>
                  {lookupBusy ? "Préremplissage…" : "Préremplir"}
                </SecondaryButton>
              </div>
              <div className="flex items-end">
                <PrimaryButton onClick={saveProfile} disabled={saving || loading || !digitsOnly(profile.siret)}>
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </PrimaryButton>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
                <div
                  className="text-[#94a3b8]"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  Aperçu société
                </div>
                <div className="mt-2 text-[#0f172a] text-[0.9375rem] font-bold">
                  {profile.name || "Raison sociale à récupérer"}
                </div>
                <div className="mt-2 whitespace-pre-line text-[#64748b] text-xs leading-relaxed">
                  {[
                    profile.address_line1,
                    profile.address_line2,
                    [profile.postal_code, profile.city].filter(Boolean).join(" "),
                    profile.country_code,
                  ]
                    .filter(Boolean)
                    .join("\n") || "Adresse encore vide"}
                </div>
                <div className="mt-3 space-y-1 text-[#64748b] text-xs">
                  <div>
                    SIRET :{" "}
                    <span className="font-mono text-[#0f172a]">{formatSiretInput(profile.siret || "") || "—"}</span>
                  </div>
                  <div>
                    TVA :{" "}
                    <span className="font-mono text-[#0f172a]">
                      {formatVatNumberInput(profile.vat_number || "") || "—"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-[#e2e8f0] bg-white p-4">
                <div
                  className="text-[#94a3b8]"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  Prochaine action
                </div>
                <div className="mt-2 text-[#0f172a] text-[0.9375rem] font-bold">
                  {!companyReady
                    ? "Finalisez le dossier entreprise"
                    : !subscriptionReady
                      ? "Choisissez l'abonnement"
                      : customersCount === 0
                        ? "Ajoutez un client"
                        : "Passez au premier document"}
                </div>
                <p className="mt-2 text-[#64748b] text-xs leading-relaxed">
                  {!companyReady
                    ? "Dès que le SIRET, l'adresse et les mentions sont renseignés, vous sécurisez le parcours clients, devis et factures. Les achats et le suivi des paiements restent réservés au plan Pro."
                    : !subscriptionReady
                      ? "L'accès aux écrans métier s'ouvre après validation du plan Starter ou Pro."
                      : customersCount === 0
                        ? "Le premier client débloque les devis, les factures et le portail."
                        : "Vous pouvez maintenant utiliser l'éditeur document sans repasser dans les réglages."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <PrimaryLinkButton
                    to={!companyReady ? "/app/company" : !subscriptionReady ? billingHref : "/app/company"}
                  >
                    {!companyReady
                      ? "Ouvrir l'entreprise"
                      : !subscriptionReady
                        ? "Choisir l'abonnement"
                        : "Ouvrir l'entreprise"}
                  </PrimaryLinkButton>
                  <SecondaryButton
                    onClick={() =>
                      setProfile((prev: any) => ({
                        ...prev,
                        legal_mentions: prev.legal_mentions || companyLegalMentionsDefaults({ vatRegime: null }),
                      }))
                    }
                  >
                    Mentions auto
                  </SecondaryButton>
                </div>
              </div>
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <div className="text-[#0f172a] text-[0.9375rem] font-bold">2. Abonnement</div>
              <p className="mt-1 text-[#64748b] text-xs leading-relaxed">
                L'essai Pro de {TRIAL_DAYS} jours est limité aux brouillons et prévisualisations, sans émission
                définitive, email client ni transmission. Ces actions s'activent après souscription.
              </p>
              <div className="mt-4 flex items-center justify-between gap-3">
                <StatusPill
                  status={subscriptionReady ? "ok" : checkoutRequested ? "warn" : "info"}
                  label={
                    subscriptionReady && billingFollowupRequested
                      ? "Essai Pro"
                      : subscriptionReady
                        ? "Prêt"
                        : checkoutRequested
                          ? "À finaliser"
                          : subscriptionActive
                            ? "Essai Pro"
                            : "À choisir"
                  }
                />
                <PrimaryLinkButton to={billingHref}>
                  {billingFollowupRequested
                    ? "Finaliser le plan"
                    : subscriptionReady
                      ? "Voir l'abonnement"
                      : "Choisir l'abonnement"}
                </PrimaryLinkButton>
              </div>
            </Card>

            <Card data-testid="onboarding-step-customer">
              <div className="text-[#0f172a] text-[0.9375rem] font-bold">3. Premier client</div>
              <p className="mt-1 text-[#64748b] text-xs leading-relaxed">
                Un seul objectif : préparer un client propre avant de lancer le devis ou la facture.
              </p>
              <div className="mt-4 flex items-center justify-between gap-3">
                <StatusPill status={customerStatus} label={customerStatusLabel} />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {customersCount === 0 && subscriptionReady ? (
                    customerSkipped ? (
                      <SecondaryButton onClick={() => setStepSkipped("customer", false)}>Réactiver</SecondaryButton>
                    ) : (
                      <SecondaryButton onClick={() => setStepSkipped("customer", true)}>Ignorer</SecondaryButton>
                    )
                  ) : null}
                  <PrimaryLinkButton to={subscriptionReady ? "/app/customers/new" : billingHref}>
                    {subscriptionReady ? "Créer un client" : "Choisir l'abonnement"}
                  </PrimaryLinkButton>
                </div>
              </div>
              {customerSkipped ? <div className="mt-3 text-xs font-semibold text-[#64748b]">Étape ignorée</div> : null}
            </Card>

            <Card>
              <div className="text-[#0f172a] text-[0.9375rem] font-bold">4. Premier document</div>
              <p className="mt-1 text-[#64748b] text-xs leading-relaxed">
                Le mode document reste le meilleur point d'entrée pour montrer le produit simplement.
              </p>
              <div className="mt-4 flex items-center justify-between gap-3">
                <StatusPill
                  status={documentsCount > 0 ? "ok" : subscriptionReady ? "info" : "muted"}
                  label={
                    documentsCount > 0
                      ? `${documentsCount} document(s)`
                      : subscriptionReady
                        ? "Pas encore lancé"
                        : "Après abonnement"
                  }
                />
                <PrimaryLinkButton to={subscriptionReady ? "/app/new" : billingHref}>
                  {subscriptionReady ? "Créer un document" : "Choisir l'abonnement"}
                </PrimaryLinkButton>
              </div>
            </Card>

            <Card>
              <div className="text-[#0f172a] text-[0.9375rem] font-bold">Raccourcis utiles</div>
              <div className="mt-4 space-y-2">
                <Link
                  to={subscriptionReady ? "/app/invoices/new" : billingHref}
                  className="flex items-center justify-between rounded-xl border border-[#e2e8f0] px-3 py-2 text-[#0f172a] hover:bg-[#f8fafc] text-sm font-semibold"
                >
                  <span>Créer une facture</span>
                  <ArrowRight className="h-3.5 w-3.5 text-[#94a3b8]" />
                </Link>
                <Link
                  to={subscriptionReady ? "/app/quotes/new" : billingHref}
                  className="flex items-center justify-between rounded-xl border border-[#e2e8f0] px-3 py-2 text-[#0f172a] hover:bg-[#f8fafc] text-sm font-semibold"
                >
                  <span>Créer un devis</span>
                  <ArrowRight className="h-3.5 w-3.5 text-[#94a3b8]" />
                </Link>
                <div
                  className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#64748b]"
                  style={{ fontSize: "0.75rem", lineHeight: 1.55 }}
                >
                  Documents : <strong className="text-[#0f172a]">{documentsCount}</strong> devis/facture(s) · Crée un
                  premier document pour valider le parcours client.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewDocumentPage() {
  const { capabilities } = useSession({ autoRefresh: false });
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const { summary } = useWorkspaceSummary();
  const [smartSeed, setSmartSeed] = useState<{
    customer: any | null;
    item: any | null;
    source?: string | null;
    document?: any | null;
    suggestions?: any[];
  }>({
    customer: null,
    item: null,
    source: null,
    document: null,
    suggestions: [],
  });
  const companyReady = Boolean(summary?.company?.complete);
  const hasCustomers = Number(summary?.customers?.count || 0) > 0;
  const hasItems = Number(summary?.items?.count || 0) > 0;
  const documentsCount = Number(summary?.quotes?.count || 0) + Number(summary?.invoices?.count || 0);
  const nextHref = summary?.next_actions?.[0]?.href;

  useEffect(() => {
    let cancelled = false;
    const loadSmartSeed = async () => {
      try {
        const seedRes = await rawApi("/api/cockpit/document-seed");
        if (seedRes.ok) {
          const seed = await seedRes.json().catch(() => null);
          if (!cancelled && (seed?.customer || seed?.item)) {
            setSmartSeed({
              customer: seed?.customer || null,
              item: seed?.item || null,
              source: seed?.source || null,
              document: seed?.document || null,
              suggestions: Array.isArray(seed?.suggestions) ? seed.suggestions : [],
            });
            return;
          }
        }

        const [customersRes, itemsRes] = await Promise.allSettled([
          rawApi("/api/customers?limit=6&offset=0"),
          rawApi("/api/items"),
        ]);
        if (cancelled) return;

        let customers: any[] = [];
        let items: any[] = [];
        if (customersRes.status === "fulfilled" && customersRes.value.ok) {
          const payload = await customersRes.value.json().catch(() => []);
          customers = Array.isArray(payload) ? payload : [];
        }
        if (itemsRes.status === "fulfilled" && itemsRes.value.ok) {
          const payload = await itemsRes.value.json().catch(() => []);
          items = Array.isArray(payload) ? payload.filter((item) => item?.active !== false) : [];
        }

        let recentCustomerIds: string[] = [];
        if (typeof window !== "undefined") {
          try {
            const raw = window.localStorage.getItem("teoman-document-editor-recent-customers");
            const parsed = raw ? JSON.parse(raw) : [];
            recentCustomerIds = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
          } catch {
            recentCustomerIds = [];
          }
        }

        const customer =
          recentCustomerIds.map((id) => customers.find((entry) => entry?.id === id)).find(Boolean) ||
          customers[0] ||
          null;
        const item = items[0] || null;
        setSmartSeed({ customer, item, source: "local_fallback", document: null, suggestions: [] });
      } catch {
        if (!cancelled) setSmartSeed({ customer: null, item: null, source: null, document: null, suggestions: [] });
      }
    };
    void loadSmartSeed();
    return () => {
      cancelled = true;
    };
  }, []);

  const smartDocumentHref = (baseHref: string, seed: any = smartSeed) => {
    const params = new URLSearchParams();
    if (seed?.customer?.id) params.set("customer_id", seed.customer.id);
    if (seed?.item?.id) params.set("item_id", seed.item.id);
    if (!params.size) return baseHref;
    params.set("prefill", "smart");
    return `${baseHref}?${params.toString()}`;
  };

  const smartSuggestions = Array.isArray(smartSeed.suggestions)
    ? smartSeed.suggestions.filter((entry) => entry?.customer?.id || entry?.item?.id).slice(0, 4)
    : [];
  const smartHint = [smartSeed.customer?.name, smartSeed.item?.name].filter(Boolean).join(" · ");
  const smartHintPrefix =
    smartSeed.source === "invoice_history" || smartSeed.source === "quote_history"
      ? `Dernier usage${smartSeed.document?.number ? ` ${smartSeed.document.number}` : ""}`
      : "Prérempli";

  const choices = [
    {
      href: smartDocumentHref("/app/invoices/new"),
      icon: FileText,
      label: "Facture",
      desc: "Créer une facture puis l'envoyer, copier le lien client ou télécharger le PDF.",
      status:
        companyReady && hasCustomers
          ? { tone: "ok", label: "Prêt" }
          : { tone: "warn", label: companyReady ? "Ajoutez un client" : "Entreprise à compléter" },
      hint:
        companyReady && hasCustomers
          ? "Le flux principal est disponible."
          : companyReady
            ? "Crée d’abord un client pour facturer proprement."
            : "Complétez d’abord les informations légales de l’entreprise.",
    },
    {
      href: smartDocumentHref("/app/quotes/new"),
      icon: FileText,
      label: "Devis",
      desc: "Créer un devis, le partager pour accord puis le convertir en facture.",
      status: hasCustomers
        ? { tone: "info", label: hasItems ? "Recommandé" : "Prêt" }
        : { tone: "warn", label: "Ajoutez un client" },
      hint: hasCustomers
        ? hasItems
          ? "Le catalogue accélère la création du devis."
          : "Le devis reste possible même sans catalogue."
        : "Le client est le meilleur premier pas avant d’envoyer un devis.",
    },
    {
      href: "/app/customers/new",
      icon: Users,
      label: "Client",
      desc: "Ajouter un client et préparer devis, portail et facturation.",
      status: { tone: "purple", label: nextHref === "/app/customers/new" ? "Étape conseillée" : "Toujours utile" },
      hint: "Le client est la brique la plus rentable pour accélérer le cycle de vente.",
    },
  ];

  const recommendedChoice =
    choices.find((choice) => choice.href === nextHref) ||
    choices[companyReady && hasCustomers ? 0 : hasCustomers ? 1 : 2];
  const secondaryChoices = choices.filter((choice) => choice.href !== recommendedChoice.href);

  return (
    <div>
      <AppPageHeader
        title="Créer"
        breadcrumb="Créer"
        description="Choisissez le document à préparer, puis partagez-le depuis sa fiche par email, lien client ou PDF."
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!companyReady ? (
          <NoticeBanner tone="warning">
            Votre profil entreprise n’est pas encore complet. Pour une facture vraiment vendable et conforme, complétez
            d’abord le SIRET, la TVA et l’adresse.
          </NoticeBanner>
        ) : null}

        <Card className="max-w-5xl overflow-hidden border-[#dbeafe] bg-[linear-gradient(135deg,#f8fbff_0%,#eff6ff_100%)]">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusPill status={recommendedChoice.status.tone as any} label={recommendedChoice.status.label} />
                <span className="text-[#1d4ed8] text-xs font-bold">Étape recommandée</span>
              </div>
              <h3 className="mt-3 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                {recommendedChoice.label}
              </h3>
              <p className="mt-2 text-[#475569]" style={{ fontSize: "0.875rem", lineHeight: 1.65 }}>
                {recommendedChoice.desc}
              </p>
              <p className="mt-3 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                {recommendedChoice.hint}
              </p>
              {smartHint ? (
                <p className="mt-2 text-[#1d4ed8]" style={{ fontSize: "0.75rem", lineHeight: 1.5, fontWeight: 700 }}>
                  {smartHintPrefix} avec {smartHint}
                </p>
              ) : null}
            </div>
            <div className="flex-shrink-0">
              <PrimaryLinkButton to={recommendedChoice.href}>
                Continuer vers {recommendedChoice.label.toLowerCase()}
              </PrimaryLinkButton>
            </div>
          </div>
        </Card>

        {smartSuggestions.length > 1 ? (
          <section className="max-w-5xl">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <div
                  className="text-[#94a3b8]"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 800,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Reprendre un usage récent
                </div>
                <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                  Choisissez un couple client/article déjà utilisé pour créer plus vite.
                </p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {smartSuggestions.map((seed, index) => {
                const customerName = seed?.customer?.name || "Client";
                const itemName = seed?.item?.name || "Article";
                const document = seed?.document || {};
                const sourceLabel = document?.type === "quote" ? "Devis" : "Facture";
                const documentLabel = [sourceLabel, document?.number, formatDateFr(document?.date, "")]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    key={`${seed?.customer?.id || "customer"}-${seed?.item?.id || "item"}-${index}`}
                    className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eff6ff] text-[#1d4ed8]">
                        <Clock3 className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 850 }}>
                          {customerName}
                        </div>
                        <p
                          className="mt-0.5 truncate text-[#475569]"
                          style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                        >
                          {itemName}
                        </p>
                        {documentLabel ? (
                          <p className="mt-1 truncate text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 700 }}>
                            {documentLabel}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        to={smartDocumentHref("/app/invoices/new", seed)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#1d4ed8] px-3 text-white transition-colors hover:bg-[#1e40af]"
                        style={{ fontSize: "0.75rem", fontWeight: 850 }}
                      >
                        Facture
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                      <Link
                        to={smartDocumentHref("/app/quotes/new", seed)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-white px-3 text-[#1d4ed8] transition-colors hover:bg-[#eff6ff]"
                        style={{ fontSize: "0.75rem", fontWeight: 850 }}
                      >
                        Devis
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="grid gap-4 max-w-5xl md:grid-cols-2">
          {secondaryChoices.map((choice) => (
            <Link
              key={choice.href}
              to={choice.href}
              className="bg-white border border-[#e5e7eb] rounded-xl p-5 hover:border-[#1d4ed8]/30 hover:shadow-md transition-all group shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="w-11 h-11 rounded-xl bg-[#1d4ed8]/[0.06] flex items-center justify-center group-hover:bg-[#1d4ed8]/10 transition-colors">
                  <choice.icon className="w-5 h-5 text-[#1d4ed8]" />
                </div>
                <StatusPill status={choice.status.tone as any} label={choice.status.label} />
              </div>
              <h3 className="text-[#111827] mt-4 text-[0.9375rem] font-bold">{choice.label}</h3>
              <p className="text-[#6b7280] mt-1" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                {choice.desc}
              </p>
            </Link>
          ))}
        </div>

        <Card className="max-w-5xl">
          <div
            className="text-[#94a3b8]"
            style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
          >
            Après création
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[
              {
                icon: MailCheck,
                label: "Envoyer",
                text: "Ouvrez la fiche du document et lancez l'envoi email tracé.",
              },
              {
                icon: Copy,
                label: "Copier le lien",
                text: paymentsEnabled
                  ? "Active le lien client pour consultation, accord ou paiement selon le document."
                  : "Active le lien client pour consultation ou accord selon le document.",
              },
              {
                icon: FileText,
                label: "Télécharger",
                text: "Garde un PDF partageable quand l'email ou le portail n'est pas adapté.",
              },
            ].map((step) => (
              <div key={step.label} className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-4 py-3">
                <div
                  className="flex items-center gap-2 text-[#0f172a]"
                  style={{ fontSize: "0.85rem", fontWeight: 800 }}
                >
                  <step.icon className="h-4 w-4 text-[#1d4ed8]" />
                  {step.label}
                </div>
                <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
                  {step.text}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid sm:grid-cols-3 gap-4 max-w-5xl">
          <Card>
            <div
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
            >
              Entreprise
            </div>
            <div className="mt-2 flex items-center gap-2">
              <StatusPill status={companyReady ? "ok" : "warn"} label={companyReady ? "Complet" : "À compléter"} />
            </div>
          </Card>
          <Card>
            <div
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
            >
              Clients
            </div>
            <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
              {summary?.customers?.count || 0}
            </div>
          </Card>
          <Card>
            <div
              className="text-[#94a3b8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
            >
              Documents
            </div>
            <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
              {documentsCount} devis/facture(s)
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function SessionDebugPage() {
  const [details, setDetails] = useState<[string, string][]>([
    ["User Agent", "—"],
    ["Cookie support", "—"],
    ["Origin", "—"],
    ["Protocol", "—"],
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDetails([
      ["User Agent", window.navigator.userAgent],
      ["Cookie support", window.navigator.cookieEnabled ? "Oui" : "Non"],
      ["Origin", window.location.origin],
      ["Protocol", window.location.protocol],
    ]);
  }, []);

  return (
    <div>
      <AppPageHeader
        title="Diagnostic session"
        breadcrumb="Diagnostic session"
        description="Contrôle de session et de configuration d’accès."
      />
      <div className="p-6 lg:p-8">
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 max-w-2xl space-y-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm">
          {details.map(([key, value]) => (
            <div key={key} className="flex justify-between">
              <span className="text-[#9ca3af]">{key}</span>
              <span className="text-[#374151] font-mono text-right max-w-[60%] truncate text-xs">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PortalPage() {
  const { capabilities } = useSession();
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await rawApi("/api/client/invoices");
        if (!res.ok) {
          const message = await parseErrorFromResponse(res, "Portail client non accessible pour ce compte.");
          throw new Error(message);
        }
        const data = await res.json().catch(() => []);
        if (!cancelled) setInvoices(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) {
          setInvoices([]);
          setError(formatApiError(err, "Portail client non accessible pour ce compte."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const paidCount = paymentsEnabled ? invoices.filter((inv) => inv.status === "paid").length : 0;
  const openCount = paymentsEnabled
    ? invoices.filter((inv) => ["sent", "issued", "partial", "overdue"].includes((inv.status || "").toLowerCase()))
        .length
    : 0;
  const visibleInvoiceStatus = (invoice: any) => {
    const raw = String(invoice?.status || "").toLowerCase();
    if (paymentsEnabled || !["paid", "partial", "overdue"].includes(raw)) return raw;
    return invoice?.sent_at ? "sent" : "issued";
  };

  return (
    <div>
      <AppPageHeader
        title="Portail"
        breadcrumb="Portail client"
        description="Factures visibles et téléchargeables par le client connecté."
      />
      <div className="p-5 lg:p-7 w-full space-y-5">
        {error && (
          <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 max-w-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <p className="text-[#6b7280] text-sm">{error}</p>
          </div>
        )}

        {!error && (
          <>
            <div className={`grid gap-4 max-w-xl ${paymentsEnabled ? "grid-cols-2" : "grid-cols-1"}`}>
              <StatCard label="Factures visibles" value={invoices.length} sub="Portail client" accent="blue" />
              {paymentsEnabled ? (
                <StatCard label="Payées" value={paidCount} sub={`${openCount} en cours`} accent="green" />
              ) : null}
            </div>

            <DataTable headers={["Facture", "Émission", "Échéance", "Statut", "Montant", "Téléchargements"]}>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[#94a3b8] text-sm">
                    Chargement…
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[#94a3b8] text-sm">
                    Aucune facture publiée dans le portail.
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-[#f9fafb]/60 transition-colors">
                    <td className="px-4 py-3 text-[#111827] text-sm font-medium">{invoice.number || invoice.id}</td>
                    <td className="px-4 py-3 text-[#374151] text-sm">{formatDateFr(invoice.issue_date, "—")}</td>
                    <td className="px-4 py-3 text-[#374151] text-sm">{formatDateFr(invoice.due_date, "—")}</td>
                    <td className="px-4 py-3">
                      <StatusPill
                        {...(statusMap[visibleInvoiceStatus(invoice)] || {
                          label: visibleInvoiceStatus(invoice) || "—",
                          color: "muted",
                        })}
                      />
                    </td>
                    <td className="px-4 py-3 text-[#111827] text-sm font-semibold">
                      {money(invoice.total_inc_vat || 0)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <a
                          href={apiUrl(`/api/client/invoices/${invoice.id}/pdf`)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#1d4ed8] hover:text-[#1e40af]"
                          style={{ fontSize: "0.75rem", fontWeight: 500 }}
                        >
                          PDF
                        </a>
                        {einvoicingEnabled ? (
                          <a
                            href={apiUrl(`/api/client/invoices/${invoice.id}/facturx`)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#1d4ed8] hover:text-[#1e40af]"
                            style={{ fontSize: "0.75rem", fontWeight: 500 }}
                          >
                            Factur-X
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </>
        )}
      </div>
    </div>
  );
}

export function PdpPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/platforms/onboarding-status");
      if (!res.ok) {
        const message = await parseErrorFromResponse(res, "Impossible de charger le statut Seqino.");
        throw new Error(message);
      }
      const data = await res.json().catch(() => null);
      setStatus(data || null);
    } catch (err) {
      setStatus(null);
      setError(formatApiError(err, "Impossible de charger le statut Seqino."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!seqinoOperational) {
      setLoading(false);
      setStatus(null);
      setError(null);
      return;
    }
    void load();
  }, [seqinoOperational, sessionLoading]);

  const activatePdp = async () => {
    if (!seqinoOperational) return;
    const accepted = window.confirm(`${SEQINO_MANDATE_CONSENT_TEXT}\n\nConfirmer l’activation du mandat Seqino ?`);
    if (!accepted) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result: any = await apiFetch("/api/platforms/seqino/mandates/default", {
        method: "POST",
        body: JSON.stringify({ accept_mandate: true }),
      });
      const activeCount = Number(result?.mandate_active_count || 0);
      const connected = Boolean(result?.connected) || activeCount > 0;
      setNotice(
        connected
          ? "Mandat Seqino actif. Vérifiez l'annuaire avant une première transmission réelle."
          : "Mandat Seqino demandé. Vérification en cours, actualisez dans quelques secondes.",
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d’activer Seqino."));
    } finally {
      setBusy(false);
    }
  };

  const connectors = status?.enabled_connectors || {};
  const connectorCount = [connectors.seqino, connectors.chorus, connectors.generic_http].filter(Boolean).length;
  const mandateActive = Number(status?.mandate?.active_count || 0);
  const exchangeLastSuccess = status?.exchanges?.last_success;

  return (
    <div>
      <AppPageHeader
        title="Seqino"
        breadcrumb="Plateforme agréée partenaire"
        description="État de la connexion, du mandat et des échanges, uniquement lorsqu’un service Seqino est réellement activé."
        actions={
          sessionLoading ? null : seqinoOperational ? (
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={() => void load()} disabled={loading || busy}>
                <RefreshCw className="w-3.5 h-3.5" /> Actualiser
              </SecondaryButton>
              <PrimaryButton onClick={mandateActive > 0 ? () => void load() : activatePdp} disabled={busy}>
                <ShieldCheck className="w-3.5 h-3.5" />{" "}
                {busy ? "Activation…" : mandateActive > 0 ? "Vérifier l’activation" : "Activer le mandat Seqino"}
              </PrimaryButton>
            </div>
          ) : !einvoicingEnabled ? (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          ) : (
            <StatusPill status="info" label="Mode export actif" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-5">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "Seqino réservé au plan Pro"}
            description={
              einvoicingGate.reactivationDescription ||
              "L’activation Seqino et les échanges réglementaires connectés demandent le plan Pro."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        {!sessionLoading && einvoicingEnabled && !seqinoOperational ? (
          <NoticeBanner tone="info" title="Mode export actif">
            Aucun mandat ni échange Seqino n’est disponible dans la configuration actuelle. Vous pouvez préparer vos
            données et vos exports depuis l’assistant e-facturation ; une connexion exigera ensuite un contrat, un
            mandat et une activation technique confirmée.
          </NoticeBanner>
        ) : null}
        <SeqinoTokenNotice enabled={seqinoOperational && Boolean(capabilities?.token_topup_enabled)} />
        {notice && (
          <div className="flex items-center gap-2 text-[#059669] bg-[#ecfdf5] border border-[#bbf7d0] rounded-lg px-3 py-2 text-xs">
            <CheckCircle className="w-3.5 h-3.5" />
            {notice}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-lg px-3 py-2 text-xs">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !seqinoOperational ? null : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Connecteurs actifs"
              value={loading ? "…" : connectorCount}
              sub="PA / canal public / HTTP"
              accent="blue"
            />
            <StatCard label="Mandats actifs" value={loading ? "…" : mandateActive} sub="PA" accent="green" />
            <StatCard
              label="Synchro Seqino"
              value={loading ? "…" : status?.directory?.status || "never"}
              sub={status?.directory?.last_sync ? formatDateFr(status.directory.last_sync, "—") : "Jamais"}
            />
            <StatCard
              label="Dernier échange"
              value={loading ? "…" : exchangeLastSuccess ? "OK" : "Aucun"}
              sub={exchangeLastSuccess ? formatDateFr(exchangeLastSuccess, "—") : ""}
              accent={exchangeLastSuccess ? "green" : "amber"}
            />
          </div>
        )}

        {!sessionLoading && seqinoOperational ? (
          <>
            {mandateActive === 0 ? (
              <div className="rounded-xl border border-[#bfdbfe] bg-white px-4 py-3 text-xs leading-5 text-[#1e3a8a] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                En activant ce service, vous autorisez la plateforme à créer et gérer le mandat nécessaire à la
                réception, l’émission et le suivi de vos factures électroniques via Seqino.
              </div>
            ) : null}
            <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] space-y-4">
              <h3 className="text-[#111827] text-[0.9375rem] font-semibold">État des connecteurs</h3>
              {loading ? (
                <p className="text-[#94a3b8] text-sm">Chargement…</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <StatusPill
                    status={connectors.seqino ? "ok" : "muted"}
                    label={`Seqino ${connectors.seqino ? "actif" : "inactif"}`}
                  />
                  <StatusPill
                    status={connectors.chorus ? "ok" : "muted"}
                    label={`Canal public ${connectors.chorus ? "actif" : "inactif"}`}
                  />
                  <StatusPill
                    status={connectors.generic_http ? "ok" : "muted"}
                    label={`HTTP ${connectors.generic_http ? "actif" : "inactif"}`}
                  />
                </div>
              )}

              {!loading && Array.isArray(status?.errors) && status.errors.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[#111827] text-sm font-semibold">Points à corriger</h4>
                  {status.errors.map((item: any) => (
                    <div
                      key={item.code || item.message}
                      className="p-3 rounded-lg border border-[#fde68a] bg-[#fffbeb]"
                    >
                      <p className="text-[#92400e] text-sm font-semibold">{item.message || item.code}</p>
                      {item.hint && <p className="text-[#b45309] mt-1 text-xs">{item.hint}</p>}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <Link
                  to="/app/setup/einvoicing"
                  className="inline-flex items-center gap-1.5 text-[#1d4ed8] hover:text-[#1e40af] transition-colors text-sm font-medium"
                >
                  Ouvrir l'assistant complet <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function SetupPage() {
  const { capabilities, loading } = useSession();
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;

  return (
    <div>
      <AppPageHeader
        title="Configuration"
        breadcrumb="Configuration"
        description="Configuration initiale de votre espace."
      />
      <div className="p-6 lg:p-8">
        <Link
          to={einvoicingEnabled ? "/app/setup/einvoicing" : "/app/billing"}
          className="bg-white border border-[#e5e7eb] rounded-xl p-5 block hover:border-[#1d4ed8]/30 hover:shadow-md transition-all max-w-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04)] group"
        >
          <h3 className="text-[#111827] text-[0.9375rem] font-semibold">E-facturation 2026-2027</h3>
          <p className="text-[#6b7280] mt-1 text-sm">
            {loading
              ? "Vérification du plan…"
              : einvoicingEnabled
                ? "Préparer les données et les exports ; la connexion dépend ensuite du contrat, du mandat et de la configuration."
                : einvoicingGate.reactivationRequired
                  ? "Abonnement Pro à réactiver. Retrouvez la préparation e-facturation depuis la page Abonnement."
                  : "Disponible avec le plan Pro. Starter reste limité aux devis et factures classiques, sans Seqino ni Chorus."}
          </p>
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
        "Exports CSV et journal des ventes",
        "Branding de base",
        "Sans achats, paiements ni e-facturation",
      ],
      cta: "Voir Starter",
      color: "#0f8ec7",
      href: "/app/billing",
    },
    {
      name: "Pro",
      price: "59 €",
      period: "/mois",
      features: [
        "Tout Starter",
        "Achats, paiements et relances de factures",
        "Factur-X et UBL selon configuration",
        "Préparation e-facturation ; connexion PA selon contrat, mandat et activation",
        "50 jetons réservés, puis crédités après activation et disponibilité du stock",
      ],
      cta: "Choisir Pro",
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
      <div className="max-w-4xl p-6 lg:p-8">
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl bg-white p-5 transition-all ${plan.highlight ? "ring-2 ring-[#1d4ed8]" : ""}`}
              style={{ boxShadow: plan.highlight ? "0 4px 24px rgba(29,78,216,0.15)" : "0 1px 3px rgba(0,0,0,0.06)" }}
            >
              {plan.highlight ? (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-white"
                  style={{
                    fontSize: "0.625rem",
                    fontWeight: 700,
                    background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                  }}
                >
                  RECOMMANDÉ
                </div>
              ) : null}
              <div className="mb-4">
                <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                  {plan.name}
                </h3>
                <div className="mt-1 flex items-baseline gap-0.5">
                  <span style={{ fontSize: "1.75rem", fontWeight: 800, color: plan.color }}>{plan.price}</span>
                  <span className="text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                    {plan.period}
                  </span>
                </div>
              </div>
              <ul className="mb-5 space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 flex-shrink-0" style={{ color: plan.color }} />
                    <span className="text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to={plan.href}
                className="flex w-full items-center justify-center rounded-xl py-2.5 text-white transition-all hover:opacity-90"
                style={{
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  background: `linear-gradient(135deg,${plan.color},${plan.color}dd)`,
                  boxShadow: `0 2px 8px ${plan.color}40`,
                }}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
