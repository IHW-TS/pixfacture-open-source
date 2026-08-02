"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "@/figma/react-router-compat";
import { api, apiFetch, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { useSession } from "@/lib/useSession";
import { useWorkspaceSummary } from "@/lib/useWorkspaceSummary";
import { useHydrated } from "@/lib/useHydrated";
import { SEQINO_MANDATE_CONSENT_TEXT } from "@/lib/seqinoConsent";
import {
  ActionMenu,
  ActionMenuButton,
  ActionMenuLink,
  AppPageHeader,
  Card,
  DangerButton,
  DataTable,
  DisclosureCard,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SelectField,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { SeqinoTokenNotice } from "../../components/app/SeqinoTokenNotice";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Check,
  CheckCircle,
  Download,
  FileDown,
  FileText,
  Globe,
  Inbox,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Send,
  Shield,
  Upload,
  XCircle,
} from "lucide-react";

type EinvoicingPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

function money(value: any, currency = "EUR") {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "EUR" ? "€" : currency}`;
}

function titleCase(value: string | null | undefined) {
  const raw = (value || "").toString().trim();
  if (!raw) return "—";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (m) => m.toUpperCase());
}

function countEnabledConnectors(enabled: any) {
  return Object.values(enabled || {}).filter(Boolean).length;
}

function readinessOverallPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ready") return { color: "ok", label: "Prêt" };
  if (normalized === "partial") return { color: "warn", label: "Partiel" };
  if (normalized === "not_ready") return { color: "danger", label: "À configurer" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function readinessCheckPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (["ok", "ready"].includes(normalized)) return { color: "ok", label: "OK" };
  if (["missing", "todo", "partial", "not_ready"].includes(normalized))
    return { color: "warn", label: normalized === "partial" ? "Partiel" : "À faire" };
  if (["error", "failed"].includes(normalized)) return { color: "danger", label: "Erreur" };
  if (["na", "roadmap"].includes(normalized))
    return { color: "muted", label: normalized === "na" ? "Non requis" : "Roadmap" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function onboardingDirectoryPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ok") return { color: "ok", label: "Synchronisé" };
  if (normalized === "error") return { color: "danger", label: "Erreur" };
  if (["disabled", "na"].includes(normalized)) return { color: "muted", label: "Non activé" };
  if (normalized === "never") return { color: "warn", label: "Jamais synchronisé" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function transmissionPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    accepted: { color: "ok", label: "Acceptée" },
    available: { color: "ok", label: "Disponible" },
    paid: { color: "ok", label: "Payée" },
    submitted: { color: "info", label: "Soumise" },
    sent: { color: "info", label: "Envoyée" },
    queued: { color: "warn", label: "En file" },
    processing: { color: "warn", label: "En cours" },
    pending: { color: "warn", label: "En attente" },
    failed: { color: "danger", label: "Échec" },
    rejected: { color: "danger", label: "Rejetée" },
    refused: { color: "danger", label: "Refusée" },
    blocked: { color: "danger", label: "Bloquée" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function inboxStatusPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    received: { color: "info", label: "Reçue" },
    acknowledged: { color: "purple", label: "Acquittée" },
    accepted: { color: "ok", label: "Acceptée" },
    rejected: { color: "danger", label: "Rejetée" },
    correction_requested: { color: "warn", label: "Correction demandée" },
    imported: { color: "muted", label: "Importée" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function validationPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    valid: { color: "ok", label: "Valide" },
    warning: { color: "warn", label: "Avertissement" },
    invalid: { color: "danger", label: "Invalide" },
    skipped: { color: "muted", label: "Non vérifiée" },
  };
  return map[normalized] || { color: "muted", label: normalized ? titleCase(normalized) : "—" };
}

function purchaseWorkflowPill(workflow: any): { color: EinvoicingPillTone; label: string } {
  const normalized = String(workflow?.state || "new").toLowerCase();
  const label = workflow?.state_label || titleCase(normalized.replaceAll("_", " "));
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    new: { color: "info", label },
    reviewing: { color: "warn", label },
    awaiting_supplier: { color: "danger", label },
    approved: { color: "ok", label },
    ready_to_pay: { color: "purple", label },
    booked: { color: "muted", label },
  };
  return map[normalized] || { color: "muted", label };
}

function purchaseOpsGuidance(item: any, workflow?: any) {
  const status = String(item?.status || "").toLowerCase();
  const validation = String(item?.validation_status || "").toLowerCase();
  const workflowState = String(workflow?.state || "").toLowerCase();
  if (workflowState === "ready_to_pay") {
    return {
      tone: "ok",
      title: "Passer le relais à la trésorerie",
      description:
        "Le document est marqué bon à payer. La prochaine étape n'est plus la validation métier mais l'ordonnancement du règlement.",
      bullets: [
        "Vérifier l'échéance et la trésorerie prévue.",
        "Rattacher le document au bon lot de règlement ou au bon cycle comptable.",
      ],
    };
  }
  if (workflowState === "approved") {
    return {
      tone: "ok",
      title: "Préparer le bon à payer",
      description:
        "La revue achat est terminée. Il reste à le faire basculer dans le flux finance/compta au bon moment.",
      bullets: [
        "Conserver la note interne ou la preuve de validation achat.",
        "Basculer ensuite le dossier en “bon à payer” pour donner une lecture claire à la trésorerie.",
      ],
    };
  }
  if (workflowState === "reviewing") {
    return {
      tone: "warn",
      title: "Finaliser la revue interne",
      description:
        "Le document est déjà dans un cycle de contrôle. La priorité est maintenant de confirmer la cohérence métier et documentaire.",
      bullets: [
        "Comparer la facture au bon de commande, contrat ou prestation reçue.",
        "Documenter la décision interne avant d'approuver ou de demander un retour fournisseur.",
      ],
    };
  }
  if (workflowState === "awaiting_supplier") {
    return {
      tone: "danger",
      title: "Attendre un retour fournisseur",
      description:
        "Le document est gelé dans l'attente d'une correction ou d'une clarification. Ne le laisse pas revenir dans la file sans contexte.",
      bullets: [
        "Conserver l'explication interne dans la note opérateur.",
        "Relancer le fournisseur si aucune nouvelle version n'arrive dans le délai attendu.",
      ],
    };
  }
  if (validation === "invalid") {
    return {
      tone: "danger",
      title: "Demander une correction fournisseur",
      description:
        "Le document reçu n'est pas assez fiable pour un traitement propre. Reviens vers le fournisseur avant validation interne.",
      bullets: [
        "Vérifier les erreurs de structure et les champs obligatoires manquants.",
        "Conserver la pièce jointe mais éviter de la considérer comme validée côté achat.",
        "Utiliser le bouton de demande de correction si le canal fournisseur le permet.",
      ],
    };
  }
  if (["correction_requested", "rejected"].includes(status)) {
    return {
      tone: "warn",
      title: "Attendre une version corrigée",
      description:
        "Le document a déjà fait l'objet d'un retour. Garde la trace, puis contrôle la prochaine version à réception.",
      bullets: [
        "Suivre l'historique pour justifier le rejet ou la demande de correction.",
        "Ne pas lancer le paiement tant qu'une version acceptable n'est pas reçue.",
      ],
    };
  }
  if (validation === "warning") {
    return {
      tone: "warn",
      title: "Valider avec contrôle renforcé",
      description:
        "La facture fournisseur est exploitable, mais certains points demandent une revue humaine avant de l'intégrer au flux achat.",
      bullets: [
        "Vérifier le montant TTC, la TVA et le numéro de facture fournisseur.",
        "Comparer avec le bon de commande ou la dépense attendue.",
        "Accepter seulement si l'écart métier est compris et documenté.",
      ],
    };
  }
  if (status === "accepted") {
    return {
      tone: "ok",
      title: "Préparer le paiement fournisseur",
      description:
        "Le document est validé côté réception. La prochaine étape logique est l'ordonnancement du paiement et le suivi fournisseur.",
      bullets: [
        "Planifier le règlement dans le bon cycle de trésorerie.",
        "Conserver la facture dans la piste d'audit achat / fournisseur.",
      ],
    };
  }
  if (status === "acknowledged") {
    return {
      tone: "info",
      title: "Contrôler puis accepter",
      description:
        "La facture a bien été reçue côté plateforme. Il reste à valider le contenu métier avant d'enclencher le traitement fournisseur.",
      bullets: [
        "Contrôler fournisseur, référence et cohérence des montants.",
        "Accepter la facture si la réception métier est correcte.",
      ],
    };
  }
  return {
    tone: "info",
    title: "Analyser le document reçu",
    description:
      "Le document est arrivé dans la file achats. Vérifiez fournisseur, référence et montants avant de choisir l'action à appliquer.",
    bullets: [
      "Vérifier le fournisseur et le numéro de facture.",
      "Comparer avec l'achat attendu ou la prestation reçue.",
      "Choisir ensuite accepter, rejeter ou demander une correction.",
    ],
  };
}

function ereportingPill(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: any; label: string }> = {
    sent: { color: "ok", label: "Envoyé" },
    completed: { color: "ok", label: "Terminé" },
    ready: { color: "info", label: "Prêt" },
    queued: { color: "warn", label: "En file" },
    pending: { color: "warn", label: "En attente" },
    failed: { color: "danger", label: "Échec" },
    error: { color: "danger", label: "Erreur" },
    draft: { color: "muted", label: "Brouillon" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function compliancePill(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ok") return { color: "ok", label: "Conforme" };
  if (normalized === "warning") return { color: "warn", label: "À surveiller" };
  if (normalized === "blocked") return { color: "danger", label: "Bloquant" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function prettyProvider(slug: string | null | undefined) {
  const normalized = (slug || "").trim().toLowerCase();
  const map: Record<string, string> = {
    seqino: "Plateforme partenaire",
    chorus: "Canal public",
    choruspro: "Canal public",
    manual_import: "Import manuel",
    http_generic: "HTTP générique",
    generic_http: "HTTP générique",
    dummy: "Démonstration",
    mock: "Démonstration",
  };
  return map[normalized] || titleCase(normalized || "inconnu");
}

async function readJson(path: string) {
  const res = await rawApi(path);
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = extractUserFacingApiMessage(
      payload || res.statusText,
      res.status,
      "Action indisponible pour le moment.",
    );
    const err: any = new Error(message);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function ActionLink({ to, children, className = "" }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white transition-all shadow-sm ${className}`}
      style={{
        fontSize: "0.8125rem",
        fontWeight: 500,
        background: "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
      }}
    >
      {children}
    </Link>
  );
}

function SectionEmpty({
  title,
  description,
  href,
  cta,
}: {
  title: string;
  description: string;
  href?: string;
  cta?: string;
}) {
  return (
    <EmptyCard
      title={title}
      description={description}
      action={href ? <ActionLink to={href}>{cta || "Configurer"}</ActionLink> : undefined}
    />
  );
}

function useRouteId() {
  const params = useParams();
  const raw = params?.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

const EINV_CHECK_LINKS: Record<string, string> = {
  company_profile: "/app/company",
  first_customer: "/app/customers",
  first_item: "/app/items",
  first_quote: "/app/quotes/new",
  first_invoice: "/app/invoices/new",
  pdp_connection: "/app/einvoicing",
  mandate: "/app/einvoicing",
  directory: "/app/directory",
  ereporting: "/app/e-reporting",
  sandbox_test: "/app/settings/sandbox",
};

function einvoicingHrefFromKey(key: string | null | undefined) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase();
  return EINV_CHECK_LINKS[normalized] || "/app/einvoicing";
}

function describeMissingFields(fields: any) {
  if (!Array.isArray(fields) || !fields.length) return "Configuration à finaliser.";
  return `Champs à compléter : ${fields.join(", ")}`;
}

