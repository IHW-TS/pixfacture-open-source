"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi, sanitizeUserFacingApiMessage } from "@/lib/api";
import { formatDateTimeFr } from "@/lib/dateFormat";
import {
  AppPageHeader,
  DangerButton,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SelectField,
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
  BellRing,
  Bot,
  CalendarClock,
  ChevronRight,
  CheckCircle2,
  Download,
  Inbox,
  Mail,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  TestTube2,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";

type SchedulerTab = "jobs" | "incidents" | "channels" | "audit";

function toneFor(status: string | null | undefined) {
  const normalized = String(status || "idle").toLowerCase();
  if (normalized === "ok") return "ok";
  if (normalized === "warn") return "warn";
  if (normalized === "error") return "danger";
  if (normalized === "paused") return "muted";
  return "info";
}

function severityTone(value: string | null | undefined) {
  const normalized = String(value || "medium").toLowerCase();
  if (normalized === "critical") return "danger";
  if (normalized === "high") return "warn";
  if (normalized === "medium") return "info";
  return "muted";
}

function statAccent(status: string | null | undefined) {
  const normalized = String(status || "idle").toLowerCase();
  if (normalized === "ok") return "green";
  if (normalized === "warn") return "amber";
  if (normalized === "error") return "red";
  if (normalized === "paused") return "cyan";
  return "blue";
}

function minutesLabel(value: number | null | undefined) {
  const minutes = Number(value || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h`;
  return `${(hours / 24).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} j`;
}

function splitCsv(value: string | null | undefined) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function joinCsv(values: any) {
  return Array.isArray(values) ? values.join(", ") : "";
}

function incidentScopeLabel(value: string | null | undefined) {
  const normalized = String(value || "single").toLowerCase();
  if (normalized === "same_severity") return "Même gravité";
  if (normalized === "same_module") return "Même module";
  if (normalized === "all_open") return "Tous les ouverts";
  return "Incident";
}

function SchedTag({ color, label }: { color: string; label: string }) {
  const cfg: Record<string, { bg: string; text: string; dot: string }> = {
    orange: { bg: "#fff7ed", text: "#c2410c", dot: "#fb923c" },
    blue: { bg: "#eff6ff", text: "#1d4ed8", dot: "#3b82f6" },
    amber: { bg: "#fffbeb", text: "#b45309", dot: "#f59e0b" },
    green: { bg: "#f0fdf4", text: "#15803d", dot: "#22c55e" },
    red: { bg: "#fef2f2", text: "#dc2626", dot: "#ef4444" },
    muted: { bg: "#f8fafc", text: "#64748b", dot: "#cbd5e1" },
  };
  const tone = cfg[color] || cfg.blue;
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

function downloadBlobFile(blob: Blob, filename: string) {
  if (typeof window === "undefined") return;
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

export function SchedulerPage() {
  const [payload, setPayload] = useState<any>(null);
  const [opsBoard, setOpsBoard] = useState<any>(null);
  const [auditBoard, setAuditBoard] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeTab, setActiveTab] = useState<SchedulerTab>("jobs");
  const [showChannelComposer, setShowChannelComposer] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobsPage, setJobsPage] = useState(1);
  const [incidentsPage, setIncidentsPage] = useState(1);
  const [channelsPage, setChannelsPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [jobsPageSize, setJobsPageSize] = usePersistedListPageSize("pixfacture.scheduler.jobsPageSize.v1");
  const [incidentsPageSize, setIncidentsPageSize] = usePersistedListPageSize(
    "pixfacture.scheduler.incidentsPageSize.v1",
  );
  const [channelsPageSize, setChannelsPageSize] = usePersistedListPageSize("pixfacture.scheduler.channelsPageSize.v1");
  const [auditPageSize, setAuditPageSize] = usePersistedListPageSize("pixfacture.scheduler.auditPageSize.v1");
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, any>>({});
  const [channelDrafts, setChannelDrafts] = useState<Record<string, any>>({});
  const [incidentActionScope, setIncidentActionScope] = useState("single");
  const [incidentActionReason, setIncidentActionReason] = useState("");
  const [channelPreview, setChannelPreview] = useState<any>(null);
  const [auditFilters, setAuditFilters] = useState<any>({
    query: "",
    action_kind: "",
    status: "",
    module: "",
    days: "30",
  });
  const [auditDraft, setAuditDraft] = useState<any>({ query: "", action_kind: "", status: "", module: "", days: "30" });
  const [channelForm, setChannelForm] = useState<any>({
    kind: "webhook",
    label: "",
    url: "",
    min_severity: "high",
    mention: "",
    include_digest: "false",
    digest_min_urgent_count: "0",
    route_modules: "scheduler",
    route_source_kinds: "",
    route_event_kinds: "incident_opened, incident_escalated, scheduler_run",
    min_occurrences: "1",
    min_age_minutes: "0",
    message_template: "",
    payload_template: "",
    sign_payload: "false",
    signature_header: "X-Scheduler-Signature",
    signing_secret: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const auditParams = new URLSearchParams();
      if (auditFilters?.query) auditParams.set("query", String(auditFilters.query));
      if (auditFilters?.action_kind) auditParams.set("action_kind", String(auditFilters.action_kind));
      if (auditFilters?.status) auditParams.set("status", String(auditFilters.status));
      if (auditFilters?.module) auditParams.set("module", String(auditFilters.module));
      if (auditFilters?.days) auditParams.set("days", String(auditFilters.days));
      const auditUrl = `/api/ops/scheduler/audit${auditParams.toString() ? `?${auditParams.toString()}` : ""}`;
      const [controlRes, supervisionRes, auditRes] = await Promise.all([
        rawApi("/api/ops/scheduler/control"),
        rawApi("/api/ops/scheduler/supervision"),
        rawApi(auditUrl),
      ]);
      const controlData = await controlRes.json().catch(() => null);
      const supervisionData = await supervisionRes.json().catch(() => null);
      const auditData = await auditRes.json().catch(() => null);
      if (!controlRes.ok) throw controlData || new Error("Planification indisponible.");
      setPayload(controlData || null);
      setOpsBoard(supervisionRes.ok ? supervisionData || null : null);
      setAuditBoard(auditRes.ok ? auditData || null : null);
    } catch (err) {
      setPayload(null);
      setOpsBoard(null);
      setAuditBoard(null);
      setError(formatApiError(err, "Impossible de charger le scheduler & orchestration."));
    } finally {
      setLoading(false);
    }
  }, [auditFilters]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    if (!jobs.length) return;
    setIntervalDrafts((prev) => {
      const next = { ...prev };
      for (const job of jobs) {
        const key = String(job?.key || "");
        if (!key) continue;
        if (prev[key] == null || prev[key] === "") next[key] = String(job?.interval_minutes || 60);
      }
      return next;
    });
  }, [payload]);

  useEffect(() => {
    const policies = Array.isArray(opsBoard?.policies) ? opsBoard.policies : [];
    if (!policies.length) return;
    setPolicyDrafts((prev) => {
      const next = { ...prev };
      for (const policy of policies) {
        const key = String(policy?.key || "");
        if (!key || next[key]) continue;
        next[key] = {
          max_attempts: String(policy?.max_attempts ?? 2),
          backoff_minutes: String(policy?.backoff_minutes ?? 30),
          pause_after_failures: String(policy?.pause_after_failures ?? 3),
          alert_on_error: String(Boolean(policy?.alert_on_error)),
          note: String(policy?.note || ""),
        };
      }
      return next;
    });
  }, [opsBoard]);

  useEffect(() => {
    const channels = Array.isArray(opsBoard?.channels) ? opsBoard.channels : [];
    if (!channels.length) return;
    setChannelDrafts((prev) => {
      const next = { ...prev };
      for (const channel of channels) {
        const key = String(channel?.id || "");
        if (!key || next[key]) continue;
        next[key] = {
          min_severity: String(channel?.min_severity || "high"),
          mention: String(channel?.mention || ""),
          include_digest: String(Boolean(channel?.include_digest)),
          digest_min_urgent_count: String(channel?.digest_min_urgent_count ?? 0),
          route_modules: joinCsv(channel?.route_modules),
          route_source_kinds: joinCsv(channel?.route_source_kinds),
          route_event_kinds: joinCsv(channel?.route_event_kinds),
          min_occurrences: String(channel?.min_occurrences ?? 1),
          min_age_minutes: String(channel?.min_age_minutes ?? 0),
          message_template: String(channel?.message_template || ""),
          payload_template: String(channel?.payload_template || ""),
          signature_header: String(channel?.signature_header || "X-Scheduler-Signature"),
        };
      }
      return next;
    });
  }, [opsBoard]);

  const jobs = useMemo(() => (Array.isArray(payload?.jobs) ? payload.jobs : []), [payload?.jobs]);
  const summary = payload?.summary || {};
  const queues = payload?.queues || {};
  const supervision = payload?.supervision || {};
  const heartbeat = supervision?.heartbeat || {};
  const coordinationLock = supervision?.lock || {};
  const incidents = Array.isArray(supervision?.incidents) ? supervision.incidents : [];
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  const policySummary = opsBoard?.policy_summary || {};
  const policies = Array.isArray(opsBoard?.policies) ? opsBoard.policies : [];
  const incidentSummary = opsBoard?.incident_summary || {};
  const incidentJournal = Array.isArray(opsBoard?.incidents) ? opsBoard.incidents : [];
  const alertSummary = opsBoard?.alert_summary || {};
  const alertChannels = useMemo(
    () => (Array.isArray(opsBoard?.channels) ? opsBoard.channels : []),
    [opsBoard?.channels],
  );
  const alertDeliveries = Array.isArray(opsBoard?.recent_deliveries) ? opsBoard.recent_deliveries : [];
  const auditSummary = auditBoard?.summary || opsBoard?.audit_summary || {};
  const auditTrail = useMemo(
    () =>
      Array.isArray(auditBoard?.items)
        ? auditBoard.items
        : Array.isArray(opsBoard?.audit_trail)
          ? opsBoard.audit_trail
          : [],
    [auditBoard?.items, opsBoard?.audit_trail],
  );

  useEffect(() => {
    if (!jobs.length) {
      setExpandedJob(null);
      return;
    }
    setExpandedJob((prev) => {
      if (prev && jobs.some((item: any) => item.key === prev)) return prev;
      return jobs.find((item: any) => item.due_now || item.stale)?.key || String(jobs[0]?.key || "");
    });
  }, [jobs]);

  const dueJobKeys = useMemo(
    () => jobs.filter((item: any) => item.due_now || item.stale).map((item: any) => item.key),
    [jobs],
  );
  const activeJobKeys = useMemo(() => jobs.filter((item: any) => item.active).map((item: any) => item.key), [jobs]);

  const refresh = () => setRefreshNonce((value) => value + 1);

  const buildAuditQueryString = (filters: any = auditFilters, format?: string) => {
    const params = new URLSearchParams();
    if (filters?.query) params.set("query", String(filters.query).trim());
    if (filters?.action_kind) params.set("action_kind", String(filters.action_kind).trim());
    if (filters?.status) params.set("status", String(filters.status).trim());
    if (filters?.module) params.set("module", String(filters.module).trim());
    if (filters?.days) params.set("days", String(filters.days).trim());
    if (format) params.set("format", format);
    return params.toString();
  };

  const applyAuditFilters = () => {
    setAuditFilters({
      query: String(auditDraft.query || "").trim(),
      action_kind: String(auditDraft.action_kind || "").trim(),
      status: String(auditDraft.status || "").trim(),
      module: String(auditDraft.module || "").trim(),
      days: String(auditDraft.days || "30").trim() || "30",
    });
  };

  const resetAuditFilters = () => {
    const reset = { query: "", action_kind: "", status: "", module: "", days: "30" };
    setAuditDraft(reset);
    setAuditFilters(reset);
  };

  const exportAudit = async (format: "csv" | "json") => {
    setBusyKey(`audit-export:${format}`);
    setError(null);
    setNotice(null);
    try {
      const query = buildAuditQueryString(auditFilters, format);
      const res = await rawApi(`/api/ops/scheduler/audit/export${query ? `?${query}` : ""}`);
      if (!res.ok) {
        const raw = await res.json().catch(() => null);
        throw raw || new Error("Export audit indisponible.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = match?.[1] || `scheduler_audit.${format}`;
      downloadBlobFile(blob, filename);
      setNotice(`Audit exporté en ${format.toUpperCase()}.`);
    } catch (err) {
      setError(formatApiError(err, "Impossible d'exporter le journal d'audit."));
    } finally {
      setBusyKey(null);
    }
  };

  const runJobs = async (jobKeys: string[], includePaused = false, label = "Run orchestré terminé.", force = false) => {
    setBusyKey(`run:${jobKeys.join(",") || "all"}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/scheduler/control/run", {
        method: "POST",
        body: JSON.stringify({
          job_keys: jobKeys,
          include_paused: includePaused,
          trigger: "manual",
          force,
          runner_label: "Console pilotage",
        }),
      });
      setPayload(result?.board || null);
      const jobs = Array.isArray(result?.run?.jobs) ? result.run.jobs : [];
      const okCount = jobs.filter((item: any) => String(item?.status || "").toLowerCase() === "ok").length;
      const warnCount = jobs.filter((item: any) =>
        ["warn", "error"].includes(String(item?.status || "").toLowerCase()),
      ).length;
      setNotice(`${label} ${okCount} job(s) sain(s) · ${warnCount} à surveiller.`);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'exécuter ce run scheduler."));
    } finally {
      setBusyKey(null);
    }
  };

  const pingHeartbeat = async () => {
    setBusyKey("heartbeat");
    setError(null);
    setNotice(null);
    try {
      const data: any = await api("/api/ops/scheduler/control/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          source: "console",
          runner_label: "Console pilotage",
          note: "Heartbeat manuel envoyé depuis la console.",
        }),
      });
      setPayload(data || null);
      setNotice("Heartbeat console enregistré.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'envoyer le heartbeat scheduler."));
    } finally {
      setBusyKey(null);
    }
  };

  const unlockScheduler = async () => {
    setBusyKey("unlock");
    setError(null);
    setNotice(null);
    try {
      const data: any = await api("/api/ops/scheduler/control/unlock", {
        method: "POST",
        body: JSON.stringify({ reason: "Déverrouillage manuel depuis la console de supervision." }),
      });
      setPayload(data || null);
      setNotice("Verrou scheduler libéré.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de déverrouiller le scheduler."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchJob = async (job: any, body: any, successLabel: string) => {
    setBusyKey(`patch:${job.key}`);
    setError(null);
    setNotice(null);
    try {
      const updated: any = await api(`/api/ops/scheduler/control/jobs/${job.key}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setPayload((prev: any) => {
        if (!prev) return prev;
        const jobs = Array.isArray(prev.jobs) ? prev.jobs : [];
        return { ...prev, jobs: jobs.map((item: any) => (item.key === updated.key ? updated : item)) };
      });
      setNotice(successLabel);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour ce job scheduler."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchPolicy = async (jobKey: string, successLabel = "Politique de retry mise à jour.") => {
    const draft = policyDrafts[jobKey] || {};
    setBusyKey(`policy:${jobKey}`);
    setError(null);
    setNotice(null);
    try {
      const updated: any = await api(`/api/ops/scheduler/policies/${jobKey}`, {
        method: "PATCH",
        body: JSON.stringify({
          max_attempts: Number(draft.max_attempts || 0),
          backoff_minutes: Number(draft.backoff_minutes || 30),
          pause_after_failures: Number(draft.pause_after_failures || 3),
          alert_on_error: String(draft.alert_on_error) === "true",
          note: String(draft.note || "").trim() || null,
        }),
      });
      setOpsBoard((prev: any) => {
        if (!prev) return prev;
        const items = Array.isArray(prev.policies) ? prev.policies : [];
        return { ...prev, policies: items.map((item: any) => (item.key === updated.key ? updated : item)) };
      });
      setNotice(successLabel);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour cette politique de retry."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchIncident = async (incidentId: string, body: any, successLabel: string) => {
    setBusyKey(`incident:${incidentId}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/ops/scheduler/incidents/${incidentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...body,
          scope: incidentActionScope,
          action_reason: String(incidentActionReason || "").trim() || null,
        }),
      });
      const appliedCount = Number(result?.applied_count || 1);
      setNotice(`${successLabel}${appliedCount > 1 ? ` · ${appliedCount} signal(s) mis à jour.` : ""}`);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour cet incident."));
    } finally {
      setBusyKey(null);
    }
  };

  const previewAlertChannel = async (source: "new" | string = "new") => {
    const draft = source === "new" ? channelForm : channelDrafts[source] || {};
    const channelMeta = source === "new" ? null : alertChannels.find((item: any) => item.id === source);
    const label =
      source === "new" ? String(channelForm.label || "Preview channel") : String(channelMeta?.label || "Canal externe");
    const kind = source === "new" ? String(channelForm.kind || "webhook") : String(channelMeta?.kind || "webhook");
    const mention = source === "new" ? String(channelForm.mention || "") : String(draft.mention || "");
    const signatureHeader =
      source === "new"
        ? String(channelForm.signature_header || "X-Scheduler-Signature")
        : String(draft.signature_header || channelMeta?.signature_header || "X-Scheduler-Signature");
    setBusyKey(`channel-preview:${source}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api("/api/ops/scheduler/alert-channels/preview", {
        method: "POST",
        body: JSON.stringify({
          kind,
          label,
          mention: mention.trim() || null,
          event_kind: "incident_escalated",
          severity:
            source === "new" ? String(channelForm.min_severity || "high") : String(draft.min_severity || "high"),
          title: "Incident critique scheduler",
          message: "Le scheduler nécessite une vérification opérateur avant le prochain lot.",
          payload: {
            event: "scheduler_incident",
            module: "scheduler",
            source_kind: "scheduler_lock",
            incident_type: "scheduler_lock",
            issue_key: "lock:stale",
            href: "/app/scheduler",
            occurrences: Number(source === "new" ? channelForm.min_occurrences || 2 : draft.min_occurrences || 2),
            age_minutes: Number(source === "new" ? channelForm.min_age_minutes || 45 : draft.min_age_minutes || 45),
            title: "Verrou scheduler bloqué",
            description: "Le verrou est resté actif au-delà de sa fenêtre normale.",
          },
          message_template: String(draft.message_template || "").trim() || null,
          payload_template: String(draft.payload_template || "").trim() || null,
          sign_payload:
            source === "new"
              ? String(channelForm.sign_payload) === "true"
              : Boolean(channelMeta?.signature_enabled || channelMeta?.has_signing_secret),
          signature_header: signatureHeader,
          signing_secret:
            source === "new"
              ? String(channelForm.signing_secret || "").trim() || null
              : channelMeta?.has_signing_secret
                ? "preview-secret"
                : null,
        }),
      });
      setChannelPreview({ ...(result || {}), source });
      setNotice("Aperçu des données généré.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de générer l’aperçu de ce canal."));
    } finally {
      setBusyKey(null);
    }
  };

  const createAlertChannel = async () => {
    setBusyKey("channel:create");
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/scheduler/alert-channels`, {
        method: "POST",
        body: JSON.stringify({
          kind: channelForm.kind,
          label: channelForm.label,
          url: channelForm.url,
          min_severity: channelForm.min_severity,
          mention: String(channelForm.mention || "").trim() || null,
          enabled: true,
          include_digest: String(channelForm.include_digest) === "true",
          digest_min_urgent_count: Number(channelForm.digest_min_urgent_count || 0),
          route_modules: splitCsv(channelForm.route_modules),
          route_source_kinds: splitCsv(channelForm.route_source_kinds),
          route_event_kinds: splitCsv(channelForm.route_event_kinds),
          min_occurrences: Number(channelForm.min_occurrences || 1),
          min_age_minutes: Number(channelForm.min_age_minutes || 0),
          message_template: String(channelForm.message_template || "").trim() || null,
          payload_template: String(channelForm.payload_template || "").trim() || null,
          sign_payload: String(channelForm.sign_payload) === "true",
          signature_header: String(channelForm.signature_header || "").trim() || "X-Scheduler-Signature",
          signing_secret: String(channelForm.signing_secret || "").trim() || null,
        }),
      });
      setChannelPreview(null);
      setChannelForm({
        kind: "webhook",
        label: "",
        url: "",
        min_severity: "high",
        mention: "",
        include_digest: "false",
        digest_min_urgent_count: "0",
        route_modules: "scheduler",
        route_source_kinds: "",
        route_event_kinds: "incident_opened, incident_escalated, scheduler_run",
        min_occurrences: "1",
        min_age_minutes: "0",
        message_template: "",
        payload_template: "",
        sign_payload: "false",
        signature_header: "X-Scheduler-Signature",
        signing_secret: "",
      });
      setNotice("Canal externe ajouté.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ajouter ce canal externe."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchAlertChannel = async (channelId: string, body: any, successLabel: string) => {
    setBusyKey(`channel:${channelId}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/scheduler/alert-channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setNotice(successLabel);
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour ce canal externe."));
    } finally {
      setBusyKey(null);
    }
  };

  const testAlertChannel = async (channelId: string) => {
    setBusyKey(`channel-test:${channelId}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/ops/scheduler/alert-channels/${channelId}/test`, { method: "POST" });
      if (result?.board) setOpsBoard(result.board);
      const delivery = result?.delivery || null;
      setNotice(
        delivery?.status === "ok"
          ? "Test canal envoyé."
          : sanitizeUserFacingApiMessage(
              delivery?.error,
              400,
              "Le test du canal n'a pas abouti. Vérifiez sa configuration puis réessayez.",
            ),
      );
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de tester ce canal externe."));
    } finally {
      setBusyKey(null);
    }
  };

  const saveChannelDraft = async (channelId: string) => {
    const draft = channelDrafts[channelId] || {};
    setBusyKey(`channel-save:${channelId}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/scheduler/alert-channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({
          min_severity: draft.min_severity,
          mention: String(draft.mention || "").trim() || null,
          include_digest: String(draft.include_digest) === "true",
          digest_min_urgent_count: Number(draft.digest_min_urgent_count || 0),
          route_modules: splitCsv(draft.route_modules),
          route_source_kinds: splitCsv(draft.route_source_kinds),
          route_event_kinds: splitCsv(draft.route_event_kinds),
          min_occurrences: Number(draft.min_occurrences || 1),
          min_age_minutes: Number(draft.min_age_minutes || 0),
          message_template: String(draft.message_template || "").trim() || null,
          payload_template: String(draft.payload_template || "").trim() || null,
        }),
      });
      setNotice("Canal mis à jour.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer ce routage."));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteAlertChannel = async (channel: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Supprimer le canal ${channel?.label || "externe"} ?`)) return;
    setBusyKey(`channel-delete:${channel.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/scheduler/alert-channels/${channel.id}`, { method: "DELETE" });
      setNotice("Canal externe supprimé.");
      refresh();
    } catch (err) {
      setError(formatApiError(err, "Impossible de supprimer ce canal externe."));
    } finally {
      setBusyKey(null);
    }
  };

  const totalBacklog = jobs.reduce((sum: number, job: any) => sum + Number(job?.backlog_count || 0), 0);
  const totalBlocked = jobs.reduce((sum: number, job: any) => sum + Number(job?.blocked_count || 0), 0);
  const openIncidentCount = Number(incidentSummary?.open_count || 0);
  const filteredAuditCount = Number(auditSummary?.filtered_count || auditTrail.length || 0);
  const schedulerWarnings = [...incidents, ...warnings];
  const notificationQueueCount = Number(alertSummary?.delivery_queue_count || summary.queue_pressure || 0);
  const highlightedIncident =
    incidentJournal.find((item: any) => String(item?.status || "").toLowerCase() === "open") || null;
  const secondaryIncidents = incidentJournal.filter((item: any) => item?.id !== highlightedIncident?.id);
  const pageJobs = useMemo(() => paginateList(jobs, jobsPage, jobsPageSize), [jobs, jobsPage, jobsPageSize]);
  const pageSecondaryIncidents = useMemo(
    () => paginateList(secondaryIncidents, incidentsPage, incidentsPageSize),
    [incidentsPage, incidentsPageSize, secondaryIncidents],
  );
  const pageAlertChannels = useMemo(
    () => paginateList(alertChannels, channelsPage, channelsPageSize),
    [alertChannels, channelsPage, channelsPageSize],
  );
  const pageAuditTrail = useMemo(
    () => paginateList(auditTrail, auditPage, auditPageSize),
    [auditPage, auditPageSize, auditTrail],
  );

  useEffect(() => {
    if (activeTab === "jobs") setJobsPage(1);
    if (activeTab === "incidents") setIncidentsPage(1);
    if (activeTab === "channels") setChannelsPage(1);
    if (activeTab === "audit") setAuditPage(1);
  }, [activeTab]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditFilters]);
  const bannerTitle = highlightedIncident
    ? `${openIncidentCount} incident${openIncidentCount > 1 ? "s" : ""} ouvert${openIncidentCount > 1 ? "s" : ""} — ${highlightedIncident.title}`
    : openIncidentCount > 0
      ? `${openIncidentCount} incident${openIncidentCount > 1 ? "s" : ""} ouvert${openIncidentCount > 1 ? "s" : ""}`
      : heartbeat?.age_minutes == null || String(heartbeat?.status || "").toLowerCase() === "error"
        ? "Heartbeat absent"
        : null;
  const tabs: Array<{ id: SchedulerTab; label: string; badge?: number }> = [
    { id: "jobs", label: "Jobs", badge: jobs.length },
    { id: "incidents", label: "Incidents", badge: openIncidentCount },
    { id: "channels", label: "Canaux", badge: alertChannels.length },
    { id: "audit", label: "Audit", badge: filteredAuditCount },
  ];
  const fieldClassName =
    "w-full rounded-xl bg-white px-3 py-2.5 text-[#0f172a] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25";
  const fieldStyle = {
    fontSize: "0.875rem",
    border: "1px solid rgba(0,0,0,0.08)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  } as const;

  return (
    <div>
      <AppPageHeader
        title="Planification"
        breadcrumb="Avancé"
        description="Tâches planifiées, incidents, canaux et audit."
        actions={
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <SecondaryButton
              onClick={() => runJobs(dueJobKeys.length ? dueJobKeys : activeJobKeys, false, "Jobs dus exécutés.")}
              disabled={Boolean(busyKey) || (!dueJobKeys.length && !activeJobKeys.length)}
            >
              <Zap className="w-4 h-4 text-[#f59e0b]" /> Exécuter les dus
            </SecondaryButton>
            <PrimaryButton
              onClick={() => runJobs(activeJobKeys, false, "Jobs actifs exécutés.")}
              disabled={Boolean(busyKey) || !activeJobKeys.length}
            >
              <PlayCircle className="w-4 h-4" /> Lancer tous les actifs
            </PrimaryButton>
          </div>
        }
      />

      <div className="w-full space-y-6 p-5 lg:p-7">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

        {loading ? (
          <LoadingCard label="Chargement de la planification…" />
        ) : !payload ? (
          <EmptyCard
            title="Planification indisponible"
            description="Aucune donnée pour le moment."
            action={<SecondaryButton onClick={refresh}>Réessayer</SecondaryButton>}
          />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Jobs actifs"
                value={Number(summary.active_jobs || 0)}
                sub={`${Number(summary.due_jobs || 0)} dus · ${Number(summary.paused_jobs || 0)} pause`}
                accent={Number(summary.due_jobs || 0) > 0 ? "amber" : "amber"}
                icon={<Zap className="w-4 h-4" />}
              />
              <StatCard
                label="Heartbeat"
                value={heartbeat?.age_minutes == null ? "—" : minutesLabel(heartbeat.age_minutes)}
                sub={
                  coordinationLock?.active
                    ? `${heartbeat?.status_label || "Aucun signal"} · verrou`
                    : heartbeat?.status_label || "Aucun signal"
                }
                accent={statAccent(heartbeat?.status)}
                icon={<CheckCircle2 className="w-4 h-4" />}
              />
              <StatCard
                label="Incidents ouverts"
                value={openIncidentCount}
                sub={`${Number(incidentSummary?.critical_open_count || 0)} critiques · ${Number(incidentSummary?.resolved_recent_count || 0)} / 7j`}
                accent={
                  Number(incidentSummary?.critical_open_count || 0) > 0
                    ? "red"
                    : openIncidentCount > 0
                      ? "amber"
                      : "green"
                }
                icon={<AlertTriangle className="w-4 h-4" />}
              />
              <StatCard
                label="Canaux externes"
                value={Number(alertSummary?.enabled_channels || 0)}
                sub={`${Number(alertSummary?.failure_24h_count || 0)} échec(s) / 24h`}
                accent={
                  Number(alertSummary?.failure_24h_count || 0) > 0
                    ? "amber"
                    : Number(alertSummary?.enabled_channels || 0) > 0
                      ? "blue"
                      : "cyan"
                }
                icon={<Webhook className="w-4 h-4" />}
              />
              <StatCard
                label="Alertes"
                value={notificationQueueCount}
                sub={
                  notificationQueueCount > 0
                    ? "Queue"
                    : `${Number(alertSummary?.success_24h_count || alertSummary?.ok_24h_count || 0)} / 24h`
                }
                accent={notificationQueueCount > 0 ? "blue" : "green"}
                icon={<BellRing className="w-4 h-4" />}
              />
            </div>

            {bannerTitle ? (
              <div
                className="flex flex-col gap-3 rounded-2xl bg-white px-4 py-4 sm:flex-row sm:items-start"
                style={{ border: "1px solid #fecaca", boxShadow: "0 0 0 3px #fef2f2" }}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#dc2626]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[#dc2626]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                    {bannerTitle}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab("incidents")}
                      className="rounded-xl bg-[#fef2f2] px-3 py-1.5 text-[#dc2626] transition-colors hover:bg-[#fee2e2]"
                      style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                    >
                      Voir l'incident →
                    </button>
                    <button
                      type="button"
                      onClick={refresh}
                      className="rounded-xl bg-white px-3 py-1.5 text-[#475569] transition-colors hover:bg-[#f8fafc]"
                      style={{ fontSize: "0.8125rem", fontWeight: 600, border: "1px solid #e2e8f0" }}
                    >
                      Rafraîchir
                    </button>
                    <button
                      type="button"
                      onClick={() => void pingHeartbeat()}
                      className="rounded-xl bg-white px-3 py-1.5 text-[#475569] transition-colors hover:bg-[#f8fafc]"
                      style={{ fontSize: "0.8125rem", fontWeight: 600, border: "1px solid #e2e8f0" }}
                    >
                      Heartbeat console
                    </button>
                    {coordinationLock?.active ? (
                      <button
                        type="button"
                        onClick={() => void unlockScheduler()}
                        className="rounded-xl bg-white px-3 py-1.5 text-[#475569] transition-colors hover:bg-[#f8fafc]"
                        style={{ fontSize: "0.8125rem", fontWeight: 600, border: "1px solid #e2e8f0" }}
                      >
                        Libérer le verrou
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            <OpsPanelShell
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(tab) => setActiveTab(tab)}
              headerActions={
                activeTab === "channels" ? (
                  showChannelComposer ? (
                    <SecondaryButton onClick={() => setShowChannelComposer(false)}>
                      <ChevronRight className="h-4 w-4 rotate-90" />
                      Fermer
                    </SecondaryButton>
                  ) : (
                    <PrimaryButton onClick={() => setShowChannelComposer(true)}>
                      <Plus className="w-4 h-4" /> Nouveau canal
                    </PrimaryButton>
                  )
                ) : undefined
              }
            >
              {activeTab === "jobs" ? (
                <div className="space-y-2">
                  {jobs.length === 0 ? (
                    <OpsEmptyState
                      icon={<Bot className="h-5 w-5" />}
                      title="Aucun job"
                      description="Les jobs apparaîtront ici."
                    />
                  ) : (
                    pageJobs.map((job: any) => {
                      const isOpen = expandedJob === job.key;
                      const intervalValue = intervalDrafts[job.key] ?? String(job.interval_minutes || 60);
                      const dirty = String(intervalValue) !== String(job.interval_minutes || 60);
                      const policy = policies.find((item: any) => item.key === job.key) || null;
                      const policyDraft = policyDrafts[job.key] || {
                        max_attempts: String(policy?.max_attempts ?? 2),
                        backoff_minutes: String(policy?.backoff_minutes ?? 30),
                        pause_after_failures: String(policy?.pause_after_failures ?? 3),
                        alert_on_error: String(Boolean(policy?.alert_on_error)),
                        note: String(policy?.note || ""),
                      };
                      const policyDirty = policy
                        ? String(policyDraft.max_attempts) !== String(policy.max_attempts) ||
                          String(policyDraft.backoff_minutes) !== String(policy.backoff_minutes) ||
                          String(policyDraft.pause_after_failures) !== String(policy.pause_after_failures) ||
                          String(policyDraft.alert_on_error) !== String(Boolean(policy.alert_on_error)) ||
                          String(policyDraft.note || "") !== String(policy.note || "")
                        : false;
                      const infoLines = [
                        `${Number(job.due_count || 0)} dus · backlog ${Number(job.backlog_count || 0)} · ${Number(job.blocked_count || 0)} blocage(s).`,
                        `${job.module_label || job.module || "Module"} · prochain ${formatDateTimeFr(job.next_run_at, "—")}.`,
                      ];
                      return (
                        <div
                          key={job.key}
                          className="overflow-hidden rounded-2xl transition-all"
                          style={{
                            border: `1px solid ${isOpen ? "#bfdbfe" : "#e9eef4"}`,
                            boxShadow: isOpen ? "0 0 0 3px #eff6ff" : "none",
                          }}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => setExpandedJob(isOpen ? null : job.key)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setExpandedJob(isOpen ? null : job.key);
                              }
                            }}
                            className="flex cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[#fafbfd]"
                          >
                            <ChevronRight
                              className={`h-4 w-4 flex-shrink-0 text-[#94a3b8] transition-transform ${isOpen ? "rotate-90" : ""}`}
                            />
                            <span
                              className="h-2 w-2 flex-shrink-0 rounded-full"
                              style={{
                                background: job.stale
                                  ? "#ef4444"
                                  : job.due_now
                                    ? "#f59e0b"
                                    : job.active
                                      ? "#3b82f6"
                                      : "#cbd5e1",
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                                {job.label}
                              </p>
                              <p className="truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                {job.description}
                              </p>
                            </div>
                            <div className="hidden xl:flex items-center gap-1.5">
                              <SchedTag
                                color={job.active ? "blue" : "muted"}
                                label={job.active ? "Actif" : "En pause"}
                              />
                              {job.due_now ? (
                                <SchedTag
                                  color={job.stale ? "red" : "amber"}
                                  label={job.stale ? "En retard" : "Dû maintenant"}
                                />
                              ) : null}
                              {policy?.retry_due_now ? <SchedTag color="orange" label="Retry dû" /> : null}
                            </div>
                            <div className="hidden px-3 text-center lg:block">
                              <p className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                                {job.interval_minutes || 60}
                                <span className="text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 400 }}>
                                  min
                                </span>
                              </p>
                              <p className="text-[#94a3b8]" style={{ fontSize: "0.625rem" }}>
                                cadence
                              </p>
                            </div>
                            <div className="hidden px-3 text-center lg:block">
                              <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                                {formatDateTimeFr(job.last_run_at, "Jamais")}
                              </p>
                              <p className="text-[#94a3b8]" style={{ fontSize: "0.625rem" }}>
                                dernier run
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void runJobs([job.key], !job.active, `${job.label} exécuté.`);
                              }}
                              disabled={Boolean(busyKey)}
                              className="flex flex-shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-white disabled:opacity-60"
                              style={{
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                                boxShadow: "0 2px 6px rgba(29,78,216,0.3)",
                              }}
                            >
                              <Zap className="h-3 w-3" /> Exécuter
                            </button>
                          </div>

                          {isOpen ? (
                            <div style={{ borderTop: "1px solid #eff6ff" }}>
                              {infoLines.map((line, index) => (
                                <div
                                  key={`${job.key}-info-${index}`}
                                  className="flex items-center gap-2 px-5 py-2"
                                  style={{ background: "#fafbfd", borderBottom: "1px solid #f1f5f9" }}
                                >
                                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#cbd5e1]" />
                                  <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                    {line}
                                  </p>
                                </div>
                              ))}
                              <div className="grid gap-5 px-5 py-5 lg:grid-cols-2">
                                <div>
                                  <p
                                    className="mb-3 text-[#374151]"
                                    style={{
                                      fontSize: "0.75rem",
                                      fontWeight: 700,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.05em",
                                    }}
                                  >
                                    Configuration
                                  </p>
                                  <div className="flex flex-wrap items-end gap-3">
                                    <div>
                                      <label
                                        className="mb-1 block text-[#374151]"
                                        style={{ fontSize: "0.75rem", fontWeight: 500 }}
                                      >
                                        Cadence (min)
                                      </label>
                                      <input
                                        type="number"
                                        min={15}
                                        max={1440}
                                        value={intervalValue}
                                        onChange={(event) =>
                                          setIntervalDrafts((prev) => ({ ...prev, [job.key]: event.target.value }))
                                        }
                                        className="rounded-xl bg-white px-2.5 py-2 text-[#374151] outline-none"
                                        style={{ ...fieldStyle, width: "6rem", fontSize: "0.8125rem" }}
                                      />
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        patchJob(
                                          job,
                                          { active: !job.active },
                                          job.active ? "Job mis en pause." : "Job réactivé.",
                                        )
                                      }
                                      disabled={Boolean(busyKey)}
                                      className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-[#475569] disabled:opacity-60"
                                      style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                                    >
                                      {job.active ? (
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                      ) : (
                                        <Zap className="h-3.5 w-3.5" />
                                      )}
                                      {job.active ? "Mettre en pause" : "Réactiver"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        patchJob(
                                          job,
                                          { interval_minutes: Number(intervalValue || job.interval_minutes || 60) },
                                          "Cadence mise à jour.",
                                        )
                                      }
                                      disabled={Boolean(busyKey) || !dirty}
                                      className="flex items-center gap-1 rounded-xl bg-white px-2.5 py-2 text-[#94a3b8] disabled:opacity-50"
                                      style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                                    >
                                      <CalendarClock className="h-3.5 w-3.5" /> Sauvegarder
                                    </button>
                                    <Link
                                      to={job.href}
                                      onClick={(event) => event.stopPropagation()}
                                      className="flex items-center gap-1 rounded-xl bg-white px-3 py-2 text-[#475569]"
                                      style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                                    >
                                      <ArrowRight className="h-3.5 w-3.5" /> Ouvrir
                                    </Link>
                                  </div>
                                </div>
                                <div
                                  className="rounded-xl p-4"
                                  style={{ background: "#fffbeb", borderLeft: "3px solid #f59e0b" }}
                                >
                                  <div className="mb-2 flex items-center justify-between gap-2">
                                    <p
                                      className="text-[#92400e]"
                                      style={{ fontSize: "0.6875rem", fontWeight: 700, textTransform: "uppercase" }}
                                    >
                                      Politique de retry
                                    </p>
                                    <span className="text-[#b45309]" style={{ fontSize: "0.6875rem" }}>
                                      Retry {formatDateTimeFr(policy?.next_retry_at, "—")}
                                    </span>
                                  </div>
                                  {policy ? (
                                    <>
                                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {[
                                          { label: "Max retries", value: policyDraft.max_attempts || "0" },
                                          { label: "Backoff", value: `${policyDraft.backoff_minutes || "0"} min` },
                                          { label: "Pause après", value: policyDraft.pause_after_failures || "0" },
                                          {
                                            label: "Alerter",
                                            value: policyDraft.alert_on_error === "true" ? "Oui" : "Non",
                                          },
                                        ].map((item) => (
                                          <div key={item.label}>
                                            <p
                                              className="mb-1 text-[#374151]"
                                              style={{
                                                fontSize: "0.5625rem",
                                                fontWeight: 600,
                                                textTransform: "uppercase",
                                              }}
                                            >
                                              {item.label}
                                            </p>
                                            <div
                                              className="rounded-lg bg-white px-2 py-1.5 text-center"
                                              style={{
                                                fontSize: "0.8125rem",
                                                fontWeight: 700,
                                                color: "#0f172a",
                                                border: "1px solid #e2e8f0",
                                              }}
                                            >
                                              {item.value}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                        <input
                                          value={policyDraft.max_attempts}
                                          onChange={(event) =>
                                            setPolicyDrafts((prev) => ({
                                              ...prev,
                                              [job.key]: { ...policyDraft, max_attempts: event.target.value },
                                            }))
                                          }
                                          className={fieldClassName}
                                          style={{ ...fieldStyle, fontSize: "0.75rem" }}
                                          type="number"
                                          min={0}
                                          max={8}
                                          placeholder="Max retries"
                                        />
                                        <input
                                          value={policyDraft.backoff_minutes}
                                          onChange={(event) =>
                                            setPolicyDrafts((prev) => ({
                                              ...prev,
                                              [job.key]: { ...policyDraft, backoff_minutes: event.target.value },
                                            }))
                                          }
                                          className={fieldClassName}
                                          style={{ ...fieldStyle, fontSize: "0.75rem" }}
                                          type="number"
                                          min={5}
                                          max={1440}
                                          placeholder="Backoff (min)"
                                        />
                                        <input
                                          value={policyDraft.pause_after_failures}
                                          onChange={(event) =>
                                            setPolicyDrafts((prev) => ({
                                              ...prev,
                                              [job.key]: { ...policyDraft, pause_after_failures: event.target.value },
                                            }))
                                          }
                                          className={fieldClassName}
                                          style={{ ...fieldStyle, fontSize: "0.75rem" }}
                                          type="number"
                                          min={1}
                                          max={12}
                                          placeholder="Pause après"
                                        />
                                        <select
                                          value={policyDraft.alert_on_error}
                                          onChange={(event) =>
                                            setPolicyDrafts((prev) => ({
                                              ...prev,
                                              [job.key]: { ...policyDraft, alert_on_error: event.target.value },
                                            }))
                                          }
                                          className={fieldClassName}
                                          style={{ ...fieldStyle, fontSize: "0.75rem" }}
                                        >
                                          <option value="true">Alerte externe</option>
                                          <option value="false">Sans alerte</option>
                                        </select>
                                      </div>
                                      <textarea
                                        value={policyDraft.note}
                                        onChange={(event) =>
                                          setPolicyDrafts((prev) => ({
                                            ...prev,
                                            [job.key]: { ...policyDraft, note: event.target.value },
                                          }))
                                        }
                                        className={`${fieldClassName} mt-3 resize-none`}
                                        style={{
                                          ...fieldStyle,
                                          minHeight: "72px",
                                          fontSize: "0.75rem",
                                          lineHeight: 1.5,
                                        }}
                                        placeholder="Note opérateur"
                                      />
                                      <div className="mt-3 flex justify-end">
                                        <button
                                          type="button"
                                          onClick={() => patchPolicy(job.key)}
                                          disabled={Boolean(busyKey) || !policyDirty}
                                          className="rounded-xl bg-white px-3 py-2 text-[#475569] disabled:opacity-50"
                                          style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                                        >
                                          Enregistrer
                                        </button>
                                      </div>
                                    </>
                                  ) : (
                                    <p className="text-[#92400e]" style={{ fontSize: "0.8125rem" }}>
                                      Aucune politique dédiée pour ce job.
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                  <ListPagination
                    page={jobsPage}
                    totalItems={jobs.length}
                    pageSize={jobsPageSize}
                    pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                    itemLabel="job"
                    onPageChange={setJobsPage}
                    onPageSizeChange={(nextPageSize) => {
                      setJobsPage(1);
                      setJobsPageSize(nextPageSize);
                    }}
                    pageSizeAriaLabel="Jobs par page"
                    className="rounded-xl border border-[#f1f5f9]"
                  />
                </div>
              ) : null}

              {activeTab === "incidents" ? (
                <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
                  <div>
                    <div className="mb-5 grid grid-cols-3 gap-2 md:grid-cols-6">
                      {[
                        { label: "OUVERTS", value: openIncidentCount },
                        { label: "CRITIQUES", value: Number(incidentSummary?.critical_open_count || 0) },
                        { label: "HIGH", value: Number(incidentSummary?.high_open_count || 0) },
                        { label: "ACK", value: Number(incidentSummary?.acknowledged_count || 0) },
                        { label: "SNOOZE", value: Number(incidentSummary?.snoozed_count || 0) },
                        { label: "RÉSOLUS 7J", value: Number(incidentSummary?.resolved_recent_count || 0) },
                      ].map((stat) => (
                        <div
                          key={stat.label}
                          className="rounded-xl p-3 text-center"
                          style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                        >
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.4375rem",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {stat.label}
                          </p>
                          <p className="text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 800 }}>
                            {stat.value}
                          </p>
                        </div>
                      ))}
                    </div>

                    {highlightedIncident ? (
                      <div className="rounded-2xl p-5" style={{ border: "1px solid #fecaca", background: "#fffafa" }}>
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <SchedTag
                            color={severityTone(highlightedIncident.severity) === "danger" ? "red" : "amber"}
                            label={highlightedIncident.severity_label || highlightedIncident.severity || "Signal"}
                          />
                          <SchedTag
                            color={
                              String(highlightedIncident.status || "").toLowerCase() === "resolved" ? "green" : "blue"
                            }
                            label={
                              String(highlightedIncident.status || "").toLowerCase() === "resolved"
                                ? "Résolu"
                                : "Ouvert"
                            }
                          />
                          <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                            {Number(highlightedIncident.occurrences || 1)} occurrence(s)
                          </span>
                          <div className="ml-auto flex items-center gap-2">
                            <Link
                              to={highlightedIncident.href || "/app/scheduler"}
                              className="text-[#1d4ed8]"
                              style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                            >
                              Ouvrir
                            </Link>
                            <button
                              type="button"
                              onClick={() =>
                                patchIncident(
                                  highlightedIncident.id,
                                  { acknowledged: !highlightedIncident.acknowledged },
                                  highlightedIncident.acknowledged ? "Incident repassé non ack." : "Incident ack.",
                                )
                              }
                              disabled={Boolean(busyKey)}
                              className="rounded-xl bg-white px-3 py-1.5 text-[#475569] disabled:opacity-50"
                              style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                            >
                              {highlightedIncident.acknowledged ? "Retirer ack" : "Ack"}
                            </button>
                          </div>
                        </div>
                        <p className="mb-1 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                          {highlightedIncident.title}
                        </p>
                        <p className="mb-3 text-[#374151]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                          {highlightedIncident.description}
                        </p>
                        <p className="mb-4 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                          Vu {formatDateTimeFr(highlightedIncident.last_seen_at, "—")} · premier signal{" "}
                          {formatDateTimeFr(highlightedIncident.first_seen_at, "—")}
                        </p>

                        <div className="grid gap-3 border-t border-[#f1f5f9] pt-3 md:grid-cols-2">
                          <div>
                            <label
                              className="mb-1 block text-[#374151]"
                              style={{ fontSize: "0.75rem", fontWeight: 500 }}
                            >
                              Portée action
                            </label>
                            <select
                              value={incidentActionScope}
                              onChange={(event) => setIncidentActionScope(event.target.value)}
                              className={fieldClassName}
                              style={{ ...fieldStyle, fontSize: "0.75rem" }}
                            >
                              <option value="single">Incident seulement</option>
                              <option value="same_severity">Même gravité</option>
                              <option value="same_module">Même module</option>
                              <option value="all_open">Tous les incidents</option>
                            </select>
                          </div>
                          <div>
                            <label
                              className="mb-1 block text-[#374151]"
                              style={{ fontSize: "0.75rem", fontWeight: 500 }}
                            >
                              Motif opérateur
                            </label>
                            <input
                              value={incidentActionReason}
                              onChange={(event) => setIncidentActionReason(event.target.value)}
                              placeholder="Ex. acké par l'équipe ops…"
                              className={fieldClassName}
                              style={{ ...fieldStyle, fontSize: "0.75rem" }}
                            />
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              patchIncident(highlightedIncident.id, { snooze_hours: 4 }, "Incident snoozé 4h.")
                            }
                            disabled={Boolean(busyKey)}
                            className="rounded-xl bg-white px-3 py-1.5 text-[#475569] disabled:opacity-50"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            Snooze 4h
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              patchIncident(highlightedIncident.id, { snooze_hours: 24 }, "Incident snoozé 24h.")
                            }
                            disabled={Boolean(busyKey)}
                            className="rounded-xl bg-white px-3 py-1.5 text-[#475569] disabled:opacity-50"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            Snooze 24h
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              patchIncident(highlightedIncident.id, { clear_snooze: true }, "Snooze retiré.")
                            }
                            disabled={Boolean(busyKey)}
                            className="rounded-xl bg-white px-3 py-1.5 text-[#475569] disabled:opacity-50"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            Réactiver
                          </button>
                        </div>
                      </div>
                    ) : (
                      <OpsEmptyState
                        icon={<AlertTriangle className="h-5 w-5" />}
                        title="Aucun incident"
                        description="Les incidents apparaîtront ici."
                      />
                    )}

                    {secondaryIncidents.length ? (
                      <div className="mt-4 space-y-2">
                        {pageSecondaryIncidents.map((incident: any) => (
                          <div
                            key={incident.id}
                            className="rounded-xl border border-[#f1f5f9] px-4 py-3"
                            style={{ background: "#fafbfd" }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <SchedTag
                                color={severityTone(incident.severity) === "danger" ? "red" : "amber"}
                                label={incident.severity_label || incident.severity || "Signal"}
                              />
                              <SchedTag
                                color={String(incident.status || "").toLowerCase() === "resolved" ? "green" : "blue"}
                                label={String(incident.status || "").toLowerCase() === "resolved" ? "Résolu" : "Ouvert"}
                              />
                              <span className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                                {incident.title}
                              </span>
                            </div>
                            <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                              {incident.description}
                            </p>
                          </div>
                        ))}
                        <ListPagination
                          page={incidentsPage}
                          totalItems={secondaryIncidents.length}
                          pageSize={incidentsPageSize}
                          pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                          itemLabel="incident"
                          onPageChange={setIncidentsPage}
                          onPageSizeChange={(nextPageSize) => {
                            setIncidentsPage(1);
                            setIncidentsPageSize(nextPageSize);
                          }}
                          pageSizeAriaLabel="Incidents par page"
                          className="rounded-xl border border-[#f1f5f9]"
                        />
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-3">
                    <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                      Alertes
                    </p>
                    {(schedulerWarnings.length
                      ? schedulerWarnings
                      : [heartbeat?.status_label || "Aucun heartbeat scheduler enregistré pour l'instant."]
                    )
                      .slice(0, 2)
                      .map((message: string, index: number) => (
                        <div
                          key={`${index}-${message}`}
                          className="flex items-start gap-3 rounded-xl p-4"
                          style={{ background: "#fef2f2", border: "1px solid #fecaca" }}
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#dc2626]" />
                          <p className="text-[#dc2626]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                            {message}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {activeTab === "channels" ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
                    {[
                      { label: "CANAUX ACTIFS", value: Number(alertSummary?.enabled_channels || 0) },
                      {
                        label: "DIGEST AUTO",
                        value: Number(alertSummary?.digest_delivery_24h_count || alertSummary?.digest_24h_count || 0),
                      },
                      { label: "ÉCHECS 24H", value: Number(alertSummary?.failure_24h_count || 0) },
                      {
                        label: "OK 24H",
                        value: Number(alertSummary?.success_24h_count || alertSummary?.ok_24h_count || 0),
                      },
                      {
                        label: "DIGEST 24H",
                        value: Number(alertSummary?.digest_delivery_24h_count || alertSummary?.digest_24h_count || 0),
                      },
                      { label: "DERNIER ENVOI", value: formatDateTimeFr(alertSummary?.last_delivery_at, "—") },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-xl p-3 text-center"
                        style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                      >
                        <p
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.4375rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {stat.label}
                        </p>
                        <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 800 }}>
                          {stat.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  {showChannelComposer ? (
                    <div className="mx-auto max-w-[860px] space-y-4">
                      <div className="rounded-2xl border border-[#e2e8f0] bg-[#fcfdff] p-5">
                        <div className="mb-4 flex items-center gap-2">
                          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#eff6ff]">
                            <Plus className="h-4 w-4 text-[#1d4ed8]" />
                          </div>
                          <div>
                            <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                              Nouveau canal externe
                            </div>
                            <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                              Le formulaire s&apos;ouvre ici, au centre.
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label
                                className="mb-1.5 block text-[#374151]"
                                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                              >
                                Type
                              </label>
                              <select
                                className={fieldClassName}
                                style={fieldStyle}
                                value={channelForm.kind}
                                onChange={(event) =>
                                  setChannelForm((prev: any) => ({ ...prev, kind: event.target.value }))
                                }
                              >
                                <option value="webhook">Webhook générique</option>
                                <option value="slack">Slack</option>
                              </select>
                            </div>
                            <InputField
                              label="Label"
                              value={channelForm.label}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, label: event.target.value }))
                              }
                            />
                          </div>
                          <InputField
                            label="URL"
                            value={channelForm.url}
                            onChange={(event) => setChannelForm((prev: any) => ({ ...prev, url: event.target.value }))}
                          />
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label
                                className="mb-1.5 block text-[#374151]"
                                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                              >
                                Seuil mini
                              </label>
                              <select
                                className={fieldClassName}
                                style={fieldStyle}
                                value={channelForm.min_severity}
                                onChange={(event) =>
                                  setChannelForm((prev: any) => ({ ...prev, min_severity: event.target.value }))
                                }
                              >
                                <option value="low">Info</option>
                                <option value="medium">À surveiller</option>
                                <option value="high">Important</option>
                                <option value="critical">Critique</option>
                              </select>
                            </div>
                            <InputField
                              label="Mention"
                              value={channelForm.mention}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, mention: event.target.value }))
                              }
                            />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label
                                className="mb-1.5 block text-[#374151]"
                                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                              >
                                Digest auto
                              </label>
                              <select
                                className={fieldClassName}
                                style={fieldStyle}
                                value={channelForm.include_digest}
                                onChange={(event) =>
                                  setChannelForm((prev: any) => ({ ...prev, include_digest: event.target.value }))
                                }
                              >
                                <option value="false">Non</option>
                                <option value="true">Oui</option>
                              </select>
                            </div>
                            <InputField
                              label="Seuil urgent digest"
                              type="number"
                              min={0}
                              max={50}
                              value={channelForm.digest_min_urgent_count}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({
                                  ...prev,
                                  digest_min_urgent_count: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <InputField
                              label="Modules"
                              value={channelForm.route_modules}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, route_modules: event.target.value }))
                              }
                            />
                            <InputField
                              label="Sources"
                              value={channelForm.route_source_kinds}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, route_source_kinds: event.target.value }))
                              }
                            />
                          </div>
                          <InputField
                            label="Events"
                            value={channelForm.route_event_kinds}
                            onChange={(event) =>
                              setChannelForm((prev: any) => ({ ...prev, route_event_kinds: event.target.value }))
                            }
                          />
                          <div className="grid gap-3 md:grid-cols-2">
                            <InputField
                              label="Occurrences mini"
                              type="number"
                              min={1}
                              max={20}
                              value={channelForm.min_occurrences}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, min_occurrences: event.target.value }))
                              }
                            />
                            <InputField
                              label="Âge mini (min)"
                              type="number"
                              min={0}
                              max={10080}
                              value={channelForm.min_age_minutes}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, min_age_minutes: event.target.value }))
                              }
                            />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label
                                className="mb-1.5 block text-[#374151]"
                                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                              >
                                Signer payload
                              </label>
                              <select
                                className={fieldClassName}
                                style={fieldStyle}
                                value={channelForm.sign_payload}
                                onChange={(event) =>
                                  setChannelForm((prev: any) => ({ ...prev, sign_payload: event.target.value }))
                                }
                              >
                                <option value="false">Non</option>
                                <option value="true">Oui</option>
                              </select>
                            </div>
                            <InputField
                              label="Header signature"
                              value={channelForm.signature_header}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, signature_header: event.target.value }))
                              }
                            />
                          </div>
                          <InputField
                            label="Secret signature"
                            type="password"
                            value={channelForm.signing_secret}
                            onChange={(event) =>
                              setChannelForm((prev: any) => ({ ...prev, signing_secret: event.target.value }))
                            }
                          />
                          <div>
                            <label
                              className="mb-1.5 block text-[#374151]"
                              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                            >
                              Message template
                            </label>
                            <textarea
                              className={fieldClassName}
                              style={{ ...fieldStyle, minHeight: "100px", lineHeight: 1.6 }}
                              value={channelForm.message_template}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, message_template: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <label
                              className="mb-1.5 block text-[#374151]"
                              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                            >
                              Payload template
                            </label>
                            <textarea
                              className={`${fieldClassName} font-mono`}
                              style={{ ...fieldStyle, minHeight: "100px", fontSize: "0.75rem", lineHeight: 1.6 }}
                              value={channelForm.payload_template}
                              onChange={(event) =>
                                setChannelForm((prev: any) => ({ ...prev, payload_template: event.target.value }))
                              }
                            />
                          </div>
                          <div className="flex flex-wrap justify-center gap-2">
                            <SecondaryButton
                              onClick={() => previewAlertChannel("new")}
                              disabled={busyKey === "channel-preview:new"}
                            >
                              <Mail className="w-4 h-4" /> Preview
                            </SecondaryButton>
                            <PrimaryButton onClick={createAlertChannel} disabled={busyKey === "channel:create"}>
                              <BellRing className="w-4 h-4" /> {busyKey === "channel:create" ? "Ajout…" : "Ajouter"}
                            </PrimaryButton>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#e2e8f0] bg-[#fcfdff] p-5">
                        <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Preview & dispatch
                        </div>
                        {channelPreview ? (
                          <div className="mt-4 rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-4">
                            <div className="flex flex-wrap gap-2">
                              <StatusPill status="info" label={channelPreview.kind_label || channelPreview.kind} />
                              <StatusPill status="muted" label={channelPreview.template_summary || "Preview"} />
                            </div>
                            <div className="mt-3 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                              {channelPreview.title}
                            </div>
                            <p className="mt-1 text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                              {channelPreview.message}
                            </p>
                            <pre
                              className="mt-3 overflow-x-auto rounded-xl bg-[#0f172a] px-3 py-3 text-[#dbeafe]"
                              style={{ fontSize: "0.6875rem", lineHeight: 1.6 }}
                            >
                              {channelPreview.body_preview_pretty || ""}
                            </pre>
                          </div>
                        ) : (
                          <div
                            className="mt-4 text-center text-[#94a3b8]"
                            style={{ fontSize: "0.75rem", lineHeight: 1.6 }}
                          >
                            Prévisualise un canal avant activation.
                          </div>
                        )}
                        <div className="mt-4 space-y-2">
                          {alertDeliveries.length ? (
                            alertDeliveries.slice(0, 4).map((delivery: any) => (
                              <div key={delivery.id} className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-3">
                                <div className="flex flex-wrap gap-2">
                                  <StatusPill
                                    status={toneFor(delivery.status)}
                                    label={delivery.status_label || delivery.status}
                                  />
                                  <StatusPill
                                    status={severityTone(delivery.severity)}
                                    label={delivery.severity || "signal"}
                                  />
                                  {delivery.test ? <StatusPill status="purple" label="Test" /> : null}
                                </div>
                                <div className="mt-2 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                                  {delivery.title}
                                </div>
                                <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                  {delivery.channel_label} · {delivery.kind} ·{" "}
                                  {formatDateTimeFr(delivery.attempted_at, "—")}
                                </p>
                                {delivery.error ? (
                                  <p className="mt-1 text-[#b91c1c]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                    {sanitizeUserFacingApiMessage(
                                      delivery.error,
                                      400,
                                      "Cette alerte n'a pas pu être envoyée.",
                                    )}
                                  </p>
                                ) : null}
                              </div>
                            ))
                          ) : (
                            <div
                              className="mt-4 text-center text-[#94a3b8]"
                              style={{ fontSize: "0.75rem", lineHeight: 1.6 }}
                            >
                              Aucun dispatch récent.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-4">
                    {alertChannels.length === 0 ? (
                      !showChannelComposer ? (
                        <OpsEmptyState
                          icon={<BellRing className="h-5 w-5" />}
                          title="Aucun canal externe"
                          description="Ajoutez un canal externe."
                        />
                      ) : null
                    ) : (
                      pageAlertChannels.map((channel: any) => {
                        const draft = channelDrafts[channel.id] || {
                          min_severity: String(channel?.min_severity || "high"),
                          mention: String(channel?.mention || ""),
                          include_digest: String(Boolean(channel?.include_digest)),
                          digest_min_urgent_count: String(channel?.digest_min_urgent_count ?? 0),
                          route_modules: joinCsv(channel?.route_modules),
                          route_source_kinds: joinCsv(channel?.route_source_kinds),
                          route_event_kinds: joinCsv(channel?.route_event_kinds),
                          min_occurrences: String(channel?.min_occurrences ?? 1),
                          min_age_minutes: String(channel?.min_age_minutes ?? 0),
                          message_template: String(channel?.message_template || ""),
                          payload_template: String(channel?.payload_template || ""),
                          signature_header: String(channel?.signature_header || "X-Scheduler-Signature"),
                        };
                        return (
                          <div key={channel.id} className="rounded-xl border border-[#e2e8f0] bg-[#fcfdff] p-4">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap gap-2">
                                  <StatusPill
                                    status={channel.enabled ? "info" : "muted"}
                                    label={channel.enabled ? "Actif" : "Pause"}
                                  />
                                  <StatusPill
                                    status={severityTone(channel.min_severity)}
                                    label={channel.min_severity_label || channel.min_severity}
                                  />
                                  <StatusPill status="muted" label={channel.kind_label || channel.kind} />
                                  {channel.include_digest ? <StatusPill status="purple" label="Digest" /> : null}
                                </div>
                                <div className="mt-3 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                                  {channel.label}
                                </div>
                                <p className="mt-1 text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                                  {channel.masked_url}
                                </p>
                                <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                                  {channel.route_summary} · {channel.template_summary}
                                </p>
                                {channel.last_error ? (
                                  <div className="mt-3 inline-flex items-start gap-1.5 rounded-xl border border-[#fecaca] bg-[#fff1f2] px-3 py-2 text-[#b91c1c] text-xs leading-relaxed">
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                                    <span>
                                      {sanitizeUserFacingApiMessage(
                                        channel.last_error,
                                        400,
                                        "Le dernier envoi sur ce canal n'a pas abouti.",
                                      )}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                              <div className="grid min-w-[240px] gap-2 sm:grid-cols-2">
                                <OpsMiniStat
                                  label="Succès"
                                  value={Number(channel.success_count || 0)}
                                  detail="Historique"
                                  accent="green"
                                />
                                <OpsMiniStat
                                  label="Échecs"
                                  value={Number(channel.failure_count || 0)}
                                  detail={formatDateTimeFr(channel.last_test_at, "—")}
                                  accent={Number(channel.failure_count || 0) > 0 ? "red" : "slate"}
                                />
                                <OpsMiniStat
                                  label="Dernière livraison"
                                  value={formatDateTimeFr(channel.last_delivery_at, "—")}
                                  detail="Canal externe"
                                  accent="blue"
                                />
                                <OpsMiniStat
                                  label="Digest"
                                  value={channel.include_digest ? "Oui" : "Non"}
                                  detail={formatDateTimeFr(channel.last_digest_at, "—")}
                                  accent="purple"
                                />
                              </div>
                            </div>

                            <div className="mt-4 grid gap-3 md:grid-cols-2">
                              <div>
                                <label
                                  className="mb-1.5 block text-[#374151]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                                >
                                  Seuil mini
                                </label>
                                <select
                                  className={fieldClassName}
                                  style={fieldStyle}
                                  value={draft.min_severity}
                                  onChange={(event) =>
                                    setChannelDrafts((prev) => ({
                                      ...prev,
                                      [channel.id]: { ...draft, min_severity: event.target.value },
                                    }))
                                  }
                                >
                                  <option value="low">Info</option>
                                  <option value="medium">À surveiller</option>
                                  <option value="high">Important</option>
                                  <option value="critical">Critique</option>
                                </select>
                              </div>
                              <InputField
                                label="Mention"
                                value={draft.mention}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, mention: event.target.value },
                                  }))
                                }
                              />
                              <div>
                                <label
                                  className="mb-1.5 block text-[#374151]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                                >
                                  Digest auto
                                </label>
                                <select
                                  className={fieldClassName}
                                  style={fieldStyle}
                                  value={draft.include_digest}
                                  onChange={(event) =>
                                    setChannelDrafts((prev) => ({
                                      ...prev,
                                      [channel.id]: { ...draft, include_digest: event.target.value },
                                    }))
                                  }
                                >
                                  <option value="false">Non</option>
                                  <option value="true">Oui</option>
                                </select>
                              </div>
                              <InputField
                                label="Seuil urgent digest"
                                type="number"
                                min={0}
                                max={50}
                                value={draft.digest_min_urgent_count}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, digest_min_urgent_count: event.target.value },
                                  }))
                                }
                              />
                              <InputField
                                label="Modules"
                                value={draft.route_modules}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, route_modules: event.target.value },
                                  }))
                                }
                                hint="scheduler, campaigns…"
                              />
                              <InputField
                                label="Sources"
                                value={draft.route_source_kinds}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, route_source_kinds: event.target.value },
                                  }))
                                }
                              />
                              <InputField
                                label="Events"
                                value={draft.route_event_kinds}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, route_event_kinds: event.target.value },
                                  }))
                                }
                              />
                              <InputField
                                label="Occurrences mini"
                                type="number"
                                min={1}
                                max={20}
                                value={draft.min_occurrences}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, min_occurrences: event.target.value },
                                  }))
                                }
                              />
                              <InputField
                                label="Âge mini (min)"
                                type="number"
                                min={0}
                                max={10080}
                                value={draft.min_age_minutes}
                                onChange={(event) =>
                                  setChannelDrafts((prev) => ({
                                    ...prev,
                                    [channel.id]: { ...draft, min_age_minutes: event.target.value },
                                  }))
                                }
                              />
                            </div>

                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <div>
                                <label
                                  className="mb-1.5 block text-[#374151]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                                >
                                  Message template
                                </label>
                                <textarea
                                  className={fieldClassName}
                                  style={{ ...fieldStyle, minHeight: "110px", lineHeight: 1.6 }}
                                  value={draft.message_template}
                                  onChange={(event) =>
                                    setChannelDrafts((prev) => ({
                                      ...prev,
                                      [channel.id]: { ...draft, message_template: event.target.value },
                                    }))
                                  }
                                />
                              </div>
                              <div>
                                <label
                                  className="mb-1.5 block text-[#374151]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                                >
                                  Payload template
                                </label>
                                <textarea
                                  className={`${fieldClassName} font-mono`}
                                  style={{ ...fieldStyle, minHeight: "110px", fontSize: "0.75rem", lineHeight: 1.6 }}
                                  value={draft.payload_template}
                                  onChange={(event) =>
                                    setChannelDrafts((prev) => ({
                                      ...prev,
                                      [channel.id]: { ...draft, payload_template: event.target.value },
                                    }))
                                  }
                                />
                              </div>
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                              <SecondaryButton
                                onClick={() => previewAlertChannel(channel.id)}
                                disabled={busyKey === `channel-preview:${channel.id}`}
                              >
                                <Mail className="w-4 h-4" /> Preview
                              </SecondaryButton>
                              <SecondaryButton
                                onClick={() => testAlertChannel(channel.id)}
                                disabled={busyKey === `channel-test:${channel.id}`}
                              >
                                <TestTube2 className="w-4 h-4" /> Tester
                              </SecondaryButton>
                              <SecondaryButton
                                onClick={() =>
                                  patchAlertChannel(
                                    channel.id,
                                    { enabled: !channel.enabled },
                                    channel.enabled ? "Canal mis en pause." : "Canal réactivé.",
                                  )
                                }
                                disabled={Boolean(busyKey)}
                              >
                                {channel.enabled ? "Mettre en pause" : "Réactiver"}
                              </SecondaryButton>
                              <PrimaryButton
                                onClick={() => saveChannelDraft(channel.id)}
                                disabled={busyKey === `channel-save:${channel.id}`}
                              >
                                <CalendarClock className="w-4 h-4" /> Enregistrer
                              </PrimaryButton>
                              <DangerButton onClick={() => deleteAlertChannel(channel)} disabled={Boolean(busyKey)}>
                                <Trash2 className="w-4 h-4" /> Supprimer
                              </DangerButton>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <ListPagination
                      page={channelsPage}
                      totalItems={alertChannels.length}
                      pageSize={channelsPageSize}
                      pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                      itemLabel="canal"
                      pluralLabel="canaux"
                      onPageChange={setChannelsPage}
                      onPageSizeChange={(nextPageSize) => {
                        setChannelsPage(1);
                        setChannelsPageSize(nextPageSize);
                      }}
                      pageSizeAriaLabel="Canaux par page"
                      className="rounded-xl border border-[#f1f5f9]"
                    />
                  </div>
                </div>
              ) : null}

              {activeTab === "audit" ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
                    {[
                      {
                        label: "Total",
                        value: Number(auditSummary?.total_count || 0),
                        detail: "Runs sur la fenêtre",
                        accent: "slate" as const,
                      },
                      {
                        label: "Filtrées",
                        value: filteredAuditCount,
                        detail: "Après filtres actifs",
                        accent: "blue" as const,
                      },
                      {
                        label: "Dispatch 24h",
                        value: Number(auditSummary?.external_dispatch_24h_count || 0),
                        detail: "Vers les canaux",
                        accent: "purple" as const,
                      },
                      {
                        label: "Actions incidents",
                        value: Number(auditSummary?.incident_actions_7d_count || 0),
                        detail: "Sur 7 jours",
                        accent: "amber" as const,
                      },
                      {
                        label: "Échecs 7j",
                        value: Number(auditSummary?.delivery_failures_7d_count || 0),
                        detail: "Livraisons en erreur",
                        accent: "red" as const,
                      },
                    ].map((stat) => (
                      <OpsMiniStat
                        key={stat.label}
                        label={stat.label}
                        value={stat.value}
                        detail={stat.detail}
                        accent={stat.accent}
                      />
                    ))}
                  </div>

                  <div className="grid gap-5 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                    <div className="rounded-2xl border border-[#eef2f7] bg-[#fcfdff] p-4">
                      <div className="mb-4">
                        <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Filtres audit
                        </p>
                        <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                          Affine les runs et exports visibles.
                        </p>
                      </div>

                      <div className="mb-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Action
                          </label>
                          <select
                            value={auditDraft.action_kind}
                            onChange={(event) =>
                              setAuditDraft((prev: any) => ({ ...prev, action_kind: event.target.value }))
                            }
                            className={fieldClassName}
                            style={{ ...fieldStyle, fontSize: "0.75rem" }}
                          >
                            <option value="">Toutes</option>
                            <option value="heartbeat">Heartbeat</option>
                            <option value="scheduler_run">Run scheduler</option>
                            <option value="incident_ack">Ack incident</option>
                            <option value="incident_snooze">Snooze incident</option>
                            <option value="channel_test">Test canal</option>
                            <option value="channel_update">Mise à jour canal</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Fenêtre
                          </label>
                          <select
                            value={auditDraft.days}
                            onChange={(event) => setAuditDraft((prev: any) => ({ ...prev, days: event.target.value }))}
                            className={fieldClassName}
                            style={{ ...fieldStyle, fontSize: "0.75rem" }}
                          >
                            <option value="30">30 jours</option>
                            <option value="7">7 jours</option>
                            <option value="90">90 jours</option>
                          </select>
                        </div>
                      </div>

                      <div className="mb-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => exportAudit("csv")}
                          disabled={busyKey === "audit-export:csv"}
                          className="flex items-center gap-1 rounded-xl bg-[#f8fafc] px-3 py-1.5 text-[#475569] disabled:opacity-50"
                          style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                        >
                          <Download className="h-3 w-3" /> CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => exportAudit("json")}
                          disabled={busyKey === "audit-export:json"}
                          className="flex items-center gap-1 rounded-xl bg-[#f8fafc] px-3 py-1.5 text-[#475569] disabled:opacity-50"
                          style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                        >
                          <Download className="h-3 w-3" /> JSON
                        </button>
                        <button
                          type="button"
                          onClick={applyAuditFilters}
                          className="flex items-center gap-1 rounded-xl bg-[#f8fafc] px-3 py-1.5 text-[#475569]"
                          style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                        >
                          <RefreshCw className="h-3 w-3" /> Appliquer
                        </button>
                        <button
                          type="button"
                          onClick={resetAuditFilters}
                          className="flex items-center gap-1 rounded-xl bg-[#f8fafc] px-3 py-1.5 text-[#475569]"
                          style={{ fontSize: "0.75rem", border: "1px solid #e2e8f0" }}
                        >
                          <RotateCcw className="h-3 w-3" /> Reinitialiser
                        </button>
                      </div>

                      <div
                        className="rounded-xl p-4 text-center"
                        style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}
                      >
                        <p className="text-[#1d4ed8]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                          {auditTrail.length === 0
                            ? "Aucune ligne ne correspond aux filtres courants."
                            : `${filteredAuditCount} ligne(s) correspondent aux filtres courants.`}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#eef2f7] bg-white p-4">
                      <p className="mb-3 text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                        Historique des runs orchestres
                      </p>
                      {auditTrail.length === 0 ? (
                        <OpsEmptyState
                          icon={<Inbox className="h-5 w-5" />}
                          title="Aucun run orchestre"
                          description="Aucun run pour le moment."
                          action={
                            <PrimaryButton
                              onClick={() => runJobs(activeJobKeys, false, "Jobs actifs exécutés.")}
                              disabled={Boolean(busyKey) || !activeJobKeys.length}
                            >
                              <PlayCircle className="w-4 h-4" /> Lancer un run
                            </PrimaryButton>
                          }
                        />
                      ) : (
                        <div className="space-y-3">
                          {pageAuditTrail.map((entry: any) => (
                            <div key={entry.id} className="rounded-xl border border-[#e2e8f0] bg-[#fcfdff] p-4">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap gap-2">
                                    <SchedTag
                                      color={
                                        toneFor(entry.status) === "ok"
                                          ? "green"
                                          : toneFor(entry.status) === "danger"
                                            ? "red"
                                            : "amber"
                                      }
                                      label={entry.status_label || entry.status}
                                    />
                                    <SchedTag color="blue" label={entry.action_label || entry.action_kind} />
                                    <SchedTag color="orange" label={entry.module || "scheduler"} />
                                  </div>
                                  <div
                                    className="mt-3 text-[#0f172a]"
                                    style={{ fontSize: "0.875rem", fontWeight: 700 }}
                                  >
                                    {entry.target_label}
                                  </div>
                                  <p
                                    className="mt-1 text-[#475569]"
                                    style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}
                                  >
                                    {entry.summary}
                                  </p>
                                  {entry.details ? (
                                    <p
                                      className="mt-2 text-[#94a3b8]"
                                      style={{ fontSize: "0.75rem", lineHeight: 1.55 }}
                                    >
                                      {entry.details}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="min-w-[220px] text-right">
                                  <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                                    {entry.actor_label || "Console pilotage"}
                                    <br />
                                    {formatDateTimeFr(entry.created_at, "—")}
                                  </div>
                                  <div className="mt-3 flex justify-end">
                                    <Link
                                      to={entry.href || "/app/scheduler"}
                                      className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-[#475569]"
                                      style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                                    >
                                      Ouvrir <ArrowRight className="w-3.5 h-3.5" />
                                    </Link>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                          <ListPagination
                            page={auditPage}
                            totalItems={auditTrail.length}
                            pageSize={auditPageSize}
                            pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                            itemLabel="run"
                            onPageChange={setAuditPage}
                            onPageSizeChange={(nextPageSize) => {
                              setAuditPage(1);
                              setAuditPageSize(nextPageSize);
                            }}
                            pageSizeAriaLabel="Runs par page"
                            className="rounded-xl border border-[#f1f5f9]"
                          />
                        </div>
                      )}
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
