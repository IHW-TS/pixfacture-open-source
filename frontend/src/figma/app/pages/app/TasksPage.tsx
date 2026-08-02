"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import {
  AppPageHeader,
  Card,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import {
  Activity,
  CheckCircle,
  Clock,
  ClipboardList,
  Eye,
  MousePointerClick,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Wand2,
} from "lucide-react";

type TaskPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";
type TaskFilter = "all" | "open" | "done";

const MODULE_OPTIONS = [
  ["collections", "Factures en retard"],
  ["payments", "Paiements"],
  ["purchases", "Achats"],
  ["recurring", "Récurrence"],
  ["setup", "Configuration"],
];

const PRIORITY_TONE: Record<string, TaskPillTone> = {
  critical: "danger",
  high: "warn",
  medium: "muted",
  low: "ok",
};

const PRIORITY_LABEL: Record<string, string> = {
  critical: "Critique",
  high: "Haute",
  medium: "Normale",
  low: "Basse",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "À faire",
  in_progress: "En cours",
  done: "Terminée",
  blocked: "Bloquée",
};

const TASK_STATUS_TONE: Record<string, TaskPillTone> = {
  todo: "warn",
  in_progress: "info",
  done: "ok",
  blocked: "danger",
};

const tableTh: React.CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 700,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "0.625rem 1rem",
  textAlign: "left",
};

const tableTd: React.CSSProperties = {
  fontSize: "0.8125rem",
  color: "#374151",
  padding: "0.75rem 1rem",
  borderTop: "1px solid #f1f5f9",
  verticalAlign: "middle",
};

const fieldClass =
  "w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none transition-all focus:ring-2 focus:ring-[#1d4ed8]/20";
const fieldStyle: React.CSSProperties = { fontSize: "0.8125rem", border: "1px solid #e2e8f0" };

function moduleTone(module: string | null | undefined): TaskPillTone {
  const normalized = String(module || "setup").toLowerCase();
  if (normalized === "collections") return "info";
  if (normalized === "payments") return "info";
  if (normalized === "purchases") return "purple";
  if (normalized === "recurring") return "ok";
  return "muted";
}

function taskStatus(task: any) {
  return String(task?.status || "todo").toLowerCase();
}

function taskStatusLabel(task: any) {
  const status = taskStatus(task);
  return task?.status_label || TASK_STATUS_LABEL[status] || status;
}

function priorityLabel(task: any) {
  const priority = String(task?.priority || "medium").toLowerCase();
  return task?.priority_label || PRIORITY_LABEL[priority] || priority;
}

function formatTaskDate(value: string | null | undefined) {
  return value ? formatDateFr(value, "—") : "—";
}

