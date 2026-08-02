"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi, sanitizeUserFacingApiMessage } from "@/lib/api";
import { formatDateTimeFr } from "@/lib/dateFormat";
import {
  AppPageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import { OpsEmptyState, OpsMiniStat, OpsPanelShell } from "../../components/app/OpsTabbedBoard";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Inbox,
  Layers,
  Mail,
  MailCheck,
  Megaphone,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  UserRound,
  Wand2,
  Zap,
} from "lucide-react";

const stateOptions = [
  { key: "all", label: "Toutes" },
  { key: "draft", label: "Brouillons" },
  { key: "ready", label: "Prêtes" },
  { key: "blocked", label: "Bloquées" },
  { key: "sent", label: "Diffusées" },
  { key: "skipped", label: "Ignorées" },
];

type OutboxTab = "queue" | "dispatches" | "pipelines" | "health";

function stateTone(state: string | null | undefined) {
  const normalized = String(state || "draft").toLowerCase();
  if (normalized === "ready") return "purple";
  if (normalized === "sent") return "ok";
  if (normalized === "blocked") return "danger";
  if (normalized === "skipped") return "muted";
  return "info";
}

function sendActionLabel(item: any) {
  const state = String(item?.state || "draft").toLowerCase();
  if (state === "sent") return "Renvoyer";
  if (state === "blocked") return "Retenter";
  return "Envoyer maintenant";
}

function deliveryModeLabel(value: any, fallback = "Service d’envoi") {
  const label = String(value || "").trim();
  if (!label) return fallback;
  if (/^smtp$/i.test(label)) return "Service d’envoi";
  if (/^delivery$/i.test(label)) return "Envoi";
  if (/^fallback$/i.test(label)) return "Journal opérateur";
  return label;
}

function dispatchRunTone(run: any): "ok" | "warn" | "danger" | "muted" | "info" {
  if (Number(run?.failed_count || 0) > 0) return "warn";
  if (Number(run?.sent_count || 0) > 0) return "ok";
  return "muted";
}

