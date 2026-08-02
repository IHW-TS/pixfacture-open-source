"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi } from "@/lib/api";
import { formatDateTimeFr } from "@/lib/dateFormat";
import {
  AppPageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { OpsEmptyState, OpsMiniStat, OpsPanelShell, OpsSearchField } from "../../components/app/OpsTabbedBoard";
import {
  ArrowRight,
  Bot,
  CreditCard,
  Inbox,
  PauseCircle,
  PlayCircle,
  Receipt,
  RefreshCw,
  RotateCw,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";

type AutomationPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";
type AutomationAccent = "blue" | "green" | "amber" | "red" | "purple" | "slate";
type AutomationTab = "library" | "playbooks" | "suggestions" | "workflow";
type LibraryFilter = "all" | "available" | "deployed";
type PlaybookFilter = "all" | "active" | "paused";
type SuggestionFilter = "all" | "priority" | "purchases" | "payments";
type WorkflowFilter = "all" | "reviewing" | "ready_to_pay" | "blocked";

const MODULE_ICONS: Record<string, any> = {
  collections: Receipt,
  payments: CreditCard,
  purchases: Inbox,
  recurring: RotateCw,
  setup: Settings,
};

const workflowStateCards: Array<{ key: string; label: string; accent: AutomationAccent }> = [
  { key: "new", label: "Nouveaux", accent: "blue" },
  { key: "reviewing", label: "En revue", accent: "amber" },
  { key: "awaiting_supplier", label: "En attente", accent: "red" },
  { key: "approved", label: "Approuvés", accent: "green" },
  { key: "ready_to_pay", label: "Bons à payer", accent: "purple" },
  { key: "booked", label: "Comptabilisés", accent: "blue" },
];

const headerLinkClass =
  "inline-flex items-center gap-1.5 rounded-xl border border-[#d7e3ef] bg-white px-3 py-2 text-[#475569] transition-colors hover:border-[#bfdbfe] hover:text-[#1d4ed8]";

const roleLabel = (value: string | null | undefined) => {
  const normalized = String(value || "accountant").toLowerCase();
  if (normalized === "owner") return "Owner";
  if (normalized === "admin") return "Admin";
  if (normalized === "viewer") return "Viewer";
  return "Compta";
};

const cadenceLabel = (value: string | null | undefined) => {
  const normalized = String(value || "daily").toLowerCase();
  if (normalized === "weekly") return "Hebdo";
  if (normalized === "monthly") return "Mensuel";
  if (normalized === "manual") return "Manuel";
  return "Quotidien";
};

const triggerLabel = (value: string | null | undefined) => {
  const normalized = String(value || "manual_review").toLowerCase();
  if (normalized === "manual_review") return "Revue";
  if (normalized === "action_center") return "Action";
  if (normalized === "portfolio_signal") return "Signal";
  if (normalized === "scheduler") return "Planification";
  return normalized.replaceAll("_", " ");
};

const modulePill = (
  module: string | null | undefined,
  moduleLabel?: string | null,
): { color: AutomationPillTone; label: string } => {
  const normalized = String(module || "setup").toLowerCase();
  const label = moduleLabel || normalized;
  if (normalized === "collections") return { color: "warn", label };
  if (normalized === "payments") return { color: "info", label };
  if (normalized === "purchases") return { color: "purple", label };
  if (normalized === "recurring") return { color: "ok", label };
  return { color: "muted", label };
};

const severityPill = (severity: string | null | undefined): { color: AutomationPillTone; label: string } => {
  const normalized = String(severity || "medium").toLowerCase();
  if (normalized === "critical") return { color: "danger", label: "Critique" };
  if (normalized === "high") return { color: "warn", label: "Prioritaire" };
  if (normalized === "low") return { color: "muted", label: "Suivi" };
  return { color: "info", label: "À traiter" };
};

const workflowTonePill = (tone: string | null | undefined): { color: AutomationPillTone; label: string } => {
  const normalized = String(tone || "info").toLowerCase();
  if (normalized === "danger") return { color: "danger", label: "Bloqué" };
  if (normalized === "warn") return { color: "warn", label: "En revue" };
  if (normalized === "ok") return { color: "ok", label: "Stable" };
  if (normalized === "purple") return { color: "purple", label: "À payer" };
  return { color: "info", label: "Suivi" };
};

function AutoTag({ color, label }: { color: string; label: string }) {
  const cfg: Record<string, { bg: string; text: string; dot: string }> = {
    green: { bg: "#f0fdf4", text: "#15803d", dot: "#22c55e" },
    blue: { bg: "#eff6ff", text: "#1d4ed8", dot: "#3b82f6" },
    amber: { bg: "#fffbeb", text: "#b45309", dot: "#f59e0b" },
    purple: { bg: "#faf5ff", text: "#7c3aed", dot: "#a78bfa" },
    red: { bg: "#fef2f2", text: "#dc2626", dot: "#ef4444" },
    muted: { bg: "#f8fafc", text: "#64748b", dot: "#cbd5e1" },
  };
  const tone = cfg[color] || cfg.muted;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
      style={{
        fontSize: "0.6875rem",
        fontWeight: 600,
        background: tone.bg,
        color: tone.text,
        border: `1px solid ${tone.dot}33`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
      {label}
    </span>
  );
}

export function AutomationsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeTab, setActiveTab] = useState<AutomationTab>("library");
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [playbookSearch, setPlaybookSearch] = useState("");
  const [playbookFilter, setPlaybookFilter] = useState<PlaybookFilter>("all");
  const [suggestionFilter, setSuggestionFilter] = useState<SuggestionFilter>("all");
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowFilter>("all");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/ops/workbench");
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw payload || new Error("Automatisation indisponible.");
      setData(payload || null);
    } catch (err) {
      setData(null);
      setError(formatApiError(err, "Impossible de charger les automatisations."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshNonce]);

  const templates = useMemo(() => (Array.isArray(data?.templates) ? data.templates : []), [data?.templates]);
  const playbooks = useMemo(() => (Array.isArray(data?.playbooks) ? data.playbooks : []), [data?.playbooks]);
  const suggestions = useMemo(() => (Array.isArray(data?.suggestions) ? data.suggestions : []), [data?.suggestions]);
  const summary = data?.summary || {};
  const workflowSummary = data?.purchase_workflow || { states: {}, items_by_invoice: {} };
  const workflowItems = useMemo(
    () => Object.values(workflowSummary?.items_by_invoice || {}) as Array<any>,
    [workflowSummary?.items_by_invoice],
  );

  const templateState = useMemo(() => {
    const map = new Map<string, any>();
    for (const playbook of playbooks) {
      if (playbook?.template_key) map.set(String(playbook.template_key), playbook);
    }
    return map;
  }, [playbooks]);

  const activePlaybooks = Number(summary.active_playbooks || 0);
  const coveredModules = Number(summary.covered_modules || 0);
  const recommendedCount = Number(summary.recommended_count || 0);
  const purchasesInReview = Number(summary.purchases_in_review || 0);
  const readyToPayCount = Number(summary.ready_to_pay_count || 0);
  const availableTemplateCount = templates.filter((item: any) => !templateState.has(String(item.key))).length;
  const deployedTemplateCount = templates.length - availableTemplateCount;
  const pausedPlaybookCount = playbooks.filter((item: any) => !item.active).length;
  const criticalSuggestionCount = suggestions.filter((item: any) => {
    const severity = String(item?.severity || "").toLowerCase();
    return severity === "critical" || severity === "high";
  }).length;

  const filteredTemplates = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return templates.filter((item: any) => {
      const existing = templateState.get(String(item.key));
      if (libraryFilter === "available" && existing) return false;
      if (libraryFilter === "deployed" && !existing) return false;
      if (!query) return true;
      return [item.name, item.module_label, item.description, item.trigger_type]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [libraryFilter, librarySearch, templateState, templates]);

  const filteredPlaybooks = useMemo(() => {
    const query = playbookSearch.trim().toLowerCase();
    return playbooks.filter((item: any) => {
      if (playbookFilter === "active" && !item.active) return false;
      if (playbookFilter === "paused" && item.active) return false;
      if (!query) return true;
      return [item.name, item.module_label, item.description, item.trigger_type]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [playbookFilter, playbookSearch, playbooks]);

  const filteredSuggestions = useMemo(() => {
    return suggestions.filter((item: any) => {
      if (suggestionFilter === "priority") {
        const severity = String(item?.severity || "").toLowerCase();
        return severity === "critical" || severity === "high";
      }
      if (suggestionFilter === "purchases") return String(item?.module || "") === "purchases";
      if (suggestionFilter === "payments") return String(item?.module || "") === "payments";
      return true;
    });
  }, [suggestionFilter, suggestions]);

  const workflowReviewCount = useMemo(
    () =>
      workflowItems.filter((item: any) => {
        const state = String(item?.state || "").toLowerCase();
        return state === "new" || state === "reviewing";
      }).length,
    [workflowItems],
  );

  const workflowReadyCount = useMemo(
    () => workflowItems.filter((item: any) => String(item?.state || "").toLowerCase() === "ready_to_pay").length,
    [workflowItems],
  );

  const workflowBlockedCount = useMemo(
    () =>
      workflowItems.filter((item: any) => {
        const state = String(item?.state || "").toLowerCase();
        const tone = String(item?.tone || "").toLowerCase();
        return tone === "danger" || state === "awaiting_supplier";
      }).length,
    [workflowItems],
  );

  const filteredWorkflowItems = useMemo(() => {
    return workflowItems.filter((item: any) => {
      const state = String(item?.state || "").toLowerCase();
      const tone = String(item?.tone || "").toLowerCase();
      if (workflowFilter === "reviewing") return state === "new" || state === "reviewing";
      if (workflowFilter === "ready_to_pay") return state === "ready_to_pay";
      if (workflowFilter === "blocked") return tone === "danger" || state === "awaiting_supplier";
      return true;
    });
  }, [workflowFilter, workflowItems]);

  const libraryFilterLabel =
    libraryFilter === "available" ? "A activer" : libraryFilter === "deployed" ? "Deployees" : undefined;
  const playbookFilterLabel =
    playbookFilter === "active" ? "Actifs" : playbookFilter === "paused" ? "Suspendus" : undefined;
  const suggestionFilterLabel =
    suggestionFilter === "priority"
      ? "Prioritaires"
      : suggestionFilter === "purchases"
        ? "Achats"
        : suggestionFilter === "payments"
          ? "Paiements"
          : undefined;
  const workflowFilterLabel =
    workflowFilter === "reviewing"
      ? "En revue"
      : workflowFilter === "ready_to_pay"
        ? "Bons à payer"
        : workflowFilter === "blocked"
          ? "Bloqués"
          : undefined;

  const tabs: Array<{
    id: AutomationTab;
    label: string;
    badge?: number;
    activeHint?: string;
    submenuItems?: Array<{ label: string; badge?: number; active?: boolean; onSelect: () => void }>;
  }> = [
    {
      id: "library",
      label: "Bibliotheque",
      badge: templates.length,
      activeHint: activeTab === "library" ? libraryFilterLabel : undefined,
      submenuItems: [
        {
          label: "Toutes",
          badge: templates.length,
          active: libraryFilter === "all",
          onSelect: () => {
            setActiveTab("library");
            setLibraryFilter("all");
          },
        },
        {
          label: "A activer",
          badge: availableTemplateCount,
          active: libraryFilter === "available",
          onSelect: () => {
            setActiveTab("library");
            setLibraryFilter("available");
          },
        },
        {
          label: "Deployees",
          badge: deployedTemplateCount,
          active: libraryFilter === "deployed",
          onSelect: () => {
            setActiveTab("library");
            setLibraryFilter("deployed");
          },
        },
      ],
    },
    {
      id: "playbooks",
      label: "Playbooks",
      badge: playbooks.length,
      activeHint: activeTab === "playbooks" ? playbookFilterLabel : undefined,
      submenuItems: [
        {
          label: "Tous",
          badge: playbooks.length,
          active: playbookFilter === "all",
          onSelect: () => {
            setActiveTab("playbooks");
            setPlaybookFilter("all");
          },
        },
        {
          label: "Actifs",
          badge: activePlaybooks,
          active: playbookFilter === "active",
          onSelect: () => {
            setActiveTab("playbooks");
            setPlaybookFilter("active");
          },
        },
        {
          label: "Suspendus",
          badge: pausedPlaybookCount,
          active: playbookFilter === "paused",
          onSelect: () => {
            setActiveTab("playbooks");
            setPlaybookFilter("paused");
          },
        },
      ],
    },
    {
      id: "suggestions",
      label: "Suggestions",
      badge: suggestions.length,
      activeHint: activeTab === "suggestions" ? suggestionFilterLabel : undefined,
      submenuItems: [
        {
          label: "Toutes",
          badge: suggestions.length,
          active: suggestionFilter === "all",
          onSelect: () => {
            setActiveTab("suggestions");
            setSuggestionFilter("all");
          },
        },
        {
          label: "Prioritaires",
          badge: criticalSuggestionCount,
          active: suggestionFilter === "priority",
          onSelect: () => {
            setActiveTab("suggestions");
            setSuggestionFilter("priority");
          },
        },
        {
          label: "Achats",
          badge: suggestions.filter((item: any) => item.module === "purchases").length,
          active: suggestionFilter === "purchases",
          onSelect: () => {
            setActiveTab("suggestions");
            setSuggestionFilter("purchases");
          },
        },
        {
          label: "Paiements",
          badge: suggestions.filter((item: any) => item.module === "payments").length,
          active: suggestionFilter === "payments",
          onSelect: () => {
            setActiveTab("suggestions");
            setSuggestionFilter("payments");
          },
        },
      ],
    },
    {
      id: "workflow",
      label: "Workflow achats",
      badge: workflowItems.length,
      activeHint: activeTab === "workflow" ? workflowFilterLabel : undefined,
      submenuItems: [
        {
          label: "Tous",
          badge: workflowItems.length,
          active: workflowFilter === "all",
          onSelect: () => {
            setActiveTab("workflow");
            setWorkflowFilter("all");
          },
        },
        {
          label: "En revue",
          badge: workflowReviewCount,
          active: workflowFilter === "reviewing",
          onSelect: () => {
            setActiveTab("workflow");
            setWorkflowFilter("reviewing");
          },
        },
        {
          label: "Bons à payer",
          badge: workflowReadyCount,
          active: workflowFilter === "ready_to_pay",
          onSelect: () => {
            setActiveTab("workflow");
            setWorkflowFilter("ready_to_pay");
          },
        },
        {
          label: "Bloqués",
          badge: workflowBlockedCount,
          active: workflowFilter === "blocked",
          onSelect: () => {
            setActiveTab("workflow");
            setWorkflowFilter("blocked");
          },
        },
      ],
    },
  ];

  const panelHeaderActions =
    activeTab === "library" ? (
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
        <div className="text-right text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {filteredTemplates.length} visible(s)
        </div>
        <OpsSearchField
          value={librarySearch}
          onChange={(event) => setLibrarySearch(event.target.value)}
          placeholder="Rechercher un playbook ou un module..."
          className="w-full sm:w-[320px]"
        />
      </div>
    ) : activeTab === "playbooks" ? (
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
        <OpsSearchField
          value={playbookSearch}
          onChange={(event) => setPlaybookSearch(event.target.value)}
          placeholder="Rechercher un playbook..."
          className="w-full sm:w-[280px]"
        />
        <Link to="/app/scheduler" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
          <Bot className="h-3.5 w-3.5" /> Planification
        </Link>
      </div>
    ) : activeTab === "workflow" ? (
      <Link to="/app/purchases" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
        <Inbox className="h-3.5 w-3.5" /> Ouvrir achats
      </Link>
    ) : activeTab === "suggestions" ? (
      <Link to="/app/tasks" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
        <Sparkles className="h-3.5 w-3.5" /> Tâches
      </Link>
    ) : null;

  const createTemplate = async (template: any) => {
    if (!template) return;
    setBusyKey(`create:${template.key}`);
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/playbooks", {
        method: "POST",
        body: JSON.stringify({
          name: template.name,
          module: template.module,
          trigger_type: template.trigger_type,
          cadence: template.cadence,
          owner_role: template.owner_role,
          description: template.description,
          active: true,
          template_key: template.key,
        }),
      });
      setNotice(`Playbook “${template.name}” ajoute.`);
      setActiveTab("playbooks");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ajouter le playbook."));
    } finally {
      setBusyKey(null);
    }
  };

  const togglePlaybook = async (playbook: any) => {
    if (!playbook?.id) return;
    const nextActive = !playbook.active;
    setBusyKey(`toggle:${playbook.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/playbooks/${playbook.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: nextActive }),
      });
      setNotice(nextActive ? `Playbook “${playbook.name}” reactive.` : `Playbook “${playbook.name}” suspendu.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour le playbook."));
    } finally {
      setBusyKey(null);
    }
  };

  const deletePlaybook = async (playbook: any) => {
    if (!playbook?.id) return;
    setBusyKey(`delete:${playbook.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/playbooks/${playbook.id}`, { method: "DELETE" });
      setNotice(`Playbook “${playbook.name}” supprime.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Automatisation"
        breadcrumb="Avancé"
        description="Playbooks, suggestions et routines activables."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/scheduler" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
              <Bot className="h-3.5 w-3.5" /> Planification
            </Link>
            <Link to="/app/campaigns" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
              <Wand2 className="h-3.5 w-3.5" /> Campagnes
            </Link>
            <SecondaryButton onClick={() => setRefreshNonce((value) => value + 1)}>
              <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>
        }
      />

      <div className="w-full space-y-6 p-5 lg:p-7">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {loading ? (
          <LoadingCard label="Chargement des automatisations..." />
        ) : !data ? (
          <EmptyCard
            title="Automatisation indisponible"
            description="Aucune donnée pour le moment."
            action={
              <SecondaryButton onClick={() => setRefreshNonce((value) => value + 1)}>
                <RefreshCw className="h-3.5 w-3.5" /> Réessayer
              </SecondaryButton>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label="Playbooks actifs"
                value={activePlaybooks}
                sub={`${coveredModules} module(s) couverts`}
                accent="green"
                icon={<Bot className="h-4 w-4" />}
              />
              <StatCard
                label="Bibliothèque"
                value={availableTemplateCount}
                sub={`${deployedTemplateCount} déjà déployé(s)`}
                accent="blue"
                icon={<Wand2 className="h-4 w-4" />}
              />
              <StatCard
                label="Suggestions"
                value={recommendedCount}
                sub={criticalSuggestionCount > 0 ? `${criticalSuggestionCount} prioritaires` : "RAS"}
                accent={criticalSuggestionCount > 0 ? "amber" : "purple"}
                icon={<Sparkles className="h-4 w-4" />}
              />
              <StatCard
                label="Workflow achats"
                value={purchasesInReview}
                sub={`${readyToPayCount} bon(s) à payer`}
                accent="purple"
                icon={<Receipt className="h-4 w-4" />}
              />
            </div>

            <OpsPanelShell
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(tab) => setActiveTab(tab)}
              headerActions={panelHeaderActions}
            >
              {activeTab === "library" ? (
                <div className="space-y-5">
                  {filteredTemplates.length === 0 ? (
                    <OpsEmptyState
                      icon={<Wand2 className="h-5 w-5" />}
                      title="Aucun template"
                      description="Ajuste les filtres ou active un autre module."
                    />
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {filteredTemplates.map((template: any) => {
                        const existing = templateState.get(String(template.key));
                        const ModuleIcon = MODULE_ICONS[String(template.module || "setup").toLowerCase()] || Settings;
                        return (
                          <div
                            key={template.key}
                            className="flex h-full flex-col rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4 transition-all hover:shadow-md"
                          >
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3">
                                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                                  <ModuleIcon className="h-4 w-4 text-[#1d4ed8]" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                                    {template.name}
                                  </p>
                                  <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                    {template.description}
                                  </p>
                                </div>
                              </div>
                              {existing ? (
                                <StatusPill
                                  color={existing.active ? "ok" : "muted"}
                                  label={existing.active ? "Actif" : "Suspendu"}
                                />
                              ) : (
                                <StatusPill {...modulePill(template.module, template.module_label)} />
                              )}
                            </div>

                            <div className="mt-auto space-y-4">
                              <div className="flex flex-wrap gap-2">
                                <AutoTag
                                  color={
                                    modulePill(template.module, template.module_label).color === "info"
                                      ? "blue"
                                      : modulePill(template.module, template.module_label).color === "warn"
                                        ? "amber"
                                        : modulePill(template.module, template.module_label).color === "ok"
                                          ? "green"
                                          : modulePill(template.module, template.module_label).color === "purple"
                                            ? "purple"
                                            : "muted"
                                  }
                                  label={template.module_label || template.module}
                                />
                                <AutoTag color="muted" label={cadenceLabel(template.cadence)} />
                                <AutoTag color="muted" label={roleLabel(template.owner_role)} />
                                <AutoTag color="muted" label={triggerLabel(template.trigger_type)} />
                              </div>

                              <div className="flex items-center justify-between gap-3 border-t border-[#eef2f7] pt-3">
                                <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                  {existing ? "Déjà créé dans l'espace" : "Prêt à activer"}
                                </div>
                                {existing ? (
                                  <button
                                    type="button"
                                    onClick={() => setActiveTab("playbooks")}
                                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#eff6ff] px-3 py-1.5 text-[#1d4ed8]"
                                    style={{ fontSize: "0.75rem", fontWeight: 700 }}
                                  >
                                    Voir <ArrowRight className="h-3.5 w-3.5" />
                                  </button>
                                ) : (
                                  <PrimaryButton
                                    disabled={busyKey === `create:${template.key}`}
                                    onClick={() => void createTemplate(template)}
                                  >
                                    {busyKey === `create:${template.key}` ? "Ajout..." : "Ajouter"}
                                  </PrimaryButton>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              {activeTab === "playbooks" ? (
                <div className="space-y-5">
                  {filteredPlaybooks.length === 0 ? (
                    <OpsEmptyState
                      icon={<Bot className="h-5 w-5" />}
                      title="Aucun playbook"
                      description="Active une routine depuis la bibliothèque."
                      action={
                        <PrimaryButton onClick={() => setActiveTab("library")}>
                          <Wand2 className="h-3.5 w-3.5" /> Ouvrir la bibliothèque
                        </PrimaryButton>
                      }
                    />
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {filteredPlaybooks.map((playbook: any) => {
                        const ModuleIcon = MODULE_ICONS[String(playbook.module || "setup").toLowerCase()] || Settings;
                        const moduleBadge = modulePill(playbook.module, playbook.module_label);
                        const isBusy = busyKey === `toggle:${playbook.id}` || busyKey === `delete:${playbook.id}`;
                        return (
                          <div
                            key={playbook.id}
                            className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4 transition-all hover:shadow-md"
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0 flex items-start gap-3">
                                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                                  <ModuleIcon className="h-4 w-4 text-[#1d4ed8]" />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p
                                      className="truncate text-[#0f172a]"
                                      style={{ fontSize: "0.9375rem", fontWeight: 700 }}
                                    >
                                      {playbook.name}
                                    </p>
                                    <StatusPill {...moduleBadge} />
                                    <StatusPill
                                      color={playbook.active ? "ok" : "muted"}
                                      label={playbook.active ? "Actif" : "Suspendu"}
                                    />
                                  </div>
                                  {playbook.description ? (
                                    <p
                                      className="mt-1 text-[#64748b]"
                                      style={{ fontSize: "0.75rem", lineHeight: 1.55 }}
                                    >
                                      {playbook.description}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
                              <OpsMiniStat label="Cadence" value={cadenceLabel(playbook.cadence)} accent="slate" />
                              <OpsMiniStat label="Rôle" value={roleLabel(playbook.owner_role)} accent="blue" />
                              <OpsMiniStat
                                label="Declencheur"
                                value={triggerLabel(playbook.trigger_type)}
                                accent="amber"
                              />
                              <OpsMiniStat
                                label="Dernier run"
                                value={formatDateTimeFr(playbook.last_triggered_at || playbook.updated_at, "—")}
                                accent={playbook.active ? "green" : "slate"}
                              />
                            </div>

                            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#eef2f7] pt-3">
                              <SecondaryButton disabled={isBusy} onClick={() => void togglePlaybook(playbook)}>
                                {playbook.active ? (
                                  <PauseCircle className="w-3.5 h-3.5" />
                                ) : (
                                  <PlayCircle className="w-3.5 h-3.5" />
                                )}
                                {playbook.active ? "Suspendre" : "Activer"}
                              </SecondaryButton>
                              <Link
                                to="/app/scheduler"
                                className={headerLinkClass}
                                style={{ fontSize: "0.75rem", fontWeight: 700 }}
                              >
                                Voir scheduler
                              </Link>
                              <SecondaryButton
                                disabled={isBusy}
                                onClick={() => void deletePlaybook(playbook)}
                                className="!text-[#b91c1c]"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Supprimer
                              </SecondaryButton>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              {activeTab === "suggestions" ? (
                <div className="space-y-5">
                  {filteredSuggestions.length === 0 ? (
                    <OpsEmptyState
                      icon={<Sparkles className="h-5 w-5" />}
                      title="Aucune suggestion"
                      description="Rien de prioritaire a remonter pour l'instant."
                    />
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {filteredSuggestions.map((item: any) => {
                        const matchingTemplate = item.template_key
                          ? templates.find((entry: any) => entry.key === item.template_key)
                          : null;
                        const existing = item.template_key ? templateState.get(String(item.template_key)) : null;
                        return (
                          <div
                            key={item.id}
                            className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4 transition-all hover:shadow-md"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill {...severityPill(item.severity)} />
                              <StatusPill {...modulePill(item.module, item.module_label)} />
                            </div>
                            <p className="mt-3 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                              {item.title}
                            </p>
                            {item.subtitle ? (
                              <p className="mt-1 text-[#475569]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                                {item.subtitle}
                              </p>
                            ) : null}
                            <p className="mt-2 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                              {item.description}
                            </p>

                            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#eef2f7] pt-3">
                              <Link
                                to={item.href || "/app/automations"}
                                className="inline-flex items-center gap-1.5 text-[#1d4ed8]"
                                style={{ fontSize: "0.75rem", fontWeight: 700 }}
                              >
                                Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                              {matchingTemplate && !existing ? (
                                <PrimaryButton
                                  disabled={busyKey === `create:${matchingTemplate.key}`}
                                  onClick={() => void createTemplate(matchingTemplate)}
                                >
                                  {busyKey === `create:${matchingTemplate.key}`
                                    ? "Ajout..."
                                    : item.action_label || "Ajouter"}
                                </PrimaryButton>
                              ) : existing ? (
                                <StatusPill
                                  color={existing.active ? "ok" : "muted"}
                                  label={existing.active ? "Déjà actif" : "Déjà créé"}
                                />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              {activeTab === "workflow" ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
                    {workflowStateCards.map((entry) => (
                      <OpsMiniStat
                        key={entry.key}
                        label={entry.label}
                        value={Number(workflowSummary?.states?.[entry.key] || 0)}
                        accent={entry.accent}
                      />
                    ))}
                  </div>

                  <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-2xl border border-[#eef2f7] bg-white">
                      <div className="flex items-center justify-between gap-3 border-b border-[#f1f5f9] px-4 py-4">
                        <div>
                          <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                            Documents fournisseurs
                          </p>
                          <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                            Vue rapide du circuit achat.
                          </p>
                        </div>
                        <StatusPill
                          color={filteredWorkflowItems.length > 0 ? "info" : "muted"}
                          label={`${filteredWorkflowItems.length} visible(s)`}
                        />
                      </div>

                      {filteredWorkflowItems.length === 0 ? (
                        <div className="p-4">
                          <OpsEmptyState
                            icon={<Inbox className="h-5 w-5" />}
                            title="Aucun document fournisseur"
                            description="Le workflow achats se remplira ici."
                          />
                        </div>
                      ) : (
                        <div className="divide-y divide-[#f1f5f9]">
                          {filteredWorkflowItems.slice(0, 8).map((item: any) => (
                            <div key={item.invoice_id} className="px-4 py-4">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                                      {item.supplier_name || "Fournisseur"}
                                    </p>
                                    <StatusPill color={workflowTonePill(item.tone).color} label={item.state_label} />
                                    {item.owner_role ? (
                                      <AutoTag color="muted" label={roleLabel(item.owner_role)} />
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                                    {item.invoice_number ? `Piece ${item.invoice_number}` : "Piece sans numero"}
                                  </p>
                                  <p className="mt-2 text-[#475569]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                                    {item.next_step_title}
                                  </p>
                                  <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                    {item.next_step_description}
                                  </p>
                                </div>
                                <div className="text-left lg:min-w-[180px] lg:text-right">
                                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                    {formatDateTimeFr(item.updated_at, "Pas de mise à jour")}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-[#eef2f7] bg-[#fcfdff] p-4">
                        <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Vue rapide
                        </p>
                        <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                          Le workflow achats reste connecté aux routines et au centre d'action.
                        </p>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <OpsMiniStat label="En revue" value={purchasesInReview} accent="amber" />
                          <OpsMiniStat label="Bons à payer" value={readyToPayCount} accent="purple" />
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Link
                            to="/app/purchases"
                            className={headerLinkClass}
                            style={{ fontSize: "0.75rem", fontWeight: 700 }}
                          >
                            <Inbox className="h-3.5 w-3.5" /> Ouvrir achats
                          </Link>
                          <Link
                            to="/app/scheduler"
                            className={headerLinkClass}
                            style={{ fontSize: "0.75rem", fontWeight: 700 }}
                          >
                            <Bot className="h-3.5 w-3.5" /> Voir scheduler
                          </Link>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#eef2f7] bg-white p-4">
                        <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Prochaines etapes
                        </p>
                        {filteredWorkflowItems.length === 0 ? (
                          <p className="mt-3 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                            Rien a afficher pour l'instant.
                          </p>
                        ) : (
                          <div className="mt-3 space-y-3">
                            {filteredWorkflowItems.slice(0, 4).map((item: any) => (
                              <div
                                key={`next-${item.invoice_id}`}
                                className="rounded-xl border border-[#f1f5f9] bg-[#fafbfd] p-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                                    {item.supplier_name || item.invoice_number || "Document"}
                                  </p>
                                  <AutoTag
                                    color={
                                      workflowTonePill(item.tone).color === "danger"
                                        ? "red"
                                        : workflowTonePill(item.tone).color === "warn"
                                          ? "amber"
                                          : workflowTonePill(item.tone).color === "ok"
                                            ? "green"
                                            : workflowTonePill(item.tone).color === "purple"
                                              ? "purple"
                                              : "blue"
                                    }
                                    label={item.state_label}
                                  />
                                </div>
                                <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                  {item.next_step_title}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </OpsPanelShell>
          </>
        )}
      </div>
    </div>
  );
}