export function TasksPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [data, setData] = useState<any>(null);
  const [slaData, setSlaData] = useState<any>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.tasks.pageSize.v1");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    module: "setup",
    priority: "medium",
    owner_role: "accountant",
    assignee_user_id: "",
    due_at: "",
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [boardRes, slaRes] = await Promise.all([rawApi("/api/ops/tasks-board"), rawApi("/api/ops/sla-dashboard")]);
      const [boardPayload, slaPayload] = await Promise.all([
        boardRes.json().catch(() => null),
        slaRes.json().catch(() => null),
      ]);
      if (!boardRes.ok) throw boardPayload || new Error("Tâches indisponibles.");
      if (!slaRes.ok) throw slaPayload || new Error("SLA indisponible.");
      setData(boardPayload || null);
      setSlaData(slaPayload || null);
    } catch (err) {
      setData(null);
      setSlaData(null);
      setError(formatApiError(err, "Impossible de charger les tâches."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshNonce]);

  const summary = data?.summary || {};
  const tasks = useMemo(() => (Array.isArray(data?.tasks) ? data.tasks : []), [data?.tasks]);
  const assignees = useMemo(() => (Array.isArray(data?.assignees) ? data.assignees : []), [data?.assignees]);
  const scheduler = useMemo(
    () => data?.scheduler || { summary: {}, due_playbooks: [], recent_runs: [] },
    [data?.scheduler],
  );
  const slaSummary = slaData?.summary || {};
  const slaMap = useMemo(
    () =>
      new Map<string, any>(
        (Array.isArray(slaData?.items) ? slaData.items : []).map((item: any) => [item.task_id, item]),
      ),
    [slaData],
  );

  const openTasks = useMemo(() => tasks.filter((task: any) => taskStatus(task) !== "done"), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task: any) => taskStatus(task) === "done"), [tasks]);
  const todoTasks = useMemo(
    () => tasks.filter((task: any) => !["done", "in_progress"].includes(taskStatus(task))),
    [tasks],
  );
  const inProgressTasks = useMemo(() => tasks.filter((task: any) => taskStatus(task) === "in_progress"), [tasks]);
  const filteredTasks = useMemo(() => {
    if (taskFilter === "open") return openTasks;
    if (taskFilter === "done") return doneTasks;
    return tasks;
  }, [doneTasks, openTasks, taskFilter, tasks]);
  const pageTasks = useMemo(() => paginateList(filteredTasks, page, pageSize), [filteredTasks, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [taskFilter]);

  const openCount = Number(summary.open_count || openTasks.length || 0);
  const dueTodayCount = Number(summary.due_today_count || 0);
  const blockedCount = Number(summary.blocked_count || 0);
  const doneCount = Number(summary.done_count || doneTasks.length || 0);
  const tabs: Array<{ key: TaskFilter; label: string; count: number }> = [
    { key: "all", label: "Toutes", count: tasks.length },
    { key: "open", label: "Ouvertes", count: openTasks.length },
    { key: "done", label: "Terminées", count: doneTasks.length },
  ];

  const createTask = async () => {
    if (!form.title.trim()) {
      setError("Donne un titre à la tâche.");
      return;
    }
    setBusyKey("create");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim() || null,
          module: form.module,
          priority: form.priority,
          owner_role: form.owner_role,
          assignee_user_id: form.assignee_user_id || null,
          due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
          status: "todo",
        }),
      });
      setNotice(`Tâche “${form.title.trim()}” créée.`);
      setForm({
        title: "",
        description: "",
        module: "setup",
        priority: "medium",
        owner_role: "accountant",
        assignee_user_id: "",
        due_at: "",
      });
      setShowTaskForm(false);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Création impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const patchTask = async (task: any, patch: any, successMessage?: string) => {
    if (!task?.id) return;
    setBusyKey(`task:${task.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (successMessage) setNotice(successMessage);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteTask = async (task: any) => {
    if (!task?.id) return;
    setBusyKey(`delete:${task.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/tasks/${task.id}`, { method: "DELETE" });
      setNotice(`Tâche “${task.title}” supprimée.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const runScheduler = async () => {
    setBusyKey("scheduler");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/scheduler/run", { method: "POST" });
      setNotice("Batch opérateur exécuté. Les playbooks dus ont été rejoués.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'exécuter le batch du jour."));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Tâches"
        breadcrumb="Avancé"
        description="File d'équipe et suivi opérationnel."
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={() => setRefreshNonce((value) => value + 1)}>
              <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
            </SecondaryButton>
            <PrimaryButton onClick={() => setShowTaskForm((value) => !value)}>
              <Plus className="h-3.5 w-3.5" /> Nouvelle tâche
            </PrimaryButton>
          </div>
        }
      />

      <WorkbenchPage>
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard
            label="Ouvertes"
            value={openCount}
            sub="À piloter"
            accent="blue"
            icon={<ClipboardList className="h-4 w-4" />}
          />
          <StatCard
            label="À faire"
            value={todoTasks.length}
            sub={`${dueTodayCount} aujourd'hui`}
            accent="amber"
            icon={<Clock className="h-4 w-4" />}
          />
          <StatCard
            label="En cours"
            value={inProgressTasks.length}
            sub={`${blockedCount} bloquée(s)`}
            accent={blockedCount > 0 ? "red" : "green"}
            icon={<Activity className="h-4 w-4" />}
          />
          <StatCard
            label="Terminées"
            value={doneCount}
            sub={`${Number(slaSummary.breached_count || 0)} SLA dépassé(s)`}
            accent="purple"
            icon={<CheckCircle className="h-4 w-4" />}
          />
        </div>

        {showTaskForm ? (
          <Card className="p-0" padding={false} style={{ border: "1px solid #1d4ed822" }}>
            <div className="flex items-center justify-between border-b border-[#f1f5f9] px-5 py-4">
              <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                Nouvelle tâche
              </h3>
              <button
                type="button"
                onClick={() => setShowTaskForm(false)}
                className="text-[#94a3b8] transition-colors hover:text-[#64748b]"
                style={{ fontSize: "0.75rem" }}
              >
                Fermer
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="grid gap-3 xl:grid-cols-5">
                <div className="xl:col-span-2">
                  <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                    Titre
                  </label>
                  <input
                    value={form.title}
                    onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Titre de la tâche..."
                    className={fieldClass}
                    style={fieldStyle}
                  />
                </div>
                <SelectField
                  label="Module"
                  value={form.module}
                  onChange={(event) => setForm((prev) => ({ ...prev, module: event.target.value }))}
                >
                  {MODULE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Priorité"
                  value={form.priority}
                  onChange={(event) => setForm((prev) => ({ ...prev, priority: event.target.value }))}
                >
                  <option value="critical">Critique</option>
                  <option value="high">Haute</option>
                  <option value="medium">Normale</option>
                  <option value="low">Basse</option>
                </SelectField>
                <SelectField
                  label="Assigner"
                  value={form.assignee_user_id}
                  onChange={(event) => setForm((prev) => ({ ...prev, assignee_user_id: event.target.value }))}
                >
                  <option value="">Non assignée</option>
                  {assignees.map((assignee: any) => (
                    <option key={assignee.id} value={assignee.id}>
                      {assignee.label || assignee.email}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div className="grid gap-3 xl:grid-cols-[1fr_260px]">
                <div>
                  <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                    Description
                  </label>
                  <textarea
                    value={form.description}
                    onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder="Contexte, blocage, action attendue..."
                    className={`${fieldClass} min-h-[76px]`}
                    style={fieldStyle}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                    Échéance
                  </label>
                  <input
                    type="datetime-local"
                    value={form.due_at}
                    onChange={(event) => setForm((prev) => ({ ...prev, due_at: event.target.value }))}
                    className={fieldClass}
                    style={fieldStyle}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <PrimaryButton disabled={busyKey === "create"} onClick={() => void createTask()}>
                  <Plus className="h-3.5 w-3.5" /> {busyKey === "create" ? "Création..." : "Créer"}
                </PrimaryButton>
              </div>
            </div>
          </Card>
        ) : null}

        {loading ? (
          <LoadingCard label="Chargement des tâches..." />
        ) : (
          <>
            <Card className="overflow-hidden p-0" padding={false}>
              <div className="flex items-center justify-between border-b border-[#f1f5f9] px-5 py-3">
                <div className="flex flex-wrap gap-1">
                  {tabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setTaskFilter(tab.key)}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors"
                      style={{
                        fontSize: "0.8125rem",
                        fontWeight: taskFilter === tab.key ? 600 : 400,
                        background: taskFilter === tab.key ? "#eff6ff" : "transparent",
                        color: taskFilter === tab.key ? "#1d4ed8" : "#64748b",
                      }}
                    >
                      {tab.label}
                      <span
                        className="rounded-full px-1.5 py-0.5"
                        style={{
                          fontSize: "0.625rem",
                          fontWeight: 700,
                          background: taskFilter === tab.key ? "#1d4ed8" : "#f1f5f9",
                          color: taskFilter === tab.key ? "white" : "#94a3b8",
                        }}
                      >
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>
                <StatusPill status={openTasks.length > 0 ? "info" : "muted"} label={`${openTasks.length} ouverte(s)`} />
              </div>
              <div className="overflow-x-auto">
                <table className="pf-data-table w-full">
                  <thead>
                    <tr style={{ background: "#fafbfd" }}>
                      <th style={tableTh}>Tâche</th>
                      <th style={tableTh}>Module</th>
                      <th style={tableTh}>Priorité</th>
                      <th style={tableTh}>Assignée à</th>
                      <th style={tableTh}>Échéance</th>
                      <th style={tableTh}>Statut</th>
                      <th style={{ ...tableTh, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageTasks.map((task: any) => {
                      const status = taskStatus(task);
                      const rowBusy = busyKey === `task:${task.id}` || busyKey === `delete:${task.id}`;
                      const sla = slaMap.get(task.id);
                      return (
                        <tr key={task.id} className="transition-colors hover:bg-[#fafbfd]">
                          <td style={{ ...tableTd, fontWeight: 600, color: "#0f172a" }}>
                            <div>{task.title}</div>
                            {sla?.sla_label ? (
                              <div className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                                SLA {sla.sla_label}
                              </div>
                            ) : null}
                          </td>
                          <td style={tableTd}>
                            <StatusPill
                              status={moduleTone(task.module)}
                              label={task.module_label || task.module || "Module"}
                            />
                          </td>
                          <td style={tableTd}>
                            <StatusPill
                              status={PRIORITY_TONE[String(task.priority || "medium").toLowerCase()] || "muted"}
                              label={priorityLabel(task)}
                            />
                          </td>
                          <td style={tableTd}>{task.assignee_label || task.assignee_email || "Non assignée"}</td>
                          <td style={tableTd}>{formatTaskDate(task.due_at)}</td>
                          <td style={tableTd}>
                            <StatusPill status={TASK_STATUS_TONE[status] || "muted"} label={taskStatusLabel(task)} />
                          </td>
                          <td style={{ ...tableTd, textAlign: "right" }}>
                            <div className="flex items-center justify-end gap-1.5">
                              {status !== "in_progress" && status !== "done" ? (
                                <button
                                  type="button"
                                  disabled={rowBusy}
                                  onClick={() =>
                                    void patchTask(task, { status: "in_progress" }, `Tâche “${task.title}” démarrée.`)
                                  }
                                  className="flex items-center gap-1 rounded-lg bg-[#eff6ff] px-2.5 py-1 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe] disabled:opacity-50"
                                  style={{ fontSize: "0.75rem", fontWeight: 600 }}
                                >
                                  <Play className="h-3 w-3" /> Démarrer
                                </button>
                              ) : null}
                              {status !== "done" ? (
                                <button
                                  type="button"
                                  disabled={rowBusy}
                                  onClick={() =>
                                    void patchTask(task, { status: "done" }, `Tâche “${task.title}” terminée.`)
                                  }
                                  className="flex items-center gap-1 rounded-lg bg-[#f0fdf4] px-2.5 py-1 text-[#059669] transition-colors hover:bg-[#dcfce7] disabled:opacity-50"
                                  style={{ fontSize: "0.75rem", fontWeight: 600 }}
                                >
                                  <CheckCircle className="h-3 w-3" /> Terminer
                                </button>
                              ) : null}
                              <Link
                                to={task.href || "/app/tasks"}
                                className="flex items-center gap-1 rounded-lg bg-[#f8fafc] px-2.5 py-1 text-[#64748b] transition-colors hover:bg-[#f1f5f9]"
                                style={{ fontSize: "0.75rem", fontWeight: 500, border: "1px solid #e2e8f0" }}
                              >
                                <Eye className="h-3 w-3" /> Voir
                              </Link>
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => void deleteTask(task)}
                                className="flex items-center gap-1 rounded-lg bg-[#fef2f2] px-2.5 py-1 text-[#dc2626] transition-colors hover:bg-[#fee2e2] disabled:opacity-50"
                                style={{ fontSize: "0.75rem", fontWeight: 600 }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <ClipboardList className="mb-3 h-8 w-8 text-[#e2e8f0]" />
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    Aucune tâche dans cette catégorie.
                  </p>
                </div>
              ) : null}
              <ListPagination
                page={page}
                totalItems={filteredTasks.length}
                pageSize={pageSize}
                pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                itemLabel="tâche"
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1);
                  setPageSize(nextPageSize);
                }}
                pageSizeAriaLabel="Tâches par page"
              />
            </Card>

            <Card className="p-0" padding={false}>
              <div className="border-b border-[#f1f5f9] px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                    Batch du jour
                  </h3>
                  <SecondaryButton disabled={busyKey === "scheduler"} onClick={() => void runScheduler()}>
                    <Wand2 className="h-3.5 w-3.5" /> {busyKey === "scheduler" ? "Exécution..." : "Exécuter"}
                  </SecondaryButton>
                </div>
              </div>
              <div className="space-y-3 p-5">
                {(scheduler?.due_playbooks || []).length === 0 ? (
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    Aucun playbook dû maintenant.
                  </p>
                ) : (
                  scheduler.due_playbooks.slice(0, 4).map((playbook: any) => (
                    <div key={playbook.id} className="rounded-xl border border-[#f1f5f9] bg-[#fafbfd] p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill
                          status={moduleTone(playbook.module)}
                          label={playbook.module_label || playbook.module || "Module"}
                        />
                        <StatusPill status="muted" label={playbook.cadence || "Cadence"} />
                      </div>
                      <div className="mt-2 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                        {playbook.name}
                      </div>
                      <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                        {playbook.next_run_at
                          ? `Depuis ${formatDateTimeFr(playbook.next_run_at)}`
                          : "À exécuter maintenant"}
                      </p>
                    </div>
                  ))
                )}
                {(scheduler?.recent_runs || []).length ? (
                  <div className="border-t border-[#f1f5f9] pt-3">
                    <div
                      className="mb-2 text-[#94a3b8]"
                      style={{
                        fontSize: "0.6875rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      Derniers runs
                    </div>
                    <div className="space-y-2">
                      {scheduler.recent_runs.slice(0, 3).map((run: any) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between gap-3 rounded-xl bg-[#f8fafc] px-3 py-2"
                        >
                          <span className="text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                            {run.trigger === "manual" ? "Run manuel" : "Run auto"} · {run.created_tasks || 0} tâche(s)
                          </span>
                          <StatusPill
                            status={run.status === "ok" ? "ok" : "warn"}
                            label={run.status === "ok" ? "OK" : run.status || "Run"}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          </>
        )}
      </WorkbenchPage>
    </div>
  );
}