export function OutboxPage() {
  const [payload, setPayload] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<OutboxTab>("queue");
  const [queuePage, setQueuePage] = useState(1);
  const [dispatchPage, setDispatchPage] = useState(1);
  const [pipelinePage, setPipelinePage] = useState(1);
  const [queuePageSize, setQueuePageSize] = usePersistedListPageSize("pixfacture.outbox.queuePageSize.v1");
  const [dispatchPageSize, setDispatchPageSize] = usePersistedListPageSize("pixfacture.outbox.dispatchPageSize.v1");
  const [pipelinePageSize, setPipelinePageSize] = usePersistedListPageSize("pixfacture.outbox.pipelinePageSize.v1");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/ops/outbox");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw data || new Error("Envois indisponibles.");
      setPayload(data || null);
    } catch (err) {
      setPayload(null);
      setError(formatApiError(err, "Impossible de charger la file d’envoi."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshNonce]);

  const summary = payload?.summary || {};
  const delivery = payload?.delivery || {};
  const items = useMemo(() => (Array.isArray(payload?.items) ? payload.items : []), [payload?.items]);
  const recentDispatches = useMemo(
    () => (Array.isArray(payload?.recent_dispatches) ? payload.recent_dispatches : []),
    [payload?.recent_dispatches],
  );
  const schedulerRuns = useMemo(
    () => (Array.isArray(payload?.scheduler_runs) ? payload.scheduler_runs : []),
    [payload?.scheduler_runs],
  );

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item: any) => {
      if (stateFilter !== "all" && String(item.state || "").toLowerCase() !== stateFilter) return false;
      if (!query) return true;
      const haystack = [
        item.campaign_name,
        item.customer_name,
        item.customer_email,
        item.subject,
        item.segment_label,
        item.risk_label,
        item.assignee_label,
        item.notes,
        item.last_error,
        item.delivery_mode_label,
        item.last_attempt_label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search, stateFilter]);
  const pageQueueItems = useMemo(
    () => paginateList(filteredItems, queuePage, queuePageSize),
    [filteredItems, queuePage, queuePageSize],
  );
  const pageRecentDispatches = useMemo(
    () => paginateList(recentDispatches, dispatchPage, dispatchPageSize),
    [dispatchPage, dispatchPageSize, recentDispatches],
  );
  const pageSchedulerRuns = useMemo(
    () => paginateList(schedulerRuns, pipelinePage, pipelinePageSize),
    [pipelinePage, pipelinePageSize, schedulerRuns],
  );

  useEffect(() => {
    setQueuePage(1);
  }, [search, stateFilter]);

  useEffect(() => {
    if (activeTab === "dispatches") setDispatchPage(1);
    if (activeTab === "pipelines") setPipelinePage(1);
  }, [activeTab]);

  const refresh = () => setRefreshNonce((value) => value + 1);

  const rebuild = async () => {
    setBusyKey("rebuild");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/outbox/rebuild", { method: "POST" });
      setNotice(
        `${Number(result?.created_count || 0)} ligne(s) générée(s) · ${Number(result?.blocked_count || 0)} bloquée(s).`,
      );
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Synchronisation de la file d’envoi impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const approveDrafts = async () => {
    setBusyKey("approve-drafts");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/outbox/approve-drafts", { method: "POST" });
      setNotice(result?.notes?.[0] || "Brouillons promus en prêts.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de valider les brouillons."));
    } finally {
      setBusyKey(null);
    }
  };

  const dispatchReady = async () => {
    setBusyKey("dispatch-ready");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/outbox/dispatch-ready", { method: "POST" });
      const label = deliveryModeLabel(result?.delivery_mode_label, "Envoi");
      setNotice(
        `${Number(result?.sent_count || 0)} ligne(s) traitée(s) · ${label}${Number(result?.failed_count || 0) ? ` · ${Number(result?.failed_count || 0)} échec(s)` : ""}.`,
      );
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Envoi des lignes impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const runPipeline = async () => {
    setBusyKey("run-pipeline");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/outbox/run-pipeline", { method: "POST" });
      setNotice(
        `${Number(result?.campaigns_processed || 0)} campagne(s) traitée(s) · ${Number(result?.drafts_approved || 0)} brouillon(s) promu(s) · ${Number(result?.sent_count || 0)} diffusion(s).`,
      );
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Traitement automatique des envois impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchItem = async (itemId: string, body: any, successLabel: string) => {
    setBusyKey(`item-${itemId}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/outbox/${itemId}`, { method: "PATCH", body: JSON.stringify(body) });
      setNotice(successLabel);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour cette ligne d’envoi."));
    } finally {
      setBusyKey(null);
    }
  };

  const sendItem = async (itemId: string) => {
    setBusyKey(`send-${itemId}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/ops/outbox/${itemId}/send`, { method: "POST" });
      const label = deliveryModeLabel(result?.delivery_mode_label, "Envoi");
      setNotice(result?.notes?.[0] || `Ligne traitée via ${label}.`);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de diffuser cette ligne."));
    } finally {
      setBusyKey(null);
    }
  };

  const stateCount = (key: string) =>
    key === "all" ? items.length : items.filter((item: any) => String(item.state || "").toLowerCase() === key).length;

  const tabs: Array<{ id: OutboxTab; label: string; badge?: number }> = [
    { id: "queue", label: "File", badge: items.length },
    { id: "dispatches", label: "Dispatchs", badge: recentDispatches.length },
    { id: "pipelines", label: "Pipelines", badge: schedulerRuns.length },
    { id: "health", label: "Santé" },
  ];

  const healthChecks = [
    {
      label: "SMTP opérationnel",
      ok: Boolean(delivery.smtp_ready),
      detail: delivery.smtp_ready
        ? `${deliveryModeLabel(delivery.delivery_mode_label)} prêt`
        : `${deliveryModeLabel(delivery.delivery_mode_label, "Journal opérateur")} actif`,
    },
    {
      label: "File due",
      ok: Number(delivery.ready_due_count || 0) === 0,
      detail:
        Number(delivery.ready_due_count || 0) > 0
          ? `${Number(delivery.ready_due_count || 0)} ligne(s) prêtes`
          : "Aucune ligne urgente",
    },
    {
      label: "Programmation",
      ok: Number(delivery.ready_future_count || 0) >= 0,
      detail: delivery.next_scheduled_at
        ? `Prochaine échéance ${formatDateTimeFr(delivery.next_scheduled_at, "—")}`
        : `${Number(delivery.ready_future_count || 0)} ligne(s) planifiée(s)`,
    },
    {
      label: "Blocages & échecs",
      ok: Number(delivery.blocked_count || 0) + Number(delivery.failed_count || 0) === 0,
      detail: `${Number(delivery.blocked_count || 0)} bloquée(s) · ${Number(delivery.failed_count || 0)} échec(s)`,
    },
  ];

  const pipelineActions = (
    <>
      <SecondaryButton onClick={() => void rebuild()} disabled={busyKey === "rebuild"}>
        <Wand2 className="h-3.5 w-3.5" /> {busyKey === "rebuild" ? "Synchronisation…" : "Rejouer"}
      </SecondaryButton>
      <SecondaryButton
        onClick={() => void approveDrafts()}
        disabled={busyKey === "approve-drafts" || !summary.draft_count}
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> {busyKey === "approve-drafts" ? "Validation…" : "Valider"}
      </SecondaryButton>
      <SecondaryButton
        onClick={() => void dispatchReady()}
        disabled={busyKey === "dispatch-ready" || !summary.ready_count}
      >
        <Send className="h-3.5 w-3.5" /> {busyKey === "dispatch-ready" ? "Diffusion…" : "Diffuser"}
      </SecondaryButton>
      <PrimaryButton onClick={() => void runPipeline()} disabled={busyKey === "run-pipeline"}>
        <Bot className="h-3.5 w-3.5" /> {busyKey === "run-pipeline" ? "Pipeline…" : "Pipeline auto"}
      </PrimaryButton>
    </>
  );

  return (
    <div>
      <AppPageHeader
        title="Envois"
        breadcrumb="Avancé"
        description="File d'envoi, diffusions et état de livraison."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <Link to="/app/campaigns" className="flex items-center gap-1.5">
                <Megaphone className="h-3.5 w-3.5" /> Campagnes
              </Link>
            </SecondaryButton>
            <SecondaryButton onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>
        }
      />

      <div className="w-full space-y-6 p-5 lg:p-7">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {!loading && Array.isArray(delivery?.warnings) && delivery.warnings.length > 0 ? (
          <NoticeBanner tone={delivery.smtp_ready ? "info" : "warning"}>{delivery.warnings.join(" · ")}</NoticeBanner>
        ) : null}

        {loading ? (
          <LoadingCard label="Chargement des envois…" />
        ) : !payload ? (
          <EmptyCard
            title="Envois indisponibles"
            description="Aucune donnée pour le moment."
            action={
              <SecondaryButton onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" /> Réessayer
              </SecondaryButton>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatCard
                label="File totale"
                value={Number(summary.total_count || items.length || 0)}
                sub="Tous statuts"
                accent="blue"
                icon={<Inbox className="h-4 w-4" />}
              />
              <StatCard
                label="Prêtes à envoyer"
                value={Number(summary.due_ready_count || 0)}
                sub={`${Number(summary.ready_count || 0)} au total`}
                accent={Number(summary.due_ready_count || 0) > 0 ? "blue" : "purple"}
                icon={<Send className="h-4 w-4" />}
              />
              <StatCard
                label="Envoyées"
                value={Number(summary.sent_smtp_count || 0) + Number(summary.sent_log_only_count || 0)}
                sub={`${recentDispatches.length} récents`}
                accent="green"
                icon={<MailCheck className="h-4 w-4" />}
              />
              <StatCard
                label="Échecs"
                value={Number(summary.blocked_count || 0) + Number(summary.failed_count || 0)}
                sub={`${Number(summary.blocked_count || 0)} bloq. · ${Number(summary.failed_count || 0)} échecs`}
                accent={Number(summary.blocked_count || 0) + Number(summary.failed_count || 0) > 0 ? "red" : "amber"}
                icon={<AlertTriangle className="h-4 w-4" />}
              />
              <StatCard
                label="Pipelines"
                value={schedulerRuns.length}
                sub="Auto"
                accent="amber"
                icon={<Layers className="h-4 w-4" />}
              />
            </div>

            <OpsPanelShell tabs={tabs} activeTab={activeTab} onTabChange={(tab) => setActiveTab(tab)}>
              {activeTab === "queue" ? (
                <div className="space-y-2">
                  {filteredItems.length === 0 ? (
                    <OpsEmptyState
                      icon={<Inbox className="h-5 w-5" />}
                      title={items.length === 0 ? "Aucune ligne d’envoi" : "Aucune ligne avec ces filtres"}
                      description={
                        items.length === 0
                          ? "Lance une campagne pour remplir la file."
                          : "Change de filtre pour retrouver les autres lignes."
                      }
                      action={pipelineActions}
                    />
                  ) : (
                    <div className="space-y-2">
                      {pageQueueItems.map((item: any) => {
                        const patchBusy = busyKey === `item-${item.id}`;
                        const sendBusy = busyKey === `send-${item.id}`;
                        const canReady = item.state === "draft" && item.customer_email;
                        const canReset =
                          ["ready", "skipped", "blocked"].includes(String(item.state || "").toLowerCase()) &&
                          item.customer_email;
                        const canSkip = ["draft", "ready"].includes(String(item.state || "").toLowerCase());
                        const canSend = Boolean(item.customer_email);

                        return (
                          <div
                            key={item.id}
                            className="rounded-xl px-4 py-3.5 transition-colors hover:bg-[#f8fafc]"
                            style={{ border: "1px solid #f1f5f9" }}
                          >
                            <div className="flex items-center gap-4">
                              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[#f4f6fa]">
                                {String(item.document_kind || "")
                                  .toLowerCase()
                                  .includes("invoice") ? (
                                  <FileText className="h-3.5 w-3.5 text-[#1d4ed8]" />
                                ) : String(item.document_kind || "")
                                    .toLowerCase()
                                    .includes("quote") ? (
                                  <FileText className="h-3.5 w-3.5 text-[#059669]" />
                                ) : String(item.delivery_mode || "")
                                    .toLowerCase()
                                    .includes("campaign") ? (
                                  <Megaphone className="h-3.5 w-3.5 text-[#d97706]" />
                                ) : (
                                  <Mail className="h-3.5 w-3.5 text-[#94a3b8]" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p
                                  className="truncate text-[#374151]"
                                  style={{ fontSize: "0.875rem", fontWeight: 500 }}
                                >
                                  {item.subject || item.campaign_name}
                                </p>
                                <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                  {item.customer_email || item.customer_name || "Destinataire manquant"} ·{" "}
                                  {formatDateTimeFr(item.scheduled_for || item.created_at || item.sent_at, "—")}
                                  {Number(item.attempt_count || 0) > 0
                                    ? ` · ${Number(item.attempt_count || 0)} retry(s)`
                                    : ""}
                                </p>
                              </div>
                              <StatusPill
                                status={stateTone(item.state)}
                                label={item.state_label || item.state || "État"}
                              />
                              <div className="flex flex-shrink-0 items-center gap-1">
                                {canSend ? (
                                  <button
                                    type="button"
                                    onClick={() => void sendItem(item.id)}
                                    disabled={sendBusy}
                                    className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-white"
                                    style={{
                                      fontSize: "0.75rem",
                                      fontWeight: 600,
                                      background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                                    }}
                                  >
                                    <Send className="h-3 w-3" /> {sendBusy ? "…" : sendActionLabel(item)}
                                  </button>
                                ) : null}
                                {canReady ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void patchItem(item.id, { state: "ready" }, "Ligne d’envoi marquée prête.")
                                    }
                                    disabled={patchBusy}
                                    className="flex items-center gap-1 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1.5 text-[#475569]"
                                    style={{ fontSize: "0.75rem" }}
                                  >
                                    <CheckCircle2 className="h-3 w-3" /> Prête
                                  </button>
                                ) : null}
                                {canReset ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void patchItem(item.id, { state: "draft" }, "Ligne repassée en brouillon.")
                                    }
                                    disabled={patchBusy}
                                    className="flex items-center gap-1 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1.5 text-[#475569]"
                                    style={{ fontSize: "0.75rem" }}
                                  >
                                    <RotateCcw className="h-3 w-3" /> Brouillon
                                  </button>
                                ) : null}
                                {canSkip ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void patchItem(item.id, { state: "skipped" }, "Ligne d’envoi ignorée.")
                                    }
                                    disabled={patchBusy}
                                    className="flex items-center gap-1 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-2.5 py-1.5 text-[#dc2626]"
                                    style={{ fontSize: "0.75rem", fontWeight: 600 }}
                                  >
                                    <ShieldAlert className="h-3 w-3" /> Ignorer
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            {item.last_error ? (
                              <div
                                className="mt-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#b91c1c]"
                                style={{ fontSize: "0.75rem" }}
                              >
                                {sanitizeUserFacingApiMessage(
                                  item.last_error,
                                  400,
                                  "Cet envoi n'a pas abouti. Vérifiez le destinataire puis réessayez.",
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <ListPagination
                    page={queuePage}
                    totalItems={filteredItems.length}
                    pageSize={queuePageSize}
                    pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                    itemLabel="ligne"
                    onPageChange={setQueuePage}
                    onPageSizeChange={(nextPageSize) => {
                      setQueuePage(1);
                      setQueuePageSize(nextPageSize);
                    }}
                    pageSizeAriaLabel="Lignes par page"
                    className="rounded-xl border border-[#f1f5f9]"
                  />
                </div>
              ) : null}

              {activeTab === "dispatches" ? (
                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                      Derniers envois.
                    </p>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-xl bg-[#f8fafc] px-3 py-1.5 text-[#475569]"
                      style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                      aria-label="Exporter les derniers envois affichés"
                      title="Exporte les dispatchs visibles dans cet onglet."
                    >
                      <Download className="h-3 w-3" /> Exporter la vue
                    </button>
                  </div>
                  {recentDispatches.length === 0 ? (
                    <OpsEmptyState
                      icon={<MailCheck className="h-5 w-5" />}
                      title="Aucun dispatch"
                      description="Les diffusions récentes apparaîtront ici."
                    />
                  ) : (
                    <div className="space-y-2">
                      {pageRecentDispatches.map((run: any) => (
                        <div
                          key={run.id}
                          className="rounded-xl px-4 py-3.5 transition-colors hover:bg-[#f8fafc]"
                          style={{ border: "1px solid #f1f5f9" }}
                        >
                          <div className="flex items-center gap-4">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[#f0fdf4]">
                              <MailCheck className="h-3.5 w-3.5 text-[#059669]" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                                {Number(run.sent_count || 0)} ligne(s) traitée(s)
                              </p>
                              <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                Via {deliveryModeLabel(run.delivery_mode_label, "Envoi")} ·{" "}
                                {formatDateTimeFr(run.generated_at, "—")}
                              </p>
                            </div>
                            <StatusPill status={dispatchRunTone(run)} label={run.trigger_label || "Dispatch"} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <ListPagination
                    page={dispatchPage}
                    totalItems={recentDispatches.length}
                    pageSize={dispatchPageSize}
                    pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                    itemLabel="dispatch"
                    pluralLabel="dispatchs"
                    onPageChange={setDispatchPage}
                    onPageSizeChange={(nextPageSize) => {
                      setDispatchPage(1);
                      setDispatchPageSize(nextPageSize);
                    }}
                    pageSizeAriaLabel="Dispatchs par page"
                    className="mt-4 rounded-xl border border-[#f1f5f9]"
                  />
                </div>
              ) : null}

              {activeTab === "pipelines" ? (
                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                      Pipelines d'envoi automatisé rattachés aux automatisations et campagnes.
                    </p>
                    <Link
                      to="/app/automations"
                      className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
                      style={{ fontSize: "0.8125rem", fontWeight: 600, background: "#eff6ff" }}
                    >
                      <Zap className="h-3.5 w-3.5" /> Automatisation
                    </Link>
                  </div>
                  {schedulerRuns.length === 0 ? (
                    <OpsEmptyState
                      icon={<Bot className="h-5 w-5" />}
                      title="Aucun pipeline"
                      description="Déclenche le pipeline pour lancer l'historique."
                      action={pipelineActions}
                    />
                  ) : (
                    <div className="space-y-2">
                      {pageSchedulerRuns.map((run: any) => (
                        <div
                          key={run.id}
                          className="rounded-xl px-4 py-3.5 transition-colors hover:bg-[#f8fafc]"
                          style={{ border: "1px solid #f1f5f9" }}
                        >
                          <div className="flex items-center gap-4">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[#eff6ff]">
                              <Layers className="h-3.5 w-3.5 text-[#1d4ed8]" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                                {run.trigger_label || "Pipeline auto"}
                              </p>
                              <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                {Number(run.campaigns_processed || 0)} run(s) · Dernier :{" "}
                                {formatDateTimeFr(run.generated_at, "—")} ·{" "}
                                <span className="text-[#059669]">{Number(run.sent_count || 0)} ok</span>
                                {Number(run.failed_count || 0) > 0 ? (
                                  <span className="text-[#dc2626]"> · {Number(run.failed_count || 0)} échec(s)</span>
                                ) : null}
                              </p>
                            </div>
                            <StatusPill
                              label={Number(run.failed_count || 0) > 0 ? "À surveiller" : "Actif"}
                              status={Number(run.failed_count || 0) > 0 ? "warn" : "ok"}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <ListPagination
                    page={pipelinePage}
                    totalItems={schedulerRuns.length}
                    pageSize={pipelinePageSize}
                    pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                    itemLabel="pipeline"
                    onPageChange={setPipelinePage}
                    onPageSizeChange={(nextPageSize) => {
                      setPipelinePage(1);
                      setPipelinePageSize(nextPageSize);
                    }}
                    pageSizeAriaLabel="Pipelines par page"
                    className="mt-4 rounded-xl border border-[#f1f5f9]"
                  />
                  <div className="mt-4 flex flex-wrap gap-2">{pipelineActions}</div>
                </div>
              ) : null}

              {activeTab === "health" ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                      Contrôles des envois
                    </p>
                    {healthChecks.map((check) => (
                      <div
                        key={check.label}
                        className="flex items-start gap-3 rounded-xl p-4"
                        style={{
                          background: check.ok ? "#f0fdf4" : "#fef2f2",
                          border: `1px solid ${check.ok ? "#bbf7d0" : "#fecaca"}`,
                        }}
                      >
                        {check.ok ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#059669]" />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#dc2626]" />
                        )}
                        <div>
                          <p
                            style={{
                              fontSize: "0.8125rem",
                              fontWeight: 600,
                              color: check.ok ? "#166534" : "#dc2626",
                            }}
                          >
                            {check.label}
                          </p>
                          <p style={{ fontSize: "0.75rem", color: check.ok ? "#16a34a" : "#b91c1c" }}>{check.detail}</p>
                        </div>
                      </div>
                    ))}
                    {Array.isArray(delivery.warnings) && delivery.warnings.length > 0 ? (
                      <div className="rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-[#92400e]">
                        <div style={{ fontSize: "0.8125rem", fontWeight: 600 }}>Alertes</div>
                        <div className="mt-1" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                          {delivery.warnings.join(" · ")}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <OpsMiniStat
                        label="Mode actif"
                        value={deliveryModeLabel(delivery.delivery_mode_label, "Envoi")}
                        detail={delivery.smtp_ready ? "Service d’envoi" : "Journal opérateur"}
                        accent={delivery.smtp_ready ? "green" : "amber"}
                      />
                      <OpsMiniStat
                        label="Prochaine échéance"
                        value={formatDateTimeFr(delivery.next_scheduled_at, "—")}
                        detail={`${Number(delivery.ready_future_count || 0)} plus tard`}
                        accent="blue"
                      />
                      <OpsMiniStat
                        label="Emails envoyés"
                        value={Number(delivery.sent_smtp_count || 0)}
                        detail="Volume réel"
                        accent="green"
                      />
                      <OpsMiniStat
                        label="Journalisés"
                        value={Number(delivery.sent_log_only_count || 0)}
                        detail="Journal opérateur"
                        accent="purple"
                      />
                    </div>

                    <div className="rounded-xl border border-[#f1f5f9] bg-[#fbfdff] p-4">
                      <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                        24 h envois
                      </p>
                      <div className="mt-4 space-y-4">
                        {[
                          {
                            label: "Messages envoyés",
                            value: Number(summary.sent_smtp_count || 0) + Number(summary.sent_log_only_count || 0),
                            ratio: Math.min(
                              1,
                              (Number(summary.sent_smtp_count || 0) + Number(summary.sent_log_only_count || 0)) / 10,
                            ),
                          },
                          {
                            label: "Prêts maintenant",
                            value: Number(summary.due_ready_count || 0),
                            ratio: Math.min(1, Number(summary.due_ready_count || 0) / 10),
                          },
                          {
                            label: "Échecs",
                            value: Number(summary.failed_count || 0),
                            ratio: Math.min(1, Number(summary.failed_count || 0) / 10),
                          },
                        ].map((metric) => (
                          <div key={metric.label}>
                            <div className="mb-1 flex items-center justify-between">
                              <span className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                {metric.label}
                              </span>
                              <span className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                                {metric.value}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-[#f1f5f9]">
                              <div
                                className="h-full rounded-full bg-[#1d4ed8]"
                                style={{ width: `${metric.ratio * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2 border-t border-[#f1f5f9] pt-4">
                        <SecondaryButton onClick={refresh}>
                          <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
                        </SecondaryButton>
                        <SecondaryButton onClick={() => void runPipeline()} disabled={busyKey === "run-pipeline"}>
                          <Zap className="h-3.5 w-3.5" /> Relancer le pipeline
                        </SecondaryButton>
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