export function B2BEinvoicingPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const { summary } = useWorkspaceSummary();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [readinessRes, onboardingRes] = await Promise.allSettled([
        readJson("/api/einvoicing/readiness?mode=connected"),
        readJson("/api/platforms/onboarding-status"),
      ]);

      const messages: string[] = [];

      if (readinessRes.status === "fulfilled") setReadiness(readinessRes.value || null);
      else {
        setReadiness(null);
        messages.push(formatApiError(readinessRes.reason, "Checklist e-invoicing indisponible."));
      }

      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else {
        setOnboarding(null);
        messages.push(formatApiError(onboardingRes.reason, "Statut plateforme indisponible."));
      }

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [sessionLoading, einvoicingEnabled]);

  const overall = readinessOverallPill(readiness?.overall_status);
  const connectorsCount = countEnabledConnectors(onboarding?.enabled_connectors);
  const lastSuccess = onboarding?.exchanges?.last_success;
  const setupPercent = Number(summary?.setup?.percent || 0);
  const setupCompleted = Number(summary?.setup?.completed || 0);
  const setupTotal = Number(summary?.setup?.total || 0);

  const nextActions = useMemo(() => {
    const summaryActions = Array.isArray(summary?.next_actions) ? summary.next_actions : [];
    if (summaryActions.length) {
      return summaryActions.slice(0, 4).map((action: any, index: number) => ({
        key: action.key || `summary-action-${index}`,
        label: action.label || titleCase(action.key || `action-${index + 1}`),
        reason: action.reason || "Étape recommandée pour débloquer la mise en service.",
        href: action.href || einvoicingHrefFromKey(action.key),
      }));
    }

    const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
    return checks
      .filter((item: any) => {
        const tone = readinessCheckPill(item.status).color;
        return tone !== "ok" && tone !== "muted";
      })
      .slice(0, 4)
      .map((item: any, index: number) => ({
        key: item.id || `readiness-action-${index}`,
        label: titleCase(item.id),
        reason: describeMissingFields(item.missing_fields),
        href: einvoicingHrefFromKey(item.id),
      }));
  }, [readiness, summary]);

  const checklistRows = useMemo(() => {
    const setupSteps = Array.isArray(summary?.setup?.steps) ? summary.setup.steps : [];
    if (setupSteps.length) {
      return setupSteps.slice(0, 6).map((step: any, index: number) => ({
        key: step.key || `summary-step-${index}`,
        label: step.label || titleCase(step.key || `step-${index + 1}`),
        reason: step.reason || "Action à compléter pour finaliser la mise en route.",
        href: step.href || einvoicingHrefFromKey(step.key),
        pill: readinessCheckPill(step.done ? "ok" : "missing"),
        done: Boolean(step.done),
      }));
    }

    const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
    return checks.slice(0, 6).map((item: any, index: number) => ({
      key: item.id || `readiness-step-${index}`,
      label: titleCase(item.id),
      reason: describeMissingFields(item.missing_fields),
      href: einvoicingHrefFromKey(item.id),
      pill: readinessCheckPill(item.status),
      done: readinessCheckPill(item.status).color === "ok",
    }));
  }, [readiness, summary]);

  const primaryAction = nextActions[0] || checklistRows.find((item: any) => !item.done) || null;

  return (
    <div>
      <AppPageHeader
        title="Pilotage e-facturation B2B"
        breadcrumb="E-facturation"
        description="Lecture simple pour savoir si l’espace est prêt, quoi faire ensuite et quels points bloquent encore les premiers envois."
        actions={
          sessionLoading ? null : einvoicingEnabled ? (
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          ) : (
            <StatusPill status="warn" label="Plan Pro requis" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title="E-facturation disponible sur Pro"
            description="Le plan Starter conserve la facturation classique. La vue e-facturation B2B connectée, les connecteurs PA et les opérations plateforme partenaire sont disponibles avec le plan Pro selon configuration."
          />
        ) : null}
        <SeqinoTokenNotice enabled={Boolean(capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : hydrated && loading ? (
          <LoadingCard label="Chargement de la vue e-facturation…" />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="relative overflow-hidden">
                <div className="absolute left-0 right-0 top-0 h-[3px] bg-[#3b82f6]" />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Progression</div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#eff6ff] text-[#1d4ed8]">
                    <Shield className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.45rem] font-[800] tracking-[-0.03em] text-[#0f172a]">{setupPercent}%</div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {setupCompleted} étape(s) validée(s) sur {setupTotal || 0}
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute left-0 right-0 top-0 h-[3px] bg-[#d97706]" />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Connecteurs</div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#fffbeb] text-[#d97706]">
                    <Globe className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.45rem] font-[800] tracking-[-0.03em] text-[#0f172a]">
                  {connectorsCount}
                </div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {Number(onboarding?.mandate?.active_count || 0)} mandat(s) actif(s)
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div
                  className={`absolute left-0 right-0 top-0 h-[3px] ${
                    onboardingDirectoryPill(onboarding?.directory?.status).color === "ok"
                      ? "bg-[#16a34a]"
                      : onboardingDirectoryPill(onboarding?.directory?.status).color === "danger"
                        ? "bg-[#ef4444]"
                        : "bg-[#7c3aed]"
                  }`}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Annuaire</div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#f5f3ff] text-[#7c3aed]">
                    <Building2 className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.05rem] font-[800] tracking-[-0.03em] text-[#0f172a] leading-[1.2]">
                  {onboardingDirectoryPill(onboarding?.directory?.status).label}
                </div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {lastSuccess ? `Dernier succès ${formatDateFr(lastSuccess)}` : "Aucun succès récent"}
                </div>
              </Card>
            </div>

            <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">
                  À faire maintenant
                </div>
                <div className="mt-2 text-[1rem] font-[800] text-[#0f172a]">
                  {primaryAction?.label || "Prochaine étape à confirmer"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {primaryAction ? <ActionLink to={primaryAction.href}>Ouvrir</ActionLink> : null}
                <SecondaryButton onClick={() => void load()}>
                  <RefreshCw className="w-3.5 h-3.5" /> Recharger
                </SecondaryButton>
              </div>
            </Card>

            <Card>
              <SectionTitle action={<StatusPill {...overall} />}>Checklist essentielle</SectionTitle>
              <div className="space-y-3">
                {checklistRows.length ? (
                  checklistRows.map((item: any, index: number) => (
                    <div
                      key={item.key}
                      className="flex items-start gap-3 rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3.5 transition-all hover:border-[#fecaca] hover:bg-[#fffafa]"
                    >
                      <div
                        className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full ${
                          item.done ? "bg-[#16a34a] text-white" : "bg-[#f8fafc] text-[#64748b]"
                        }`}
                      >
                        {item.done ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <span className="text-xs font-bold">{index + 1}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-[#334155]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                            {item.label}
                          </div>
                          <StatusPill {...item.pill} />
                        </div>
                        {!item.done ? (
                          <p className="mt-1.5 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                            {item.reason}
                          </p>
                        ) : null}
                      </div>
                      {!item.done ? (
                        <ActionLink to={item.href} className="!px-3 !py-1.5 !text-xs">
                          Ouvrir
                        </ActionLink>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="text-[#94a3b8] text-sm">
                    Checklist indisponible pour le moment. Commencez par compléter l’entreprise, puis configurez la
                    plateforme.
                  </p>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export function SetupEinvoicingPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [readinessRes, onboardingRes, companyRes] = await Promise.allSettled([
        readJson("/api/einvoicing/readiness?mode=connected"),
        readJson("/api/platforms/onboarding-status"),
        readJson("/api/company/profile"),
      ]);

      const messages: string[] = [];
      if (readinessRes.status === "fulfilled") setReadiness(readinessRes.value || null);
      else messages.push(formatApiError(readinessRes.reason, "Checklist indisponible."));
      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else messages.push(formatApiError(onboardingRes.reason, "Onboarding indisponible."));
      if (companyRes.status === "fulfilled") setCompany(companyRes.value || null);
      else messages.push(formatApiError(companyRes.reason, "Profil entreprise indisponible."));
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [sessionLoading, einvoicingEnabled]);

  const checksById = useMemo(() => {
    const entries = new Map();
    for (const item of readiness?.checks || []) entries.set(item.id, item);
    return entries;
  }, [readiness]);

  const steps = useMemo(() => {
    const companyCheck = checksById.get("company_profile");
    const pdpCheck = checksById.get("pdp_connection");
    const eReportingCheck = checksById.get("ereporting");
    const sandboxCheck = checksById.get("sandbox_test");

    return [
      {
        key: "company_profile",
        title: "Profil entreprise",
        description: "SIRET, TVA, adresse, RCS et informations légales pour émettre sans blocage.",
        status:
          companyCheck?.status ||
          (company?.siret &&
          (company?.vat_number || company?.vat_exemption_notice) &&
          (company?.address_line1 || company?.address)
            ? "ok"
            : "missing"),
        href: "/app/company",
      },
      {
        key: "pdp_connection",
        title: "Plateforme / connecteur",
        description: "Connexion à une plateforme compatible ou agréée pour les échanges B2B.",
        status: pdpCheck?.status || (countEnabledConnectors(onboarding?.enabled_connectors) > 0 ? "ok" : "missing"),
        href: "/app/einvoicing",
      },
      {
        key: "mandate",
        title: "Mandat de réception",
        description: "Nécessaire pour la réception et certains statuts via la plateforme partenaire.",
        status: onboarding?.mandate?.required
          ? Number(onboarding?.mandate?.active_count || 0) > 0
            ? "ok"
            : "missing"
          : "na",
        href: "/app/einvoicing",
      },
      {
        key: "directory",
        title: "Annuaire & destinataires",
        description: "Synchroniser l’annuaire et renseigner les adresses des clients critiques.",
        status:
          onboarding?.directory?.status === "ok"
            ? "ok"
            : onboarding?.directory?.status === "error"
              ? "error"
              : onboarding?.directory?.status === "disabled"
                ? "na"
                : "todo",
        href: "/app/directory",
      },
      {
        key: "ereporting",
        title: "E-reporting",
        description: "Configurer les périodicités et la production des rapports si requis.",
        status: eReportingCheck?.status || "na",
        href: "/app/e-reporting",
      },
      {
        key: "sandbox_test",
        title: "Test & première transmission",
        description: "Lancer un essai dans l’environnement de test puis vérifier un premier succès de transmission.",
        status: sandboxCheck?.status || (onboarding?.exchanges?.last_success ? "ok" : "todo"),
        href: "/app/settings/sandbox",
      },
    ];
  }, [checksById, onboarding, company]);

  const doneCount = steps.filter((step) => readinessCheckPill(step.status).color === "ok").length;
  const overall = readinessOverallPill(readiness?.overall_status);

  return (
    <div>
      <AppPageHeader
        title="Préparer la facturation électronique"
        breadcrumb="E-facturation"
        description="Feuille de route courte, lisible et orientée action pour passer de la configuration au premier échange conforme."
        actions={
          sessionLoading ? null : einvoicingEnabled ? (
            <StatusPill {...overall} />
          ) : (
            <StatusPill status="warn" label="Plan Pro requis" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title="Assistant e-facturation réservé au plan Pro"
            description="Starter couvre la gestion commerciale classique. Le plan Pro ouvre la préparation e-facturation ; tout échange via une plateforme agréée exige ensuite un contrat, un mandat valide et une configuration opérationnelle."
            note="Le passage au plan Pro n’active pas automatiquement une connexion externe."
          />
        ) : null}
        <SeqinoTokenNotice enabled={Boolean(capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {!sessionLoading && einvoicingEnabled ? (
          <div className="bg-[#eff6ff] border border-[#bfdbfe] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                Progression {doneCount}/{steps.length}
              </h3>
              <p className="text-[#475569] mt-1" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                Commence par le dossier société, puis la plateforme, puis l’annuaire. C’est le chemin le plus court pour
                être vendable et crédible face à un client.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <ActionLink to="/app/company">Compléter l’entreprise</ActionLink>
              <SecondaryButton onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" /> Recharger
              </SecondaryButton>
            </div>
          </div>
        ) : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : hydrated && loading ? (
          <LoadingCard label="Chargement de la checklist…" />
        ) : (
          <div className="grid xl:grid-cols-[1.35fr_1fr] gap-6 items-start">
            <div className="space-y-4">
              {steps.map((step, index) => {
                const pill = readinessCheckPill(step.status);
                return (
                  <Card
                    key={step.key}
                    className={
                      pill.color === "ok" ? "border-[#86efac]" : pill.color === "danger" ? "border-[#fecaca]" : ""
                    }
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${pill.color === "ok" ? "bg-[#16a34a] text-white" : pill.color === "danger" ? "bg-[#dc2626] text-white" : "bg-[#f1f5f9] text-[#64748b]"}`}
                      >
                        {pill.color === "ok" ? (
                          <Check className="w-4 h-4" />
                        ) : pill.color === "danger" ? (
                          <XCircle className="w-4 h-4" />
                        ) : (
                          <span className="text-xs font-bold">{index + 1}</span>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
                          <h3 className="text-[#0f172a] text-[0.9375rem] font-semibold">{step.title}</h3>
                          <StatusPill {...pill} />
                        </div>
                        <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                          {step.description}
                        </p>
                        <div className="mt-3">
                          <Link
                            to={step.href}
                            className="inline-flex items-center gap-1 text-[#1d4ed8] hover:text-[#1e40af] text-sm font-semibold"
                          >
                            Ouvrir <ArrowRight className="w-3 h-3" />
                          </Link>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <div className="space-y-6">
              <Card>
                <SectionTitle>Pré-requis à préparer</SectionTitle>
                <div className="space-y-2">
                  {(readiness?.prerequisites || []).map((item: string) => (
                    <div key={item} className="flex items-start gap-2 text-[#374151] text-sm">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                  {!readiness?.prerequisites?.length ? (
                    <p className="text-[#94a3b8] text-sm">Aucun prérequis disponible pour le moment.</p>
                  ) : null}
                </div>
              </Card>

              <Card>
                <SectionTitle>Derniers signaux</SectionTitle>
                <div className="space-y-3 text-[#374151] text-sm">
                  <div className="flex items-center justify-between">
                    <span>Annuaire</span>
                    <StatusPill {...onboardingDirectoryPill(onboarding?.directory?.status)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Dernier succès</span>
                    <span className="text-[#64748b]">{formatDateTimeFr(onboarding?.exchanges?.last_success)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Dernière erreur</span>
                    <span className="text-[#64748b] text-right max-w-[14rem]">
                      {onboarding?.exchanges?.error_summary || "Aucune"}
                    </span>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [connectorsRes, connectionsRes, onboardingRes] = await Promise.allSettled([
        readJson("/api/platforms/connectors"),
        readJson("/api/platforms/connections"),
        readJson("/api/platforms/onboarding-status"),
      ]);

      const messages: string[] = [];
      if (connectorsRes.status === "fulfilled")
        setConnectors(Array.isArray(connectorsRes.value?.connectors) ? connectorsRes.value.connectors : []);
      else messages.push(formatApiError(connectorsRes.reason, "Catalogue des connecteurs indisponible."));

      if (connectionsRes.status === "fulfilled")
        setConnections(Array.isArray(connectionsRes.value) ? connectionsRes.value : []);
      else {
        setConnections([]);
        messages.push(formatApiError(connectionsRes.reason, "Connexions indisponibles."));
      }

      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else messages.push(formatApiError(onboardingRes.reason, "Statut d’onboarding indisponible."));

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [sessionLoading, einvoicingEnabled]);

  const connectionBySlug = useMemo(() => {
    const map = new Map();
    for (const item of connections) map.set((item.provider_slug || "").toLowerCase(), item);
    return map;
  }, [connections]);

  const testConnection = async (slug: string) => {
    if (!slug) return;
    setTestingSlug(slug);
    setNotice(null);
    setError(null);
    try {
      const result: any = await api(`/api/platforms/test/${slug}`, { method: "POST" });
      setNotice(result?.message || `Test ${prettyProvider(slug)} OK.`);
    } catch (err) {
      setError(formatApiError(err, `Test ${prettyProvider(slug)} impossible.`));
    } finally {
      setTestingSlug(null);
    }
  };

  const disconnect = async (slug: string) => {
    if (!slug) return;
    if (!window.confirm(`Déconnecter ${prettyProvider(slug)} ?`)) return;
    setDisconnectingSlug(slug);
    setNotice(null);
    setError(null);
    try {
      await api(`/api/platforms/connections?provider_slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      setNotice(`${prettyProvider(slug)} déconnecté.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, `Déconnexion ${prettyProvider(slug)} impossible.`));
    } finally {
      setDisconnectingSlug(null);
    }
  };

  const connectedCount = connections.filter((item) => (item.status || "").toLowerCase() === "connected").length;

  return (
    <div>
      <AppPageHeader
        title="Plateformes & connecteurs"
        breadcrumb="E-facturation"
        description="Centre de pilotage pour savoir ce qui est réellement connecté, testable et vendable."
        actions={
          sessionLoading ? null : einvoicingEnabled ? (
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          ) : (
            <StatusPill status="warn" label="Plan Pro requis" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title="Connecteurs réservés au plan Pro"
            description="Passez au plan Pro pour connecter, tester et exploiter les échanges réglementaires via plateforme partenaire."
          />
        ) : null}
        <SeqinoTokenNotice enabled={Boolean(capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

        {!sessionLoading && einvoicingEnabled ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Connecteurs disponibles"
              value={connectors.length}
              sub="Catalogue disponible"
              accent="blue"
              icon={<Globe className="w-4 h-4" />}
            />
            <StatCard
              label="Connexions actives"
              value={connectedCount}
              sub="Espace courant"
              accent="green"
              icon={<CheckCircle className="w-4 h-4" />}
            />
            <StatCard
              label="Mandats actifs"
              value={onboarding?.mandate?.active_count || 0}
              sub={onboarding?.mandate?.required ? "requis pour la plateforme" : "non requis actuellement"}
              accent="purple"
              icon={<Shield className="w-4 h-4" />}
            />
            <StatCard
              label="Dernier succès"
              value={formatDateTimeFr(onboarding?.exchanges?.last_success)}
              sub={onboarding?.exchanges?.error_summary || "Pas d’erreur récente"}
              accent={onboarding?.exchanges?.last_success ? "green" : "amber"}
              icon={<Send className="w-4 h-4" />}
            />
          </div>
        ) : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : hydrated && loading ? (
          <LoadingCard label="Chargement des plateformes…" />
        ) : (
          <>
            {onboarding?.errors?.length ? (
              <NoticeBanner tone="warning">
                <div className="space-y-1">
                  <div style={{ fontWeight: 600 }}>Points bloquants ou incomplets</div>
                  {onboarding.errors.map((item: any) => (
                    <div key={item.code} className="text-sm">
                      {item.message}
                      {item.hint ? ` — ${item.hint}` : ""}
                    </div>
                  ))}
                </div>
              </NoticeBanner>
            ) : null}

            <div className="grid lg:grid-cols-2 gap-6 items-start">
              <Card>
                <SectionTitle>Connecteurs</SectionTitle>
                <div className="space-y-3">
                  {connectors.length === 0 ? (
                    <p className="text-[#94a3b8] text-sm">
                      Aucun connecteur activé pour cet espace. Vérifiez le plan Pro et le dossier entreprise, puis
                      contactez le support si cela persiste.
                    </p>
                  ) : (
                    connectors.map((connector) => {
                      const current = connectionBySlug.get((connector.slug || "").toLowerCase());
                      const active = (current?.status || "").toLowerCase() === "connected";
                      return (
                        <div key={connector.slug} className="border border-[#e2e8f0] rounded-xl p-4 bg-[#f8fafc]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="text-[#0f172a] text-sm font-semibold">
                                  {connector.label || prettyProvider(connector.slug)}
                                </div>
                                <StatusPill
                                  status={active ? "ok" : "muted"}
                                  label={active ? "Connecté" : "Non connecté"}
                                />
                              </div>
                              <p className="text-[#64748b] mt-1 text-xs leading-relaxed">
                                {connector.description ||
                                  "Connecteur disponible pour l’émission, la réception ou le suivi de statut."}
                              </p>
                              <div className="mt-2 text-[#64748b] text-xs">
                                Type {titleCase(connector.kind)} · Auth {titleCase(connector.auth_type)}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2 justify-end">
                              {active ? (
                                <>
                                  <SecondaryButton
                                    disabled={testingSlug === connector.slug}
                                    onClick={() => void testConnection(connector.slug)}
                                  >
                                    <Check className="w-3.5 h-3.5" />{" "}
                                    {testingSlug === connector.slug ? "Test…" : "Tester"}
                                  </SecondaryButton>
                                  <DangerButton
                                    disabled={disconnectingSlug === connector.slug}
                                    onClick={() => void disconnect(connector.slug)}
                                  >
                                    <XCircle className="w-3.5 h-3.5" />{" "}
                                    {disconnectingSlug === connector.slug ? "Déconnexion…" : "Déconnecter"}
                                  </DangerButton>
                                </>
                              ) : (
                                <ActionLink to="/app/einvoicing" className="!px-3 !py-1.5">
                                  Configurer
                                </ActionLink>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>

              <div className="space-y-6">
                <Card>
                  <SectionTitle>État global</SectionTitle>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span>Mandat requis</span>
                      <StatusPill
                        status={onboarding?.mandate?.required ? "warn" : "muted"}
                        label={onboarding?.mandate?.required ? "Oui" : "Non"}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Annuaire</span>
                      <StatusPill {...onboardingDirectoryPill(onboarding?.directory?.status)} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Dernière synchro</span>
                      <span className="text-[#64748b]">{formatDateTimeFr(onboarding?.directory?.last_sync)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Dernière erreur</span>
                      <span className="text-[#64748b] text-right max-w-[14rem]">
                        {onboarding?.directory?.error || onboarding?.exchanges?.error_summary || "Aucune"}
                      </span>
                    </div>
                  </div>
                </Card>

                <Card>
                  <SectionTitle>Parcours conseillé</SectionTitle>
                  <div className="space-y-2 text-[#374151] text-sm">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Compléter la société et les clients FR.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Activer au moins un connecteur et tester la connexion.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Signez le mandat si vous voulez la réception et certains statuts.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Valider l’annuaire et une première transmission réelle.</span>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function TransmissionsPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [pdpOnboarding, setPdpOnboarding] = useState<any>(null);
  const [activatingPdp, setActivatingPdp] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const chorusActive = Boolean(capabilities?.chorus_operational);
  const pdpEnabledByPlan = Boolean(capabilities?.seqino_available_by_plan || capabilities?.seqino_enabled);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [transmissionsRes, onboardingRes, pdpStatusRes] = await Promise.allSettled([
        pdpEnabledByPlan ? readJson("/api/platforms/transmissions") : Promise.resolve([]),
        pdpEnabledByPlan ? readJson("/api/platforms/onboarding-status") : Promise.resolve(null),
        pdpEnabledByPlan ? readJson("/api/platforms/seqino/onboarding-status") : Promise.resolve(null),
      ]);
      const messages: string[] = [];
      if (transmissionsRes.status === "fulfilled")
        setItems(Array.isArray(transmissionsRes.value) ? transmissionsRes.value : []);
      else {
        setItems([]);
        messages.push(formatApiError(transmissionsRes.reason, "Impossible de charger les transmissions."));
      }
      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else setOnboarding(null);
      if (pdpStatusRes.status === "fulfilled") setPdpOnboarding(pdpStatusRes.value || null);
      else setPdpOnboarding(null);
      setError(messages[0] || null);
    } catch (err) {
      setItems([]);
      setError(formatApiError(err, "Impossible de charger les transmissions."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    void load();
  }, [sessionLoading, pdpEnabledByPlan]);

  const activatePdp = async () => {
    if (!pdpEnabledByPlan || activatingPdp) return;
    const accepted = window.confirm(
      `${SEQINO_MANDATE_CONSENT_TEXT}\n\nConfirmer l’activation de la plateforme partenaire ?`,
    );
    if (!accepted) return;
    setActivatingPdp(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/platforms/seqino/mandates/default", {
        method: "POST",
        body: JSON.stringify({ accept_mandate: true }),
      });
      const activeCount = Number(result?.mandate_active_count || 0);
      const connected = Boolean(result?.connected) || activeCount > 0;
      setNotice(
        connected
          ? "Mandat PA partenaire actif. Vérifiez l'annuaire avant une première transmission réelle."
          : "Mandat PA partenaire demandé. Vérification en cours, cliquez sur Vérifier dans quelques secondes.",
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Activation de la plateforme partenaire impossible."));
    } finally {
      setActivatingPdp(false);
    }
  };

  const filtered = useMemo(() => {
    return items.filter((item) => {
      const haystack =
        `${item.invoice_number || ""} ${item.channel || ""} ${item.external_id || ""} ${item.message || ""}`.toLowerCase();
      const matchSearch = !search.trim() || haystack.includes(search.trim().toLowerCase());
      const matchStatus = statusFilter === "all" || (item.status || "").toLowerCase() === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [items, search, statusFilter]);

  const totalErrors = filtered.filter((item) =>
    ["failed", "rejected", "refused", "blocked"].includes((item.status || "").toLowerCase()),
  ).length;
  const totalOk = filtered.filter((item) =>
    ["accepted", "available", "paid"].includes((item.status || "").toLowerCase()),
  ).length;
  const totalPending = filtered.length - totalErrors - totalOk;
  const pdpConnectionStarted = Boolean(
    onboarding?.enabled_connectors?.seqino || onboarding?.enabled_connectors?.generic_http,
  );
  const normalizedPdpStatus = String(pdpOnboarding?.status || "").toLowerCase();
  const mandateActiveCount = Math.max(
    Number(onboarding?.mandate?.active_count || 0),
    Number(pdpOnboarding?.mandate_active_count || 0),
  );
  const pdpActive = Boolean(pdpOnboarding?.connected) || normalizedPdpStatus === "active" || mandateActiveCount > 0;
  const directoryPill = onboardingDirectoryPill(onboarding?.directory?.status);
  const setupCards = [
    {
      key: "chorus",
      title: "Canal public",
      detail: chorusActive
        ? "Actif avec le plan Pro et la configuration entreprise."
        : pdpEnabledByPlan
          ? "Connecteur disponible selon configuration entreprise."
          : "Réservé au plan Pro.",
      pill: chorusActive ? { color: "ok" as const, label: "Actif" } : { color: "warn" as const, label: "À vérifier" },
      icon: <Shield className="w-4 h-4" />,
    },
    {
      key: "pdp",
      title: "PA partenaire",
      detail: !pdpEnabledByPlan
        ? "Disponible avec l’abonnement Pro."
        : pdpActive
          ? "Mandat actif. Vérifiez l’annuaire avant les échanges B2B réels."
          : pdpConnectionStarted
            ? "Mandat demandé depuis les données société. Vérification en cours."
            : "Préparation guidée depuis cet espace. Les données société préremplissent la demande de mandat.",
      consent:
        pdpEnabledByPlan && !pdpActive
          ? "En activant ce service, vous confirmez autoriser PixFacture à préparer ou créer le mandat nécessaire avec la plateforme partenaire. L’abonnement Pro seul ne vaut pas activation réglementaire."
          : null,
      pill: !pdpEnabledByPlan
        ? { color: "warn" as const, label: "Pro requis" }
        : pdpActive
          ? { color: "ok" as const, label: "Actif" }
          : pdpConnectionStarted
            ? { color: "warn" as const, label: "En cours" }
            : { color: "warn" as const, label: "À activer" },
      icon: <Globe className="w-4 h-4" />,
      action: !pdpEnabledByPlan ? (
        <ActionLink to="/app/billing" className="!px-3 !py-1.5 !text-xs">
          Passer Pro
        </ActionLink>
      ) : pdpActive ? (
        <SecondaryButton onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Vérifier
        </SecondaryButton>
      ) : (
        <PrimaryButton disabled={activatingPdp} onClick={() => void activatePdp()}>
          <Settings className="w-3.5 h-3.5" />{" "}
          {activatingPdp ? "Activation…" : pdpConnectionStarted ? "Vérifier l’activation" : "Valider et activer"}
        </PrimaryButton>
      ),
    },
    {
      key: "mandates",
      title: "Mandats",
      detail: !pdpEnabledByPlan
        ? "Non requis tant que la PDP n’est pas activée."
        : mandateActiveCount > 0
          ? `${mandateActiveCount} mandat(s) actif(s).`
          : "À activer explicitement depuis les informations de Mon entreprise.",
      pill:
        mandateActiveCount > 0
          ? { color: "ok" as const, label: "OK" }
          : { color: "muted" as const, label: "À vérifier" },
      icon: <FileText className="w-4 h-4" />,
    },
    {
      key: "directory",
      title: "Annuaire",
      detail:
        onboarding?.directory?.status === "disabled"
          ? "Non activé sur cet environnement de test."
          : "Statut des destinataires et adresses.",
      pill: directoryPill,
      icon: <Building2 className="w-4 h-4" />,
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="Transmissions"
        breadcrumb="E-facturation"
        description="Historique centralisé des statuts d’envoi, plus lisible pour le support et plus rassurant pour la vente."
        actions={
          <SecondaryButton onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-5">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

        <Card data-testid="transmissions-essentials">
          <SectionTitle>Essentiel avant envoi</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {setupCards.map((card) => (
              <div key={card.key} className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white text-[#1d4ed8] shadow-sm">
                      {card.icon}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 800 }}>
                        {card.title}
                      </p>
                      <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.73rem", lineHeight: 1.55 }}>
                        {card.detail}
                      </p>
                      {"consent" in card && card.consent ? (
                        <p
                          className="mt-2 rounded-lg border border-[#bfdbfe] bg-white px-2.5 py-2 text-[#1e3a8a]"
                          style={{ fontSize: "0.68rem", lineHeight: 1.45 }}
                        >
                          {card.consent}
                        </p>
                      ) : null}
                      {"action" in card && card.action ? <div className="mt-3">{card.action}</div> : null}
                    </div>
                  </div>
                  <StatusPill {...card.pill} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Lignes"
            value={filtered.length}
            sub="Après filtres"
            accent="blue"
            icon={<FileText className="w-4 h-4" />}
          />
          <StatCard
            label="Succès"
            value={totalOk}
            sub="Acceptées / disponibles"
            accent="green"
            icon={<CheckCircle className="w-4 h-4" />}
          />
          <StatCard
            label="En attente"
            value={totalPending}
            sub="À suivre"
            accent="amber"
            icon={<RefreshCw className="w-4 h-4" />}
          />
          <StatCard
            label="Erreurs"
            value={totalErrors}
            sub="Rejets / échecs"
            accent="red"
            icon={<AlertCircle className="w-4 h-4" />}
          />
        </div>

        <div className="flex flex-col lg:flex-row gap-3 justify-between">
          <div className="flex flex-wrap gap-2">
            {["all", "accepted", "submitted", "processing", "failed", "rejected"].map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 rounded-lg border transition-all ${statusFilter === status ? "text-white border-transparent" : "bg-white border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc]"}`}
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  background: statusFilter === status ? "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)" : undefined,
                }}
              >
                {status === "all" ? "Toutes" : titleCase(status)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 px-3 py-2 border border-[#e2e8f0] rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] max-w-sm w-full lg:w-[320px]">
            <Search className="w-4 h-4 text-[#94a3b8]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Facture, canal, message…"
              className="outline-none bg-transparent text-[#374151] placeholder:text-[#94a3b8] flex-1 text-sm"
            />
          </div>
        </div>

        {hydrated && loading ? (
          <LoadingCard label="Chargement des transmissions…" />
        ) : filtered.length === 0 ? (
          <SectionEmpty
            title="Aucune transmission"
            description="Les transmissions réalisées depuis le cœur facture apparaîtront ici avec leur statut le plus récent."
            href="/app/invoices"
            cta="Ouvrir les factures"
          />
        ) : (
          <DataTable headers={["Facture", "Date", "Canal", "Statut", "Mise à jour", "Message", "Action"]}>
            {filtered.map((item) => (
              <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                <td className="px-4 py-3">
                  <Link
                    to={`/app/invoices/${item.invoice_id}`}
                    className="text-[#1d4ed8] hover:text-[#1e40af] text-sm font-semibold"
                  >
                    {item.invoice_number || item.invoice_id}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[#64748b] text-xs">{formatDateFr(item.invoice_issue_date)}</td>
                <td className="px-4 py-3 text-[#374151] text-sm">{prettyProvider(item.channel)}</td>
                <td className="px-4 py-3">
                  <StatusPill {...transmissionPill(item.status)} />
                </td>
                <td className="px-4 py-3 text-[#64748b] text-xs">{formatDateTimeFr(item.updated_at)}</td>
                <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 260 }}>
                  {item.message || item.external_id || "—"}
                </td>
                <td className="px-4 py-3">
                  <Link
                    to={`/app/invoices/${item.invoice_id}`}
                    className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-semibold"
                  >
                    Ouvrir
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
    </div>
  );
}

export function DirectoryPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<any>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lookupValue, setLookupValue] = useState("");
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [form, setForm] = useState({ siren: "", siret: "", platform_slug: "", billing_address: "" });

  const resetForm = () => {
    setEditingId(null);
    setForm({ siren: "", siret: "", platform_slug: connectors[0]?.slug || "", billing_address: "" });
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, entriesRes, connectorsRes] = await Promise.allSettled([
        readJson("/api/directory/status"),
        readJson("/api/platforms/endpoints"),
        readJson("/api/directory/connectors"),
      ]);

      const messages: string[] = [];
      if (statusRes.status === "fulfilled") setStatusInfo(statusRes.value || null);
      else messages.push(formatApiError(statusRes.reason, "Statut annuaire indisponible."));

      if (entriesRes.status === "fulfilled") setEntries(Array.isArray(entriesRes.value) ? entriesRes.value : []);
      else {
        setEntries([]);
        messages.push(formatApiError(entriesRes.reason, "Adresses destinataires indisponibles."));
      }

      if (connectorsRes.status === "fulfilled") {
        const next = Array.isArray(connectorsRes.value?.connectors) ? connectorsRes.value.connectors : [];
        setConnectors(next);
        setForm((prev) => ({ ...prev, platform_slug: prev.platform_slug || next[0]?.slug || "" }));
      } else {
        setConnectors([]);
      }

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveEntry = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        siren: form.siren.trim(),
        siret: form.siret.trim() || null,
        platform_slug: form.platform_slug.trim(),
        billing_address: form.billing_address.trim(),
      };
      if (editingId) {
        await api(`/api/platforms/endpoints/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
        setNotice("Adresse destinataire mise à jour.");
      } else {
        await api("/api/platforms/endpoints", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Adresse destinataire ajoutée.");
      }
      resetForm();
      await load();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async (entry: any) => {
    if (!window.confirm(`Supprimer l’entrée ${entry.siren}${entry.siret ? ` / ${entry.siret}` : ""} ?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/platforms/endpoints/${entry.id}`, { method: "DELETE" });
      setNotice("Entrée supprimée.");
      if (editingId === entry.id) resetForm();
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setBusy(false);
    }
  };

  const queueRefresh = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/directory/refresh", { method: "POST" });
      setNotice("Synchronisation annuaire lancée. Son avancement reste visible dans le statut de l’annuaire.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Synchronisation impossible."));
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result: any = await apiFetch("/api/directory/import", { method: "POST", body });
      setNotice(
        `Import terminé : ${Number(result?.created || 0)} créée(s), ${Number(result?.updated || 0)} mise(s) à jour.`,
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Import CSV impossible."));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    const digits = lookupValue.replace(/\D+/g, "");
    if (!digits) return;
    setLookupError(null);
    setLookupResult(null);
    try {
      const query = digits.length >= 14 ? `siret=${digits}` : `siren=${digits.slice(0, 9)}`;
      const result = await readJson(`/api/directory/lookup?${query}`);
      setLookupResult(result || null);
    } catch (err) {
      setLookupError(formatApiError(err, "Aucune entrée trouvée."));
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Annuaire & destinataires"
        breadcrumb="E-facturation"
        description="Rend l’adressage B2B beaucoup plus lisible : couverture clients, adresses manuelles et synchros récentes."
        actions={
          <div className="flex gap-2">
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
            <PrimaryButton onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-3.5 h-3.5" /> Import CSV
            </PrimaryButton>
          </div>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            void importCsv(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="PPF configuré"
            value={statusInfo?.ppf_configured ? "Oui" : "Non"}
            sub="Connexion annuaire"
            accent={statusInfo?.ppf_configured ? "green" : "amber"}
            icon={<Globe className="w-4 h-4" />}
          />
          <StatCard
            label="Couverture clients"
            value={`${Number(statusInfo?.coverage?.coverage_rate || 0)}%`}
            sub={`${Number(statusInfo?.coverage?.with_endpoint || 0)} / ${Number(statusInfo?.coverage?.total_customers || 0)} clients`}
            accent="blue"
            icon={<Building2 className="w-4 h-4" />}
          />
          <StatCard
            label="Entrées PPF"
            value={Number(statusInfo?.ppf_entries || 0)}
            sub="Mises en cache"
            accent="purple"
            icon={<FileText className="w-4 h-4" />}
          />
          <StatCard
            label="Dernière synchro"
            value={formatDateTimeFr(statusInfo?.last_ppf_sync_at)}
            sub="Historique annuaire"
            accent={statusInfo?.last_ppf_sync_at ? "green" : "cyan"}
            icon={<RefreshCw className="w-4 h-4" />}
          />
        </div>

        {loading ? (
          <LoadingCard label="Chargement de l’annuaire…" />
        ) : (
          <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
            <div className="space-y-6">
              <Card>
                <SectionTitle
                  action={
                    <SecondaryButton disabled={busy} onClick={() => void queueRefresh()}>
                      <RefreshCw className="w-3.5 h-3.5" /> Relancer la synchro
                    </SecondaryButton>
                  }
                >
                  Adresses destinataires
                </SectionTitle>
                {entries.length === 0 ? (
                  <SectionEmpty
                    title="Aucune adresse manuelle"
                    description="Ajoutez ici les destinataires prioritaires pour fiabiliser les premiers échanges avant d’automatiser le reste."
                  />
                ) : (
                  <DataTable
                    headers={[
                      "SIREN / SIRET",
                      "Plateforme",
                      "Adresse de facturation",
                      "Source",
                      "Mis à jour",
                      "Action",
                    ]}
                  >
                    {entries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-[#f8fafc] transition-colors">
                        <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                          {entry.siren}
                          {entry.siret ? <span className="text-[#94a3b8] font-normal"> / {entry.siret}</span> : null}
                        </td>
                        <td className="px-4 py-3 text-[#374151] text-sm">{prettyProvider(entry.platform_slug)}</td>
                        <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 260 }}>
                          {entry.billing_address}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill
                            status={entry.source === "ppf" ? "info" : entry.source === "manual" ? "purple" : "muted"}
                            label={titleCase(entry.source || "manuel")}
                          />
                        </td>
                        <td className="px-4 py-3 text-[#64748b] text-xs">
                          {formatDateTimeFr(entry.updated_at || entry.last_synced_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <SecondaryButton
                              className="!px-3 !py-1.5"
                              onClick={() => {
                                setEditingId(entry.id);
                                setForm({
                                  siren: entry.siren || "",
                                  siret: entry.siret || "",
                                  platform_slug: entry.platform_slug || connectors[0]?.slug || "",
                                  billing_address: entry.billing_address || "",
                                });
                              }}
                            >
                              Modifier
                            </SecondaryButton>
                            <DangerButton className="!px-3 !py-1.5" onClick={() => void deleteEntry(entry)}>
                              Supprimer
                            </DangerButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </Card>

              <Card>
                <SectionTitle>Dernières synchronisations</SectionTitle>
                {(statusInfo?.recent_syncs || []).length === 0 ? (
                  <p className="text-[#94a3b8] text-sm">Aucune synchronisation enregistrée.</p>
                ) : (
                  <div className="space-y-3">
                    {(statusInfo?.recent_syncs || []).map((run: any) => (
                      <div
                        key={run.id}
                        className="flex items-start justify-between gap-3 p-4 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]"
                      >
                        <div>
                          <div className="text-[#0f172a] text-sm font-semibold">
                            {titleCase(run.source || "annuaire")}
                          </div>
                          <p className="text-[#64748b] mt-1 text-xs">
                            {run.total_found || 0} trouvée(s), {run.total_created || 0} créée(s),{" "}
                            {run.total_updated || 0} mise(s) à jour.
                          </p>
                        </div>
                        <div className="text-right">
                          <StatusPill
                            status={(run.status || "").toLowerCase() === "failed" ? "danger" : "ok"}
                            label={(run.status || "").toLowerCase() === "failed" ? "Erreur" : "OK"}
                          />
                          <div className="text-[#94a3b8] mt-1 text-xs">
                            {formatDateTimeFr(run.finished_at || run.started_at)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <SectionTitle>{editingId ? "Modifier une adresse" : "Ajouter une adresse"}</SectionTitle>
                <div className="space-y-4">
                  <InputField
                    label="SIREN"
                    value={form.siren}
                    onChange={(event) => setForm((prev) => ({ ...prev, siren: event.target.value }))}
                    placeholder="123456789"
                  />
                  <InputField
                    label="SIRET (optionnel)"
                    value={form.siret}
                    onChange={(event) => setForm((prev) => ({ ...prev, siret: event.target.value }))}
                    placeholder="12345678900010"
                  />
                  <SelectField
                    label="Plateforme"
                    value={form.platform_slug}
                    onChange={(event) => setForm((prev) => ({ ...prev, platform_slug: event.target.value }))}
                  >
                    {(connectors.length ? connectors : [{ slug: "manual", label: "Manuel" }]).map((item) => (
                      <option key={item.slug} value={item.slug}>
                        {item.label || prettyProvider(item.slug)}
                      </option>
                    ))}
                  </SelectField>
                  <div>
                    <label className="block text-[#374151] mb-1.5 text-sm font-medium">Adresse de facturation</label>
                    <textarea
                      value={form.billing_address}
                      onChange={(event) => setForm((prev) => ({ ...prev, billing_address: event.target.value }))}
                      rows={4}
                      placeholder="Adresse déclarative de facturation"
                      className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <PrimaryButton disabled={busy} onClick={() => void saveEntry()}>
                      {editingId ? "Enregistrer" : "Ajouter"}
                    </PrimaryButton>
                    {editingId ? <SecondaryButton onClick={resetForm}>Annuler</SecondaryButton> : null}
                  </div>
                </div>
              </Card>

              <Card>
                <SectionTitle
                  action={
                    <SecondaryButton onClick={() => void lookup()}>
                      <Search className="w-3.5 h-3.5" /> Rechercher
                    </SecondaryButton>
                  }
                >
                  Lookup rapide
                </SectionTitle>
                <div className="space-y-3">
                  <InputField
                    label="SIREN ou SIRET"
                    value={lookupValue}
                    onChange={(event) => setLookupValue(event.target.value)}
                    placeholder="123456789 ou 12345678900010"
                  />
                  {lookupError ? <p className="text-[#dc2626] text-xs">{lookupError}</p> : null}
                  {lookupResult ? (
                    <div className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0] space-y-1.5 text-sm">
                      <div className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                        {lookupResult.siren}
                        {lookupResult.siret ? ` / ${lookupResult.siret}` : ""}
                      </div>
                      <div className="text-[#64748b]">{prettyProvider(lookupResult.platform_slug)}</div>
                      <div className="text-[#64748b]">{lookupResult.billing_address}</div>
                    </div>
                  ) : null}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InboxListView() {
  const location = useLocation();
  const importRef = useRef<HTMLInputElement | null>(null);
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [connection, setConnection] = useState<any>(null);
  const [actionCenter, setActionCenter] = useState<any>(null);
  const [purchaseWorkflow, setPurchaseWorkflow] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [validationFilter, setValidationFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [purchaseQuickFilter, setPurchaseQuickFilter] = useState<
    "all" | "received" | "reviewing" | "ready_to_pay" | "invalid"
  >(() => {
    if (typeof window === "undefined") return "all";
    const params = new URLSearchParams(window.location.search);
    const intent = `${params.get("filter") || ""} ${params.get("focus") || ""}`.toLowerCase();
    if (intent.includes("ready_to_pay")) return "ready_to_pay";
    if (intent.includes("vat_correction") || intent.includes("vat_corrections") || intent.includes("corrections_tva")) {
      return "invalid";
    }
    return "all";
  });

  const statusOptions = [
    { value: "all", label: "Tous les statuts" },
    { value: "received", label: "Reçues" },
    { value: "acknowledged", label: "Acquittées" },
    { value: "accepted", label: "Acceptées" },
    { value: "rejected", label: "Rejetées" },
    { value: "correction_requested", label: "Correction demandée" },
    { value: "imported", label: "Importées" },
  ];
  const validationOptions = [
    { value: "all", label: "Toutes validations" },
    { value: "valid", label: "Valides" },
    { value: "invalid", label: "Invalides" },
    { value: "warning", label: "Avec avertissement" },
    { value: "skipped", label: "Non vérifiées" },
  ];

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("page_size", "50");
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (validationFilter !== "all") params.set("validation_status", validationFilter);
    return params.toString();
  }, [search, statusFilter, validationFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queryString = buildQueryString();
      const [listRes, summaryRes, connectionRes, actionCenterRes, workflowRes] = await Promise.allSettled([
        readJson(`/api/inbox?${queryString}`),
        readJson(`/api/inbox/summary?${queryString}`),
        readJson("/api/inbox/connection"),
        isPurchasesView ? readJson("/api/ops/action-center") : Promise.resolve(null),
        isPurchasesView ? readJson("/api/ops/purchase-workflow-summary") : Promise.resolve(null),
      ]);
      const messages: string[] = [];
      if (listRes.status === "fulfilled") setItems(Array.isArray(listRes.value?.items) ? listRes.value.items : []);
      else {
        setItems([]);
        messages.push(formatApiError(listRes.reason, "Inbox indisponible."));
      }
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value || null);
      else setSummary(null);
      if (connectionRes.status === "fulfilled") setConnection(connectionRes.value || null);
      else setConnection(null);
      if (actionCenterRes.status === "fulfilled") setActionCenter(actionCenterRes.value || null);
      else setActionCenter(null);
      if (workflowRes.status === "fulfilled") setPurchaseWorkflow(workflowRes.value || null);
      else setPurchaseWorkflow(null);
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [buildQueryString, isPurchasesView]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        void load();
      },
      search.trim() ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [load, reloadKey, search]);

  useEffect(() => {
    if (statusFilter !== "all" || validationFilter !== "all") {
      setShowFilters(true);
    }
  }, [statusFilter, validationFilter]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setBusyImport(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      await apiFetch("/api/inbox/import", { method: "POST", body });
      setNotice("Document importé dans les achats fournisseurs.");
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Import impossible."));
    } finally {
      setBusyImport(false);
    }
  };

  const totals = summary?.totals || {};
  const topSuppliers = Array.isArray(summary?.top_suppliers) ? summary.top_suppliers : [];
  const invalidCount = Number(summary?.validation_counts?.invalid || 0);
  const receivedCount = Number(summary?.status_counts?.received || 0);
  const workflowStatesMap = purchaseWorkflow?.items_by_invoice || {};
  const reviewingCount = Number(purchaseWorkflow?.states?.reviewing || 0);
  const readyToPayCount = Number(purchaseWorkflow?.states?.ready_to_pay || 0);
  const exportPath = `/api/inbox/export?${buildQueryString()}`;
  const purchasePriorityQueue =
    isPurchasesView && Array.isArray(actionCenter?.items)
      ? actionCenter.items.filter((entry: any) => String(entry?.module || "").toLowerCase() === "purchases").slice(0, 4)
      : [];
  const purchaseStatusTabs = [
    { value: "all" as const, label: "Tous", count: Number(totals.count || items.length || 0) },
    { value: "received" as const, label: "À traiter", count: receivedCount },
    { value: "reviewing" as const, label: "En revue", count: reviewingCount },
    { value: "ready_to_pay" as const, label: "Bon à payer", count: readyToPayCount },
    { value: "invalid" as const, label: "À corriger", count: invalidCount },
  ];
  const visibleItems = useMemo(() => {
    if (!isPurchasesView) return items;
    return items.filter((item) => {
      const status = String(item?.status || "").toLowerCase();
      const validation = String(item?.validation_status || "").toLowerCase();
      const workflowState = String(workflowStatesMap[item?.id]?.state || "").toLowerCase();
      if (purchaseQuickFilter === "received") return status === "received";
      if (purchaseQuickFilter === "reviewing") return workflowState === "reviewing";
      if (purchaseQuickFilter === "ready_to_pay") return workflowState === "ready_to_pay";
      if (purchaseQuickFilter === "invalid") return validation === "invalid";
      return true;
    });
  }, [isPurchasesView, items, purchaseQuickFilter, workflowStatesMap]);
  const hasSearch = Boolean(search.trim());
  const hasServerFilters = statusFilter !== "all" || validationFilter !== "all";
  const emptyTitle =
    hasSearch || (isPurchasesView && purchaseQuickFilter !== "all") || hasServerFilters
      ? "Aucun résultat"
      : "Aucune facture fournisseur";
  const emptyDescription = hasSearch
    ? `"${search.trim()}" ne correspond à aucune facture fournisseur.`
    : isPurchasesView && purchaseQuickFilter !== "all"
      ? "Aucune facture ne correspond à cette catégorie pour le moment."
      : hasServerFilters
        ? "Aucune facture ne correspond aux filtres avancés sélectionnés."
        : "Importe un Factur-X ou configure une plateforme pour centraliser les achats et leur validation.";
  const visibleCountLabel = `${visibleItems.length} document(s) visible(s)`;

  return (
    <>
      {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
      {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
      <input
        ref={importRef}
        type="file"
        accept="application/pdf,application/xml,text/xml,.pdf,.xml"
        className="hidden"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <Card className="border-[#dbeafe] bg-[linear-gradient(135deg,#eff6ff_0%,#ffffff_72%)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-1.5 max-w-3xl">
            <div className="text-[#0f172a] text-[0.9375rem] font-bold">
              {isPurchasesView ? "Achats & fournisseurs" : "Réception fournisseurs"}
            </div>
            <p className="text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
              {connection?.active
                ? `Réception connectée : ${(connection.providers || []).map((item: any) => item.label).join(", ") || "—"}. Suivi des factures fournisseurs, validations et principaux émetteurs.`
                : "Aucune plateforme active. Importez un PDF Factur-X ou un XML pour contrôler vos achats fournisseurs."}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <StatusPill
                color={connection?.active ? "ok" : "warn"}
                label={connection?.active ? "Réception connectée" : "Import manuel"}
              />
              <StatusPill
                color={invalidCount > 0 ? "danger" : "muted"}
                label={invalidCount > 0 ? `${invalidCount} invalide(s)` : "Aucune erreur critique"}
              />
              {totals.latest_received_at ? (
                <StatusPill color="info" label={`Dernière réception ${formatDateTimeFr(totals.latest_received_at)}`} />
              ) : null}
              {isPurchasesView ? (
                <StatusPill
                  color={readyToPayCount > 0 ? "purple" : "muted"}
                  label={`${readyToPayCount} bon(s) à payer`}
                />
              ) : null}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap xl:justify-end">
            <PrimaryButton disabled={busyImport} onClick={() => importRef.current?.click()}>
              <Upload className="w-3.5 h-3.5" /> {busyImport ? "Import…" : "Importer"}
            </PrimaryButton>
            <ActionMenu label="Plus">
              <ActionMenuButton
                icon={Download}
                onClick={() => void downloadProtectedFile(exportPath, "achats_fournisseurs.csv")}
                aria-label="Exporter la vue filtrée des achats"
                title="Exporte les achats correspondant aux filtres affichés."
              >
                Exporter la vue filtrée
              </ActionMenuButton>
              <ActionMenuButton icon={RefreshCw} onClick={() => setReloadKey((current) => current + 1)}>
                Rafraîchir
              </ActionMenuButton>
              {!connection?.active ? (
                <ActionMenuLink to="/app/einvoicing" icon={Globe}>
                  Configurer la plateforme
                </ActionMenuLink>
              ) : null}
            </ActionMenu>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Factures reçues"
          value={Number(totals.count || 0)}
          sub="Selon les filtres"
          accent="blue"
          icon={<Inbox className="w-4 h-4" />}
        />
        <StatCard
          label="À traiter"
          value={receivedCount}
          sub="Statut reçue"
          accent="amber"
          icon={<Mail className="w-4 h-4" />}
        />
        <StatCard
          label={isPurchasesView ? "En revue" : "Validation KO"}
          value={isPurchasesView ? reviewingCount : invalidCount}
          sub={isPurchasesView ? "Workflow achat" : "Structure à corriger"}
          accent={isPurchasesView ? "amber" : "red"}
          icon={isPurchasesView ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
        />
        <StatCard
          label={isPurchasesView ? "Bon à payer" : "30 jours"}
          value={isPurchasesView ? readyToPayCount : money(totals.last_30_days_ttc || 0)}
          sub={isPurchasesView ? "Prêts pour finance" : `${Number(totals.last_30_days_count || 0)} facture(s)`}
          accent={isPurchasesView ? "cyan" : "green"}
          icon={isPurchasesView ? <Check className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
        />
      </div>

      <div className="grid xl:grid-cols-[1.3fr_0.7fr] gap-6 items-start">
        <div className="space-y-4">
          {isPurchasesView ? (
            <Card padding={false} className="overflow-hidden">
              <div
                className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <div className="flex flex-wrap items-center gap-0.5">
                  {purchaseStatusTabs.map((tab) => {
                    const active = purchaseQuickFilter === tab.value;
                    return (
                      <button
                        key={tab.value}
                        type="button"
                        onClick={() => setPurchaseQuickFilter(tab.value)}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all"
                        style={{
                          fontSize: "0.8125rem",
                          fontWeight: active ? 600 : 400,
                          background: active ? "linear-gradient(135deg,#1d4ed8,#4f46e5)" : "transparent",
                          color: active ? "#ffffff" : "#64748b",
                          boxShadow: active ? "0 1px 4px rgba(29,78,216,0.2)" : "none",
                        }}
                      >
                        {tab.label}
                        <span
                          className="inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1.5"
                          style={{
                            fontSize: "0.625rem",
                            fontWeight: 700,
                            background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9",
                            color: active ? "#ffffff" : "#94a3b8",
                          }}
                        >
                          {tab.count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 sm:w-72"
                    style={{ background: "#f8fafc", border: "1px solid #e9eef4" }}
                  >
                    <Search className="h-3.5 w-3.5 flex-shrink-0 text-[#94a3b8]" />
                    <input
                      placeholder="Fournisseur, facture, SIREN..."
                      className="min-w-0 flex-1 bg-transparent text-[#374151] outline-none placeholder:text-[#94a3b8]"
                      style={{ fontSize: "0.8125rem" }}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <SecondaryButton onClick={() => setShowFilters((value) => !value)}>
                    <SlidersHorizontal className="w-3.5 h-3.5" /> {showFilters ? "Masquer les filtres" : "Filtres"}
                  </SecondaryButton>
                </div>
              </div>

              {showFilters ? (
                <div className="grid gap-3 border-b border-[#f1f5f9] px-4 py-3 md:grid-cols-2">
                  <SelectField
                    label="Statut"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    {statusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Validation"
                    value={validationFilter}
                    onChange={(event) => setValidationFilter(event.target.value)}
                  >
                    {validationOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectField>
                </div>
              ) : null}

              {loading ? (
                <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  Chargement des achats fournisseurs…
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                      <Inbox className="h-5 w-5 text-[#cbd5e1]" />
                    </div>
                    <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                      {emptyTitle}
                    </p>
                    <p className="max-w-md text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      {emptyDescription}
                    </p>
                    <div className="mt-2 flex flex-wrap justify-center gap-2">
                      {hasSearch || purchaseQuickFilter !== "all" || hasServerFilters ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSearch("");
                            setPurchaseQuickFilter("all");
                            setStatusFilter("all");
                            setValidationFilter("all");
                          }}
                          className="text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                          style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                        >
                          Voir tous les achats
                        </button>
                      ) : null}
                      {!connection?.active ? (
                        <Link
                          to="/app/einvoicing"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3 py-1.5 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
                          style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                        >
                          <Globe className="h-3.5 w-3.5" /> Configurer la plateforme
                        </Link>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => importRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#dbeafe] bg-white px-3 py-1.5 text-[#475569] transition-colors hover:bg-[#f8fafc]"
                        style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                      >
                        <Upload className="h-3.5 w-3.5" /> Importer un document
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <DataTable headers={["Fournisseur", "Réception", "Montant", "Prochaine étape", "Action"]}>
                  {visibleItems.map((item) => {
                    const workflow = workflowStatesMap[item.id];
                    const guidance = purchaseOpsGuidance(item, workflow);
                    return (
                      <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                        <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                          <div>{item.supplier_name || "Fournisseur"}</div>
                          <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 500 }}>
                            {item.invoice_number || item.id} ·{" "}
                            {item.supplier_siret || item.supplier_siren || prettyProvider(item.provider_slug)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[#64748b] text-xs">
                          <div>{formatDateTimeFr(item.received_at)}</div>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <StatusPill {...validationPill(item.validation_status)} />
                            <StatusPill {...purchaseWorkflowPill(workflow)} />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[#374151] text-sm">
                          <div style={{ fontWeight: 700, color: "#0f172a" }}>
                            {money(item.total_ttc, item.currency || "EUR")}
                          </div>
                          <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                            {titleCase(item.format || "—")} · {inboxStatusPill(item.status).label}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[#64748b] text-xs leading-relaxed">
                          <div className="text-[#0f172a]" style={{ fontWeight: 700 }}>
                            {guidance.title}
                          </div>
                          <div className="text-[#64748b]">{guidance.description}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Link
                            to={`${basePath}/${item.id}`}
                            className="pf-action-icon pf-action-icon--purchase"
                            aria-label={`Ouvrir ${item.supplier_name || "achat"}`}
                            title="Ouvrir"
                          >
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              )}

              <div className="px-4 pb-4 pt-3 text-xs text-[#94a3b8]">{visibleCountLabel}</div>
            </Card>
          ) : (
            <>
              <div className="space-y-3">
                <div className="grid md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                  <div className="flex items-center gap-2 px-3 py-2 border border-[#e2e8f0] rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                    <Search className="w-4 h-4 text-[#94a3b8]" />
                    <input
                      placeholder="Fournisseur, n° facture, SIREN…"
                      className="outline-none bg-transparent text-[#374151] placeholder:text-[#94a3b8] flex-1 text-sm"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <SecondaryButton onClick={() => setShowFilters((value) => !value)}>
                    <SlidersHorizontal className="w-3.5 h-3.5" /> {showFilters ? "Masquer les filtres" : "Filtres"}
                  </SecondaryButton>
                </div>

                {showFilters ? (
                  <div className="grid md:grid-cols-2 gap-3">
                    <SelectField
                      label="Statut"
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value)}
                    >
                      {statusOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="Validation"
                      value={validationFilter}
                      onChange={(event) => setValidationFilter(event.target.value)}
                    >
                      {validationOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                ) : null}
              </div>

              {loading ? (
                <LoadingCard label="Chargement des achats fournisseurs…" />
              ) : items.length === 0 ? (
                <SectionEmpty
                  title="Aucune facture fournisseur"
                  description="Importe un Factur-X ou configure une plateforme pour centraliser les achats et leur validation."
                  href={connection?.active ? undefined : "/app/einvoicing"}
                  cta={connection?.active ? undefined : "Configurer la plateforme"}
                />
              ) : (
                <DataTable
                  headers={[
                    "Fournisseur",
                    "Facture",
                    "Réception",
                    "Total TTC",
                    "Format",
                    "Statut",
                    "Validation",
                    "Workflow",
                    "Action",
                  ]}
                >
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                      <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                        {item.supplier_name || "Fournisseur"}
                        <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 500 }}>
                          {item.supplier_siret || item.supplier_siren || prettyProvider(item.provider_slug)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[#374151] text-sm">{item.invoice_number || item.id}</td>
                      <td className="px-4 py-3 text-[#64748b] text-xs">
                        <div>{formatDateTimeFr(item.received_at)}</div>
                        <div className="text-[#cbd5e1]">Émise le {formatDateFr(item.issue_date)}</div>
                      </td>
                      <td className="px-4 py-3 text-[#374151] text-sm">
                        {money(item.total_ttc, item.currency || "EUR")}
                      </td>
                      <td className="px-4 py-3 text-[#64748b] text-xs">{titleCase(item.format || "—")}</td>
                      <td className="px-4 py-3">
                        <StatusPill {...inboxStatusPill(item.status)} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill {...validationPill(item.validation_status)} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill {...purchaseWorkflowPill(workflowStatesMap[item.id])} />
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`${basePath}/${item.id}`}
                          className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-semibold"
                        >
                          Ouvrir
                        </Link>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </>
          )}
        </div>

        <div className="space-y-6">
          {isPurchasesView ? (
            <Card>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <SectionTitle>À valider maintenant</SectionTitle>
                  <p className="text-[#64748b] -mt-2 text-xs">
                    Les achats qui demandent un geste humain immédiat, sans parcourir toute la liste.
                  </p>
                </div>
                <Link to="/app/purchases" className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-bold">
                  Voir les achats
                </Link>
              </div>
              {purchasePriorityQueue.length === 0 ? (
                <p className="text-[#94a3b8] mt-4 text-sm">Aucune priorité achat remontée pour le moment.</p>
              ) : (
                <div className="space-y-3 mt-4">
                  {purchasePriorityQueue.map((entry: any) => (
                    <div key={entry.id} className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill
                              color={
                                String(entry.severity || "").toLowerCase() === "critical"
                                  ? "danger"
                                  : String(entry.severity || "").toLowerCase() === "high"
                                    ? "warn"
                                    : "info"
                              }
                              label={
                                String(entry.severity || "").toLowerCase() === "critical"
                                  ? "Critique"
                                  : String(entry.severity || "").toLowerCase() === "high"
                                    ? "Haute"
                                    : "À suivre"
                              }
                            />
                            <StatusPill color="purple" label={entry.module_label || "Achats"} />
                          </div>
                          <div className="mt-2 text-[#0f172a] text-sm font-bold">{entry.title}</div>
                          {entry.subtitle ? <div className="text-[#475569] mt-1 text-xs">{entry.subtitle}</div> : null}
                        </div>
                        <Link
                          to={entry.href}
                          className="text-[#1d4ed8] hover:text-[#1e40af] whitespace-nowrap text-xs font-bold"
                        >
                          Ouvrir
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ) : null}

          {isPurchasesView ? (
            <DisclosureCard
              title="Workflow achats"
              description="Garde ici la vue d'ensemble du flux interne : revue, attente fournisseur et bon à payer."
              badge={<StatusPill color="info" label="Vue interne" />}
            >
              <div className="flex justify-end">
                <Link to="/app/automations" className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-bold">
                  Automatisations
                </Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                  <div
                    className="text-[#94a3b8]"
                    style={{
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    En revue
                  </div>
                  <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                    {reviewingCount}
                  </div>
                  <div className="text-[#64748b] mt-1 text-xs">Contrôle interne</div>
                </div>
                <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                  <div
                    className="text-[#94a3b8]"
                    style={{
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Bon à payer
                  </div>
                  <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                    {readyToPayCount}
                  </div>
                  <div className="text-[#64748b] mt-1 text-xs">Prêts pour finance</div>
                </div>
                <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                  <div
                    className="text-[#94a3b8]"
                    style={{
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Attente fournisseur
                  </div>
                  <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                    {Number(purchaseWorkflow?.states?.awaiting_supplier || 0)}
                  </div>
                  <div className="text-[#64748b] mt-1 text-xs">Retour attendu</div>
                </div>
                <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                  <div
                    className="text-[#94a3b8]"
                    style={{
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Approuvés
                  </div>
                  <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                    {Number(purchaseWorkflow?.states?.approved || 0)}
                  </div>
                  <div className="text-[#64748b] mt-1 text-xs">Validation finie</div>
                </div>
              </div>
            </DisclosureCard>
          ) : null}

          <DisclosureCard
            title="Top fournisseurs"
            description="La lecture portefeuille fournisseurs reste disponible, mais elle n'occupe plus tout l'écran par défaut."
            badge={<StatusPill color="muted" label={`${topSuppliers.length} fournisseur(s)`} />}
            defaultOpen={false}
          >
            {topSuppliers.length === 0 ? (
              <p className="text-[#94a3b8] text-sm">
                Les principaux fournisseurs apparaîtront dès que vous aurez des réceptions ou imports consolidés.
              </p>
            ) : (
              <div className="space-y-3">
                {topSuppliers.map((supplier: any, index: number) => (
                  <div
                    key={`${supplier.legal_id || supplier.supplier_name || index}`}
                    className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[#0f172a] text-sm font-semibold">
                          {supplier.supplier_name || "Fournisseur"}
                        </div>
                        <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                          {supplier.legal_id || "Identifiant non renseigné"}
                        </div>
                      </div>
                      <StatusPill color="info" label={`${Number(supplier.invoice_count || 0)} facture(s)`} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-[#475569] text-xs">
                      <div>
                        <div className="text-[#94a3b8]">Total TTC</div>
                        <div className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                          {money(supplier.total_ttc || 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[#94a3b8]">Dernière réception</div>
                        <div className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                          {formatDateFr(supplier.last_received_at, "—")}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DisclosureCard>
        </div>
      </div>
    </>
  );
}

function InboxDetailView({ invoiceId }: { invoiceId: string }) {
  const location = useLocation();
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [item, setItem] = useState<any>(null);
  const [workflow, setWorkflow] = useState<any>(null);
  const [workflowDraft, setWorkflowDraft] = useState<any>({ state: "reviewing", owner_role: "accountant", note: "" });
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, workflowData] = await Promise.all([
        readJson(`/api/inbox/${invoiceId}`),
        isPurchasesView ? readJson(`/api/ops/purchase-workflow/${invoiceId}`) : Promise.resolve(null),
      ]);
      setItem(data || null);
      setWorkflow(workflowData || null);
      if (workflowData) {
        setWorkflowDraft({
          state: workflowData.state || "reviewing",
          owner_role: workflowData.owner_role || "accountant",
          note: workflowData.note || "",
        });
      }
    } catch (err) {
      setItem(null);
      setWorkflow(null);
      setError(formatApiError(err, "Impossible de charger la facture reçue."));
    } finally {
      setLoading(false);
    }
  }, [invoiceId, isPurchasesView]);

  useEffect(() => {
    void load();
  }, [load]);

  const canReply =
    !!item?.external_message_id &&
    !!item?.provider_slug &&
    !["manual_import", "dummy", "mock"].includes((item?.provider_slug || "").toLowerCase());
  const guidance = purchaseOpsGuidance(item, workflow);

  const saveWorkflow = async () => {
    if (!item || !isPurchasesView) return;
    setWorkflowBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data: any = await api(`/api/ops/purchase-workflow/${item.id}`, {
        method: "POST",
        body: JSON.stringify(workflowDraft),
      }).then((res: any) => res);
      setWorkflow(data || null);
      setWorkflowDraft({
        state: data?.state || workflowDraft.state || "reviewing",
        owner_role: data?.owner_role || workflowDraft.owner_role || "accountant",
        note: data?.note || workflowDraft.note || "",
      });
      setNotice("Workflow achat mis à jour.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour le workflow achat."));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const runAction = async (action: "accept" | "reject" | "request_correction") => {
    if (!item) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/inbox/${item.id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice(`Action ${titleCase(action)} envoyée.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Cette action n'a pas pu être réalisée. Vérifiez les informations puis réessayez."));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <>
      {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
      {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

      {loading ? (
        <LoadingCard label="Chargement du détail…" />
      ) : !item ? (
        <SectionEmpty
          title="Facture introuvable"
          description="Le document demandé n’existe pas ou n’est plus accessible sur cet espace."
          href={basePath}
          cta={isPurchasesView ? "Retour aux achats" : "Retour à l’inbox"}
        />
      ) : (
        <div className="space-y-6">
          <div className={`grid grid-cols-2 ${isPurchasesView ? "lg:grid-cols-5" : "lg:grid-cols-4"} gap-4`}>
            <StatCard
              label="Statut"
              value={inboxStatusPill(item.status).label}
              sub={prettyProvider(item.provider_slug)}
              accent={
                inboxStatusPill(item.status).color === "ok"
                  ? "green"
                  : inboxStatusPill(item.status).color === "danger"
                    ? "red"
                    : "amber"
              }
              icon={<Inbox className="w-4 h-4" />}
            />
            <StatCard
              label="Validation"
              value={validationPill(item.validation_status).label}
              sub={item.facturx_profile ? `Profil ${item.facturx_profile}` : "Profil non détecté"}
              accent={
                validationPill(item.validation_status).color === "ok"
                  ? "green"
                  : validationPill(item.validation_status).color === "danger"
                    ? "red"
                    : "amber"
              }
              icon={<CheckCircle className="w-4 h-4" />}
            />
            <StatCard
              label="Total TTC"
              value={money(item.total_ttc, item.currency || "EUR")}
              sub={`Émise le ${formatDateFr(item.issue_date)}`}
              accent="blue"
              icon={<FileText className="w-4 h-4" />}
            />
            <StatCard
              label="Réception"
              value={formatDateTimeFr(item.received_at)}
              sub={item.invoice_number || item.id}
              accent="purple"
              icon={<Mail className="w-4 h-4" />}
            />
            {isPurchasesView ? (
              <StatCard
                label="Workflow"
                value={purchaseWorkflowPill(workflow).label}
                sub={workflow?.owner_role ? `Pilote ${titleCase(workflow.owner_role)}` : "Aucun pilote"}
                accent={
                  purchaseWorkflowPill(workflow).color === "ok"
                    ? "green"
                    : purchaseWorkflowPill(workflow).color === "danger"
                      ? "red"
                      : purchaseWorkflowPill(workflow).color === "warn"
                        ? "amber"
                        : purchaseWorkflowPill(workflow).color === "purple"
                          ? "purple"
                          : "cyan"
                }
                icon={<Check className="w-4 h-4" />}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {canReply ? (
              <>
                <PrimaryButton disabled={busyAction === "accept"} onClick={() => void runAction("accept")}>
                  {busyAction === "accept" ? "Envoi…" : "Accepter"}
                </PrimaryButton>
                <DangerButton disabled={busyAction === "reject"} onClick={() => void runAction("reject")}>
                  {busyAction === "reject" ? "Envoi…" : "Rejeter"}
                </DangerButton>
                <SecondaryButton
                  disabled={busyAction === "request_correction"}
                  onClick={() => void runAction("request_correction")}
                >
                  {busyAction === "request_correction" ? "Envoi…" : "Demander correction"}
                </SecondaryButton>
              </>
            ) : null}
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>

          <div className="grid xl:grid-cols-[1.1fr_1fr] gap-6 items-start">
            <Card>
              <SectionTitle>{isPurchasesView ? "Achat fournisseur" : "Document reçu"}</SectionTitle>
              <div className="grid md:grid-cols-2 gap-4 text-[#374151] text-sm">
                <div>
                  <span className="text-[#94a3b8]">Fournisseur</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {item.supplier_name || "—"}
                  </div>
                </div>
                <div>
                  <span className="text-[#94a3b8]">SIREN / SIRET</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {item.supplier_siren || "—"}
                    {item.supplier_siret ? ` / ${item.supplier_siret}` : ""}
                  </div>
                </div>
                <div>
                  <span className="text-[#94a3b8]">Numéro facture</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {item.invoice_number || "—"}
                  </div>
                </div>
                <div>
                  <span className="text-[#94a3b8]">Format</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {titleCase(item.format || "—")}
                  </div>
                </div>
                <div>
                  <span className="text-[#94a3b8]">Montant HT</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {money(item.total_ex_vat, item.currency || "EUR")}
                  </div>
                </div>
                <div>
                  <span className="text-[#94a3b8]">Montant TVA</span>
                  <div className="mt-1 text-[#0f172a]" style={{ fontWeight: 600 }}>
                    {money(item.total_vat, item.currency || "EUR")}
                  </div>
                </div>
              </div>

              {item.validation_errors?.length || item.validation_warnings?.length ? (
                <div className="mt-5 space-y-3">
                  {item.validation_errors?.length ? (
                    <div className="p-4 rounded-xl bg-[#fef2f2] border border-[#fecaca]">
                      <div className="text-[#991b1b] text-sm font-bold">Erreurs de validation</div>
                      <ul className="mt-2 list-disc list-inside text-[#b91c1c] text-xs">
                        {item.validation_errors.map((entry: any, index: number) => (
                          <li key={index}>{typeof entry === "string" ? entry : JSON.stringify(entry)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {item.validation_warnings?.length ? (
                    <div className="p-4 rounded-xl bg-[#fffbeb] border border-[#fde68a]">
                      <div className="text-[#92400e] text-sm font-bold">Avertissements</div>
                      <ul className="mt-2 list-disc list-inside text-[#b45309] text-xs">
                        {item.validation_warnings.map((entry: any, index: number) => (
                          <li key={index}>{typeof entry === "string" ? entry : JSON.stringify(entry)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <div className="space-y-6">
              {isPurchasesView ? (
                <Card>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <SectionTitle>Workflow interne</SectionTitle>
                      <p className="text-[#64748b] -mt-2 text-xs">
                        Clarifie le passage revue → attente fournisseur → approuvé → bon à payer.
                      </p>
                    </div>
                    <StatusPill {...purchaseWorkflowPill(workflow)} />
                  </div>
                  <div className="mt-4 grid md:grid-cols-2 gap-3">
                    <SelectField
                      label="Étape"
                      value={workflowDraft.state}
                      onChange={(event) => setWorkflowDraft((prev: any) => ({ ...prev, state: event.target.value }))}
                    >
                      <option value="new">Nouveau</option>
                      <option value="reviewing">En revue</option>
                      <option value="awaiting_supplier">En attente fournisseur</option>
                      <option value="approved">Approuvé</option>
                      <option value="ready_to_pay">Bon à payer</option>
                      <option value="booked">Comptabilisé</option>
                    </SelectField>
                    <SelectField
                      label="Pilote"
                      value={workflowDraft.owner_role || "accountant"}
                      onChange={(event) =>
                        setWorkflowDraft((prev: any) => ({ ...prev, owner_role: event.target.value }))
                      }
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="accountant">Compta</option>
                      <option value="viewer">Viewer</option>
                    </SelectField>
                  </div>
                  <div className="mt-4">
                    <label className="block text-[#374151] mb-1.5 text-sm font-medium">Note opérateur</label>
                    <textarea
                      value={workflowDraft.note || ""}
                      onChange={(event) => setWorkflowDraft((prev: any) => ({ ...prev, note: event.target.value }))}
                      placeholder="Pourquoi ce document est-il gelé, approuvé ou prêt pour la trésorerie ?"
                      className="w-full min-h-[104px] px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm"
                    />
                  </div>
                  <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4 mt-4">
                    <div className="text-[#0f172a] text-sm font-bold">
                      {workflow?.next_step_title || "Étape suivante"}
                    </div>
                    <p className="text-[#64748b] mt-1 text-xs leading-relaxed">
                      {workflow?.next_step_description || "Aucune indication pour le moment."}
                    </p>
                    {workflow?.updated_at ? (
                      <div className="text-[#94a3b8] mt-2" style={{ fontSize: "0.6875rem" }}>
                        Mis à jour le {formatDateTimeFr(workflow.updated_at)}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-end mt-4">
                    <PrimaryButton disabled={workflowBusy} onClick={() => void saveWorkflow()}>
                      {workflowBusy ? "Enregistrement…" : "Enregistrer le workflow"}
                    </PrimaryButton>
                  </div>
                </Card>
              ) : null}

              <Card>
                <SectionTitle>Prochaine action</SectionTitle>
                <div
                  className={`rounded-xl border p-4 ${guidance.tone === "danger" ? "border-[#fecaca] bg-[#fef2f2]" : guidance.tone === "warn" ? "border-[#fde68a] bg-[#fffbeb]" : guidance.tone === "ok" ? "border-[#bbf7d0] bg-[#f0fdf4]" : "border-[#bfdbfe] bg-[#eff6ff]"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill color={guidance.tone as any} label={guidance.title} />
                    <StatusPill color={inboxStatusPill(item.status).color} label={inboxStatusPill(item.status).label} />
                    <StatusPill
                      color={validationPill(item.validation_status).color}
                      label={validationPill(item.validation_status).label}
                    />
                  </div>
                  <p className="text-[#475569] mt-3" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                    {guidance.description}
                  </p>
                  <ul className="mt-3 space-y-2 text-[#475569]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                    {guidance.bullets.map((bullet: string) => (
                      <li key={bullet} className="flex items-start gap-2">
                        <span className="mt-1 inline-block w-1.5 h-1.5 rounded-full bg-[#94a3b8]" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>

              <Card>
                <SectionTitle>Pièces jointes</SectionTitle>
                {(item.attachments || []).length === 0 ? (
                  <p className="text-[#94a3b8] text-sm">Aucune pièce jointe disponible.</p>
                ) : (
                  <div className="space-y-3">
                    {(item.attachments || []).map((attachment: any) => (
                      <div
                        key={attachment.id}
                        className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]"
                      >
                        <div>
                          <div className="text-[#0f172a] text-sm font-semibold">
                            {titleCase(attachment.kind || "document")}
                          </div>
                          <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                            {attachment.sha256?.slice(0, 16) || ""}
                          </div>
                        </div>
                        <SecondaryButton
                          onClick={() =>
                            void downloadProtectedFile(
                              `/api/inbox/${item.id}/attachments/${attachment.id}`,
                              `${item.invoice_number || item.id}.${attachment.kind || "bin"}`,
                              attachment.kind === "pdf",
                            )
                          }
                        >
                          <Download className="w-3.5 h-3.5" /> Télécharger
                        </SecondaryButton>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <SectionTitle>Historique</SectionTitle>
                {(item.events || []).length === 0 ? (
                  <p className="text-[#94a3b8] text-sm">Aucun événement pour le moment.</p>
                ) : (
                  <div className="space-y-3">
                    {(item.events || []).map((event: any) => (
                      <div key={event.id} className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[#0f172a] text-sm font-semibold">
                            {titleCase(event.type || "événement")}
                          </div>
                          <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                            {formatDateTimeFr(event.created_at)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function InboxPage() {
  const invoiceId = useRouteId();
  const location = useLocation();
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";

  return (
    <div>
      <AppPageHeader
        title={
          invoiceId
            ? isPurchasesView
              ? "Achat fournisseur"
              : "Détail facture reçue"
            : isPurchasesView
              ? "Achats & fournisseurs"
              : "Réception e-factures"
        }
        breadcrumb={isPurchasesView ? "Achats" : "E-facturation"}
        description={
          invoiceId
            ? "Analyse détaillée d’une facture fournisseur reçue, avec validation, pièces jointes et historique métier."
            : isPurchasesView
              ? "Vue achats fournisseurs homogène : réception, validation, top fournisseurs et import manuel pour les démos ou premiers flux."
              : "Réception fournisseur : import manuel, réception connectée et suivi de validation."
        }
        backHref={invoiceId ? basePath : undefined}
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {invoiceId ? <InboxDetailView invoiceId={invoiceId} /> : <InboxListView />}
      </div>
    </div>
  );
}

export function EReportingPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [reportType, setReportType] = useState("transaction");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [reportsRes, eventsRes] = await Promise.allSettled([
        readJson("/api/e-reporting/reports?page=1&page_size=50"),
        readJson("/api/e-reporting?page=1&page_size=20"),
      ]);
      const messages: string[] = [];
      if (reportsRes.status === "fulfilled")
        setReports(Array.isArray(reportsRes.value?.items) ? reportsRes.value.items : []);
      else {
        setReports([]);
        messages.push(formatApiError(reportsRes.reason, "Rapports indisponibles."));
      }
      if (eventsRes.status === "fulfilled")
        setEvents(Array.isArray(eventsRes.value?.items) ? eventsRes.value.items : []);
      else setEvents([]);
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const monthBounds = (value: string) => {
    const [yearRaw, monthRaw] = (value || "").split("-");
    const year = Number(yearRaw);
    const monthIndex = Number(monthRaw);
    if (!year || !monthIndex) return null;
    const start = new Date(Date.UTC(year, monthIndex - 1, 1));
    const end = new Date(Date.UTC(year, monthIndex, 0));
    return {
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    };
  };

  const generate = async () => {
    const bounds = monthBounds(month);
    if (!bounds) return;
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      await api("/api/e-reporting/reports/generate", {
        method: "POST",
        body: JSON.stringify({ ...bounds, report_type: reportType }),
      });
      setNotice("Génération lancée. Son avancement reste visible dans l’historique.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Génération impossible."));
    } finally {
      setBusy(null);
    }
  };

  const sendReport = async (reportId: string) => {
    setBusy(reportId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/e-reporting/reports/${reportId}/send`, { method: "POST" });
      setNotice("Envoi lancé. Son avancement reste visible dans l’historique.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Envoi impossible."));
    } finally {
      setBusy(null);
    }
  };

  const sentCount = reports.filter((report) =>
    ["sent", "completed"].includes((report.status || "").toLowerCase()),
  ).length;
  const failedCount = reports.filter((report) =>
    ["failed", "error"].includes((report.status || "").toLowerCase()),
  ).length;
  const pendingCount = reports.length - sentCount - failedCount;
  const bounds = monthBounds(month);

  return (
    <div>
      <AppPageHeader
        title="E-reporting"
        breadcrumb="E-facturation"
        description="Rapports et événements visibles dans l'app pour rendre le suivi plus compréhensible."
        actions={
          <SecondaryButton onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Rapports"
            value={reports.length}
            sub="Périodes générées"
            accent="blue"
            icon={<FileText className="w-4 h-4" />}
          />
          <StatCard
            label="Envoyés"
            value={sentCount}
            sub="Succès"
            accent="green"
            icon={<CheckCircle className="w-4 h-4" />}
          />
          <StatCard
            label="En attente"
            value={pendingCount}
            sub="À traiter"
            accent="amber"
            icon={<RefreshCw className="w-4 h-4" />}
          />
          <StatCard
            label="Événements"
            value={events.length}
            sub="Historique récent"
            accent="purple"
            icon={<Mail className="w-4 h-4" />}
          />
        </div>

        <Card>
          <SectionTitle>Générer un rapport</SectionTitle>
          <div className="grid md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-[#374151] mb-1.5 text-sm font-medium">Mois</label>
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] text-sm"
              />
            </div>
            <SelectField label="Type" value={reportType} onChange={(event) => setReportType(event.target.value)}>
              <option value="transaction">Transactions</option>
              <option value="payment">Paiements</option>
            </SelectField>
            <div className="flex gap-2">
              <PrimaryButton disabled={busy === "generate"} onClick={() => void generate()}>
                {busy === "generate" ? "Génération…" : "Générer"}
              </PrimaryButton>
              {bounds ? (
                <SecondaryButton
                  onClick={() =>
                    void downloadProtectedFile(
                      `/api/e-reporting/export?format=json&period_start=${bounds.period_start}&period_end=${bounds.period_end}`,
                      `ereporting-${month}.json`,
                    )
                  }
                >
                  <FileDown className="w-3.5 h-3.5" /> Exporter la période
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        </Card>

        {loading ? (
          <LoadingCard label="Chargement des rapports e-reporting…" />
        ) : (
          <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
            <Card>
              <SectionTitle>Rapports générés</SectionTitle>
              {reports.length === 0 ? (
                <SectionEmpty
                  title="Aucun rapport"
                  description="Génère une première période pour matérialiser la fonctionnalité et faciliter la démonstration client."
                />
              ) : (
                <DataTable headers={["Type", "Période", "Statut", "Lignes", "Dernière tentative", "Action"]}>
                  {reports.map((report) => (
                    <tr key={report.id} className="hover:bg-[#f8fafc] transition-colors">
                      <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                        {titleCase(report.report_type)}
                      </td>
                      <td className="px-4 py-3 text-[#374151] text-sm">
                        {formatDateFr(report.period_start)} → {formatDateFr(report.period_end)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill {...ereportingPill(report.status)} />
                      </td>
                      <td className="px-4 py-3 text-[#374151] text-sm">{report.line_count ?? "—"}</td>
                      <td className="px-4 py-3 text-[#64748b] text-xs">
                        {formatDateTimeFr(report.last_attempt_at || report.updated_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <SecondaryButton
                            className="!px-3 !py-1.5"
                            onClick={() =>
                              void downloadProtectedFile(
                                `/api/e-reporting/reports/${report.id}/export`,
                                `${report.report_type}-${report.id}.json`,
                              )
                            }
                          >
                            <Download className="w-3.5 h-3.5" /> Exporter le rapport
                          </SecondaryButton>
                          <PrimaryButton
                            className="!px-3 !py-1.5"
                            disabled={busy === report.id}
                            onClick={() => void sendReport(report.id)}
                          >
                            <Send className="w-3.5 h-3.5" /> {busy === report.id ? "Envoi…" : "Envoyer"}
                          </PrimaryButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Card>

            <Card>
              <SectionTitle>Événements récents</SectionTitle>
              {events.length === 0 ? (
                <p className="text-[#94a3b8] text-sm">Aucun événement e-reporting enregistré.</p>
              ) : (
                <div className="space-y-3">
                  {events.map((event) => (
                    <div key={event.id} className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[#0f172a] text-sm font-semibold">{titleCase(event.type)}</div>
                          <div className="text-[#64748b] mt-0.5 text-xs">
                            {event.amounts?.total_ttc ? money(event.amounts.total_ttc) : "Montant non renseigné"}
                          </div>
                        </div>
                        <StatusPill {...ereportingPill(event.status)} />
                      </div>
                      <div className="text-[#94a3b8] mt-2" style={{ fontSize: "0.6875rem" }}>
                        {formatDateTimeFr(event.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConformiteAppPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, readinessRes] = await Promise.allSettled([
        readJson("/api/settings"),
        readJson("/api/readiness"),
      ]);
      const messages: string[] = [];
      if (settingsRes.status === "fulfilled") setSettings(settingsRes.value || null);
      else messages.push(formatApiError(settingsRes.reason, "Versions de conformité indisponibles."));
      if (readinessRes.status === "fulfilled") setReadiness(readinessRes.value || null);
      else messages.push(formatApiError(readinessRes.reason, "Checklist de readiness indisponible."));
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const items = readiness?.items || [];
  const blockingCount = items.filter((item: any) => item.status === "missing" && item.severity === "p0").length;
  const warningCount = items.filter(
    (item: any) => item.status === "warning" || (item.status === "missing" && item.severity !== "p0"),
  ).length;
  const status = compliancePill(readiness?.status);

  return (
    <div>
      <AppPageHeader
        title="Conformité & readiness"
        breadcrumb="Conformité"
        description="Versionnée, lisible et actionnable : cette page indique les points prêts et les éléments à finaliser avant exploitation."
        actions={
          <SecondaryButton onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Statut global"
            value={status.label}
            sub={readiness?.next_action || "Aucune action prioritaire"}
            accent={status.color === "ok" ? "green" : status.color === "danger" ? "red" : "amber"}
            icon={<Shield className="w-4 h-4" />}
          />
          <StatCard
            label="Bloquants"
            value={blockingCount}
            sub="Priorité haute"
            accent={blockingCount ? "red" : "green"}
            icon={<AlertCircle className="w-4 h-4" />}
          />
          <StatCard
            label="À surveiller"
            value={warningCount}
            sub="Priorité secondaire"
            accent={warningCount ? "amber" : "green"}
            icon={<CheckCircle className="w-4 h-4" />}
          />
          <StatCard
            label="Profil Factur-X"
            value={titleCase(settings?.facturx_profile || "—")}
            sub={`Spec ${settings?.facturx_spec_version || "—"}`}
            accent="purple"
            icon={<FileText className="w-4 h-4" />}
          />
        </div>

        {loading ? (
          <LoadingCard label="Chargement de la conformité…" />
        ) : (
          <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
            <Card>
              <SectionTitle>Checklist détaillée</SectionTitle>
              {items.length === 0 ? (
                <p className="text-[#94a3b8] text-sm">Aucune checklist disponible.</p>
              ) : (
                <DataTable headers={["Contrôle", "Statut", "Sévérité", "Champs manquants", "Action conseillée"]}>
                  {items.map((item: any) => (
                    <tr key={item.key} className="hover:bg-[#f8fafc] transition-colors">
                      <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                        {item.label || titleCase(item.key)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill {...readinessCheckPill(item.status)} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill
                          status={item.severity === "p0" ? "danger" : "warn"}
                          label={item.severity === "p0" ? "P0" : titleCase(item.severity || "P1")}
                        />
                      </td>
                      <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 260 }}>
                        {item.missing_fields?.length ? item.missing_fields.join(", ") : "—"}
                      </td>
                      <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 280 }}>
                        {item.next_action || "—"}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Card>

            <div className="space-y-6">
              <Card>
                <SectionTitle>Moteurs & versions</SectionTitle>
                <div className="space-y-3 text-[#374151] text-sm">
                  <div className="flex justify-between gap-3">
                    <span>Factur-X spec</span>
                    <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                      {settings?.facturx_spec_version || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Factur-X lib</span>
                    <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                      {settings?.facturx_lib_version || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Saxon/CII</span>
                    <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                      {settings?.saxonche_version || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Validateur UBL</span>
                    <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                      {settings?.ubl_validator_available
                        ? `Oui${settings?.ubl_validator_version ? ` (${settings.ubl_validator_version})` : ""}`
                        : "Non"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>PDF/A</span>
                    <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                      {settings?.pdfa_convert_enabled ? "Activé" : "Désactivé"}
                    </span>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionTitle>Actions utiles</SectionTitle>
                <div className="flex flex-col gap-3">
                  <ActionLink to="/app/einvoicing">Ouvrir la checklist</ActionLink>
                  <ActionLink
                    to="/app/settings/export"
                    className="!bg-[linear-gradient(135deg,#059669_0%,#0d9488_100%)]"
                  >
                    Dossier comptable
                  </ActionLink>
                  <ActionLink to="/app/invoices" className="!bg-[linear-gradient(135deg,#7c3aed_0%,#6366f1_100%)]">
                    Tester sur une facture
                  </ActionLink>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
