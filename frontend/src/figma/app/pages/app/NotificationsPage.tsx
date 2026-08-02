"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import {
  ActionMenu,
  ActionMenuButton,
  ActionMenuLink,
  AppPageHeader,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { OpsEmptyState, OpsMiniStat, OpsPanelShell, OpsSearchField } from "../../components/app/OpsTabbedBoard";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CalendarClock,
  Clock3,
  Copy,
  Mail,
  PencilLine,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Wand2,
} from "lucide-react";

type NotificationPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";
type NotificationsTab = "alerts" | "digest" | "sla" | "rules";
type SlaFilter = "all" | "breached" | "watch";
type RulesViewFilter = "all" | "active" | "auto_task";
type PolicyFormState = {
  critical: string;
  high: string;
  medium: string;
  low: string;
  notify_before_hours: string;
  escalate_after_hours: string;
};
type PolicyFormKey = "critical" | "high" | "medium" | "low";
type PrefsBooleanKey = "email_digest_enabled" | "include_weekends" | "critical_boost";
type RuleBooleanKey = "include_in_digest" | "auto_task";

const headerLinkClass =
  "inline-flex items-center gap-1.5 rounded-xl border border-[#d7e3ef] bg-white px-3 py-2 text-[#475569] transition-colors hover:border-[#bfdbfe] hover:text-[#1d4ed8]";

const severityPill = (severity: string | null | undefined): { status: NotificationPillTone; label: string } => {
  const normalized = String(severity || "medium").toLowerCase();
  if (normalized === "critical") return { status: "danger", label: "Critique" };
  if (normalized === "high") return { status: "warn", label: "Haute" };
  if (normalized === "low") return { status: "muted", label: "Suivi" };
  return { status: "info", label: "Info" };
};

const modulePill = (
  module: string | null | undefined,
  moduleLabel?: string | null,
): { status: NotificationPillTone; label: string } => {
  const normalized = String(module || "setup").toLowerCase();
  const label = moduleLabel || normalized;
  if (normalized === "collections") return { status: "info", label };
  if (normalized === "payments") return { status: "muted", label };
  if (normalized === "purchases") return { status: "purple", label };
  if (normalized === "recurring") return { status: "ok", label };
  if (normalized === "tasks") return { status: "info", label };
  if (normalized === "campaigns") return { status: "purple", label };
  if (normalized === "scheduler") return { status: "ok", label };
  return { status: "muted", label };
};

const triggerLabel = (value: string | null | undefined) => {
  const normalized = String(value || "urgent_unread").toLowerCase();
  if (normalized === "sla_breached") return "SLA dépassé";
  if (normalized === "due_today") return "Échéance aujourd'hui";
  if (normalized === "payment_gap") return "Paiement à fiabiliser";
  if (normalized === "purchase_waiting") return "Achat à débloquer";
  if (normalized === "recurring_due") return "Récurrence à exécuter";
  return "Alertes non lues";
};

const scopeLabel = (value: string | null | undefined) => {
  const normalized = String(value || "all").toLowerCase();
  if (normalized === "urgent") return "Urgent seulement";
  if (normalized === "team") return "Équipe / exécution";
  return "Vue complète";
};

const roleLabel = (value: string | null | undefined) => {
  const normalized = String(value || "accountant").toLowerCase();
  if (normalized === "owner") return "Owner";
  if (normalized === "admin") return "Admin";
  if (normalized === "viewer") return "Viewer";
  return "Compta";
};

function minutesToLabel(minutes: number | null | undefined) {
  const value = Number(minutes || 0);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const hours = value / 60;
  if (hours < 24) return `${hours.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h`;
  return `${(hours / 24).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} j`;
}

function lastDigestLabel(value: string | null | undefined) {
  if (!value) return "Jamais généré";
  return formatDateTimeFr(value);
}

const DEFAULT_RULE_FORM = {
  name: "",
  module: "collections",
  trigger_type: "urgent_unread",
  min_severity: "high",
  owner_role: "accountant",
  notes: "",
  include_in_digest: true,
  auto_task: false,
  min_amount: "",
  min_age_days: "",
  keyword: "",
};

function toRuleForm(rule: any, fallbackModule = "collections") {
  if (!rule) {
    return {
      ...DEFAULT_RULE_FORM,
      module: fallbackModule || DEFAULT_RULE_FORM.module,
    };
  }
  return {
    name: String(rule?.name || ""),
    module: String(rule?.module || fallbackModule || DEFAULT_RULE_FORM.module),
    trigger_type: String(rule?.trigger_type || "urgent_unread"),
    min_severity: String(rule?.min_severity || "high"),
    owner_role: String(rule?.owner_role || "accountant"),
    notes: String(rule?.notes || ""),
    include_in_digest: Boolean(rule?.include_in_digest),
    auto_task: Boolean(rule?.auto_task),
    min_amount: rule?.min_amount != null && `${rule.min_amount}` !== "0" ? String(rule.min_amount) : "",
    min_age_days: rule?.min_age_days != null && Number(rule.min_age_days) > 0 ? String(rule.min_age_days) : "",
    keyword: String(rule?.keyword || ""),
  };
}

function ruleTargetingLabels(rule: any) {
  if (Array.isArray(rule?.targeting_labels) && rule.targeting_labels.length > 0) {
    return rule.targeting_labels.filter(Boolean);
  }
  const labels: string[] = [];
  const amount = Number(rule?.min_amount || 0);
  if (Number.isFinite(amount) && amount > 0) {
    labels.push(`≥ ${amount.toLocaleString("fr-FR")} €`);
  }
  const ageDays = Number(rule?.min_age_days || 0);
  if (Number.isFinite(ageDays) && ageDays > 0) {
    labels.push(`≥ ${ageDays} j`);
  }
  const keyword = String(rule?.keyword || "").trim();
  if (keyword) {
    labels.push(`Mot-clé · ${keyword}`);
  }
  return labels;
}

export function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [notificationsData, setNotificationsData] = useState<any>(null);
  const [slaData, setSlaData] = useState<any>(null);
  const [rulesData, setRulesData] = useState<any>(null);
  const [prefsData, setPrefsData] = useState<any>(null);
  const [digestData, setDigestData] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<NotificationsTab>("alerts");
  const [filter, setFilter] = useState<"all" | "unread" | "critical">("all");
  const [alertSearch, setAlertSearch] = useState("");
  const [slaFilter, setSlaFilter] = useState<SlaFilter>("all");
  const [policyForm, setPolicyForm] = useState<PolicyFormState>({
    critical: "4",
    high: "12",
    medium: "24",
    low: "48",
    notify_before_hours: "6",
    escalate_after_hours: "8",
  });
  const [prefsForm, setPrefsForm] = useState({
    email_digest_enabled: true,
    include_weekends: false,
    digest_hour: "8",
    digest_scope: "all",
    critical_boost: true,
  });
  const [ruleForm, setRuleForm] = useState({ ...DEFAULT_RULE_FORM });
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [rulesSearch, setRulesSearch] = useState("");
  const [rulesViewFilter, setRulesViewFilter] = useState<RulesViewFilter>("all");
  const [rulesModuleFilter, setRulesModuleFilter] = useState("all");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [notifRes, slaRes, rulesRes, prefsRes, digestRes] = await Promise.all([
        rawApi("/api/ops/notifications"),
        rawApi("/api/ops/sla-dashboard"),
        rawApi("/api/ops/digest-rules"),
        rawApi("/api/ops/digest-preferences"),
        rawApi("/api/ops/digest"),
      ]);
      const [notifPayload, slaPayload, rulesPayload, prefsPayload, digestPayload] = await Promise.all([
        notifRes.json().catch(() => null),
        slaRes.json().catch(() => null),
        rulesRes.json().catch(() => null),
        prefsRes.json().catch(() => null),
        digestRes.json().catch(() => null),
      ]);
      if (!notifRes.ok) throw notifPayload || new Error("Alertes indisponibles.");
      if (!slaRes.ok) throw slaPayload || new Error("SLA indisponible.");
      if (!rulesRes.ok) throw rulesPayload || new Error("Règles digest indisponibles.");
      if (!prefsRes.ok) throw prefsPayload || new Error("Préférences digest indisponibles.");
      if (!digestRes.ok) throw digestPayload || new Error("Digest indisponible.");

      setNotificationsData(notifPayload || null);
      setSlaData(slaPayload || null);
      setRulesData(rulesPayload || null);
      setPrefsData(prefsPayload || null);
      setDigestData(digestPayload || null);

      const policy = slaPayload?.policy || {};
      setPolicyForm({
        critical: String(policy?.priority_hours?.critical ?? 4),
        high: String(policy?.priority_hours?.high ?? 12),
        medium: String(policy?.priority_hours?.medium ?? 24),
        low: String(policy?.priority_hours?.low ?? 48),
        notify_before_hours: String(policy?.notify_before_hours ?? 6),
        escalate_after_hours: String(policy?.escalate_after_hours ?? 8),
      });
      setPrefsForm({
        email_digest_enabled: Boolean(prefsPayload?.email_digest_enabled),
        include_weekends: Boolean(prefsPayload?.include_weekends),
        digest_hour: String(prefsPayload?.digest_hour ?? 8),
        digest_scope: String(prefsPayload?.digest_scope || "all"),
        critical_boost: Boolean(prefsPayload?.critical_boost),
      });
    } catch (err) {
      setNotificationsData(null);
      setSlaData(null);
      setRulesData(null);
      setPrefsData(null);
      setDigestData(null);
      setError(formatApiError(err, "Impossible de charger les alertes, le digest et les SLA."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshNonce]);

  const notifications = useMemo(
    () => (Array.isArray(notificationsData?.items) ? notificationsData.items : []),
    [notificationsData?.items],
  );
  const notifSummary = notificationsData?.summary || {};
  const slaSummary = slaData?.summary || {};
  const slaItems = useMemo(() => (Array.isArray(slaData?.items) ? slaData.items : []), [slaData?.items]);
  const rules = useMemo(() => (Array.isArray(rulesData?.items) ? rulesData.items : []), [rulesData?.items]);
  const rulesSummary = rulesData?.summary || {};
  const digestSummary = digestData?.summary || {};
  const digestSections = Array.isArray(digestData?.sections) ? digestData.sections : [];
  const digestRuns = Array.isArray(digestData?.recent_runs) ? digestData.recent_runs : [];
  const visibleRules = useMemo(() => {
    const q = rulesSearch.trim().toLowerCase();
    return rules.filter((rule: any) => {
      if (rulesViewFilter === "active" && !rule.active) return false;
      if (rulesViewFilter === "auto_task" && !rule.auto_task) return false;
      if (rulesModuleFilter !== "all" && rule.module !== rulesModuleFilter) return false;
      if (!q) return true;
      const haystack = [rule.name, rule.notes, rule.module_label, triggerLabel(rule.trigger_type)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rules, rulesSearch, rulesModuleFilter, rulesViewFilter]);

  const filteredNotifications = useMemo(() => {
    const query = alertSearch.trim().toLowerCase();
    return notifications.filter((item: any) => {
      if (filter === "unread" && item.read) return false;
      if (filter === "critical" && !["critical", "high"].includes(String(item?.severity || "").toLowerCase())) {
        return false;
      }
      if (!query) return true;
      return [item.title, item.subtitle, item.description, item.module_label, item.severity]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [alertSearch, filter, notifications]);

  const filteredSlaItems = useMemo(() => {
    return slaItems.filter((item: any) => {
      const state = String(item?.sla_state || "").toLowerCase();
      if (slaFilter === "breached") return state === "breached";
      if (slaFilter === "watch") return state === "due_soon" || state === "blocked";
      return true;
    });
  }, [slaFilter, slaItems]);

  const focusSignals = useMemo<Array<{ label: string; tone: NotificationPillTone }>>(
    () => [
      {
        label: `${notifSummary.due_today_count || 0} échéance(s)`,
        tone: (notifSummary.due_today_count || 0) > 0 ? "warn" : "muted",
      },
      {
        label: `${rulesSummary.matched_rules_count || 0} règle(s) actives`,
        tone: (rulesSummary.matched_rules_count || 0) > 0 ? "purple" : "muted",
      },
      {
        label: `${digestSummary.recent_auto_tasks_created || 0} auto-tâche(s)`,
        tone: (digestSummary.recent_auto_tasks_created || 0) > 0 ? "info" : "muted",
      },
      { label: scopeLabel(prefsData?.digest_scope), tone: "info" },
    ],
    [
      digestSummary.recent_auto_tasks_created,
      notifSummary.due_today_count,
      prefsData?.digest_scope,
      rulesSummary.matched_rules_count,
    ],
  );
  const todayTitle =
    (notifSummary.critical_unread_count || 0) > 0
      ? "Les alertes critiques demandent une prise en main immédiate."
      : (slaSummary.breached_count || 0) > 0
        ? "Le vrai sujet du jour est la reprise des tâches hors SLA."
        : (notifSummary.unread_count || 0) > 0
          ? "Les signaux existent, mais restent gérables dans une vue compacte."
          : "La vue est calme, avec un cadre prêt à réagir si le rythme change.";
  const todayDescription = digestSummary.recommended_focus
    ? `Focus recommandé: ${digestSummary.recommended_focus}. Le digest et les règles restent disponibles sans occuper toute la page.`
    : "Le centre d'alertes reste au premier plan, pendant que le digest, les règles et le SLA restent consultables en second niveau.";
  const todayMetrics = [
    {
      label: "Non lues",
      value: notifSummary.unread_count || 0,
      tone: (notifSummary.unread_count || 0) > 0 ? "info" : "muted",
    },
    {
      label: "Critiques ouvertes",
      value: notifSummary.critical_unread_count || 0,
      tone: (notifSummary.critical_unread_count || 0) > 0 ? "danger" : "muted",
    },
    {
      label: "SLA dépassés",
      value: slaSummary.breached_count || 0,
      tone: (slaSummary.breached_count || 0) > 0 ? "warn" : "muted",
    },
  ] as const;

  const heroMetrics: Array<{
    label: string;
    value: string | number;
    detail: string;
    accent: "blue" | "amber" | "red" | "purple";
    icon: ReactNode;
  }> = todayMetrics.map((item) => ({
    label: item.label,
    value: item.value,
    detail:
      item.label === "Non lues"
        ? "en attente de lecture"
        : item.label === "Critiques ouvertes"
          ? "à traiter immédiatement"
          : "files en risque",
    accent:
      item.label === "Non lues" ? "purple" : item.tone === "danger" ? "red" : item.tone === "warn" ? "amber" : "blue",
    icon:
      item.label === "Non lues" ? (
        <Mail className="h-4 w-4" />
      ) : item.label === "Critiques ouvertes" ? (
        <AlertTriangle className="h-4 w-4" />
      ) : (
        <Clock3 className="h-4 w-4" />
      ),
  }));

  const heroPriority = useMemo(() => {
    const priorityNotification =
      notifications.find(
        (item: any) => !item.read && ["critical", "high"].includes(String(item?.severity || "").toLowerCase()),
      ) ||
      notifications.find((item: any) => !item.read) ||
      null;
    if (priorityNotification) return { source: "notification", item: priorityNotification };

    const breachedItem =
      slaItems.find(
        (item: any) =>
          item?.sla_state === "breached" || item?.sla_state === "due_soon" || item?.sla_state === "blocked",
      ) ||
      slaItems[0] ||
      null;
    if (breachedItem) return { source: "sla", item: breachedItem };

    return null;
  }, [notifications, slaItems]);

  const heroAsideTitle =
    heroPriority?.source === "notification"
      ? heroPriority.item.title
      : heroPriority?.source === "sla"
        ? heroPriority.item.title
        : digestSummary.recommended_focus
          ? `Focus recommandé: ${digestSummary.recommended_focus}`
          : "Aucune priorité immédiate.";
  const heroAsideDescription =
    heroPriority?.source === "notification"
      ? [heroPriority.item.subtitle, heroPriority.item.description].filter(Boolean).join(" · ") ||
        "Le prochain signal remonterait ici s'il devient prioritaire."
      : heroPriority?.source === "sla"
        ? [
            heroPriority.item.assignee_label,
            heroPriority.item.status_label || heroPriority.item.status,
            heroPriority.item.sla_label || heroPriority.item.sla_state,
          ]
            .filter(Boolean)
            .join(" · ") || "Une tâche sous SLA apparaît ici dès qu'elle dépasse le cadre."
        : "Le digest et les alertes restent disponibles sans saturer le haut de page.";
  const heroAsideHref =
    heroPriority?.source === "notification"
      ? heroPriority.item.href || "/app/notifications"
      : heroPriority?.source === "sla"
        ? heroPriority.item.href || "/app/tasks"
        : "/app/notifications";

  const savePolicy = async () => {
    setBusyKey("policy");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/sla-policy", {
        method: "PATCH",
        body: JSON.stringify({
          priority_hours: {
            critical: Number(policyForm.critical || 4),
            high: Number(policyForm.high || 12),
            medium: Number(policyForm.medium || 24),
            low: Number(policyForm.low || 48),
          },
          notify_before_hours: Number(policyForm.notify_before_hours || 6),
          escalate_after_hours: Number(policyForm.escalate_after_hours || 8),
        }),
      });
      setNotice("Politique SLA mise à jour.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer la politique SLA."));
    } finally {
      setBusyKey(null);
    }
  };

  const runSla = async () => {
    setBusyKey("sla-run");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/sla/run", { method: "POST" });
      setNotice("Scan SLA relancé. Les alertes prioritaires ont été recalculées.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de recalculer les SLA."));
    } finally {
      setBusyKey(null);
    }
  };

  const markAllRead = async () => {
    setBusyKey("mark-all");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/notifications/mark-all-read", { method: "POST" });
      setNotice("Toutes les notifications sont maintenant lues.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de tout marquer comme lu."));
    } finally {
      setBusyKey(null);
    }
  };

  const markOne = async (item: any, read: boolean) => {
    if (!item?.id) return;
    setBusyKey(`notif:${item.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/notifications/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ read }),
      });
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour cette notification."));
    } finally {
      setBusyKey(null);
    }
  };

  const savePreferences = async () => {
    setBusyKey("prefs");
    setError(null);
    setNotice(null);
    try {
      await api("/api/ops/digest-preferences", {
        method: "PATCH",
        body: JSON.stringify({
          email_digest_enabled: Boolean(prefsForm.email_digest_enabled),
          include_weekends: Boolean(prefsForm.include_weekends),
          digest_hour: Number(prefsForm.digest_hour || 8),
          digest_scope: prefsForm.digest_scope,
          critical_boost: Boolean(prefsForm.critical_boost),
        }),
      });
      setNotice("Préférences digest mises à jour.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer les préférences digest."));
    } finally {
      setBusyKey(null);
    }
  };

  const runDigest = async () => {
    setBusyKey("digest-run");
    setError(null);
    setNotice(null);
    try {
      const payload = await api("/api/ops/digest/run", { method: "POST" });
      const createdTasks = Number(payload?.recent_runs?.[0]?.auto_tasks_created || 0);
      setNotice(
        createdTasks > 0
          ? `Digest généré. ${createdTasks} tâche(s) opérateur ont été créées automatiquement.`
          : "Digest généré et historisé.",
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de générer le digest."));
    } finally {
      setBusyKey(null);
    }
  };

  const resetRuleEditor = (nextModule?: string) => {
    setEditingRuleId(null);
    setRuleForm({
      ...DEFAULT_RULE_FORM,
      module: nextModule || ruleForm.module || DEFAULT_RULE_FORM.module,
    });
  };

  const loadRuleIntoEditor = (rule: any) => {
    setActiveTab("rules");
    setEditingRuleId(rule?.id || null);
    setRuleForm(toRuleForm(rule, rule?.module || ruleForm.module));
    setNotice(`Règle “${rule?.name || ""}” chargée dans l'éditeur.`);
    setError(null);
  };

  const duplicateRule = (rule: any) => {
    setActiveTab("rules");
    setEditingRuleId(null);
    setRuleForm({
      ...toRuleForm(rule, rule?.module || ruleForm.module),
      name: `${rule?.name || "Règle"} · copie`,
    });
    setNotice(`Copie prête à partir de “${rule?.name || "cette règle"}”.`);
    setError(null);
  };

  const saveRule = async () => {
    if (!ruleForm.name.trim()) {
      setError("Donne un nom court à la règle avant de l'enregistrer.");
      return;
    }
    const isEditing = Boolean(editingRuleId);
    const busyToken = isEditing ? `rule-save:${editingRuleId}` : "rule-create";
    setBusyKey(busyToken);
    setError(null);
    setNotice(null);
    try {
      const body = {
        name: ruleForm.name.trim(),
        module: ruleForm.module,
        trigger_type: ruleForm.trigger_type,
        min_severity: ruleForm.min_severity,
        owner_role: ruleForm.owner_role,
        notes: ruleForm.notes.trim() || "",
        include_in_digest: Boolean(ruleForm.include_in_digest),
        auto_task: Boolean(ruleForm.auto_task),
        min_amount: ruleForm.min_amount.trim() ? ruleForm.min_amount.trim() : null,
        min_age_days: ruleForm.min_age_days.trim() ? Number(ruleForm.min_age_days) : null,
        keyword: ruleForm.keyword.trim() || null,
        ...(isEditing ? {} : { active: true }),
      };
      if (isEditing) {
        await api(`/api/ops/digest-rules/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setNotice(`Règle “${ruleForm.name.trim()}” mise à jour.`);
      } else {
        await api("/api/ops/digest-rules", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setNotice("Nouvelle règle digest ajoutée.");
      }
      const keptModule = ruleForm.module;
      resetRuleEditor(keptModule);
      await load();
    } catch (err) {
      setError(
        formatApiError(
          err,
          isEditing ? "Impossible de mettre à jour cette règle." : "Impossible d'ajouter cette règle.",
        ),
      );
    } finally {
      setBusyKey(null);
    }
  };

  const patchRule = async (rule: any, patch: Record<string, any>, successMessage: string) => {
    if (!rule?.id) return;
    setBusyKey(`rule:${rule.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/digest-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour la règle."));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteRule = async (rule: any) => {
    if (!rule?.id) return;
    setBusyKey(`rule-delete:${rule.id}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/digest-rules/${rule.id}`, { method: "DELETE" });
      if (editingRuleId === rule.id) {
        resetRuleEditor(rule.module);
      }
      setNotice(`Règle “${rule.name}” supprimée.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de supprimer cette règle."));
    } finally {
      setBusyKey(null);
    }
  };

  const generatedAt =
    notificationsData?.generated_at ||
    digestData?.generated_at ||
    slaData?.generated_at ||
    rulesData?.generated_at ||
    null;
  const activeRulesCount = rules.filter((rule: any) => Boolean(rule?.active)).length;
  const autoTaskRuleCount = rules.filter((rule: any) => Boolean(rule?.auto_task)).length;
  const watchedSlaCount = slaItems.filter((item: any) => {
    const state = String(item?.sla_state || "").toLowerCase();
    return state === "due_soon" || state === "blocked";
  }).length;
  const alertFilterLabel = filter === "unread" ? "Non lues" : filter === "critical" ? "Critiques" : undefined;
  const slaFilterLabel = slaFilter === "breached" ? "Dépassés" : slaFilter === "watch" ? "À surveiller" : undefined;
  const rulesFilterLabel =
    rulesViewFilter === "active" ? "Actives" : rulesViewFilter === "auto_task" ? "Auto-tâches" : undefined;

  const tabs: Array<{
    id: NotificationsTab;
    label: string;
    badge?: number;
    activeHint?: string;
    submenuItems?: Array<{ label: string; badge?: number; active?: boolean; onSelect: () => void }>;
  }> = [
    {
      id: "alerts",
      label: "Alertes",
      badge: notifications.length,
      activeHint: activeTab === "alerts" ? alertFilterLabel : undefined,
      submenuItems: [
        {
          label: "Toutes",
          badge: notifications.length,
          active: filter === "all",
          onSelect: () => {
            setActiveTab("alerts");
            setFilter("all");
          },
        },
        {
          label: "Non lues",
          badge: Number(notifSummary.unread_count || 0),
          active: filter === "unread",
          onSelect: () => {
            setActiveTab("alerts");
            setFilter("unread");
          },
        },
        {
          label: "Critiques",
          badge: Number(notifSummary.critical_unread_count || 0) + Number(notifSummary.high_unread_count || 0),
          active: filter === "critical",
          onSelect: () => {
            setActiveTab("alerts");
            setFilter("critical");
          },
        },
      ],
    },
    {
      id: "digest",
      label: "Digest",
      badge: digestSections.length,
    },
    {
      id: "sla",
      label: "SLA",
      badge: slaItems.length,
      activeHint: activeTab === "sla" ? slaFilterLabel : undefined,
      submenuItems: [
        {
          label: "Tous",
          badge: slaItems.length,
          active: slaFilter === "all",
          onSelect: () => {
            setActiveTab("sla");
            setSlaFilter("all");
          },
        },
        {
          label: "Dépassés",
          badge: Number(slaSummary.breached_count || 0),
          active: slaFilter === "breached",
          onSelect: () => {
            setActiveTab("sla");
            setSlaFilter("breached");
          },
        },
        {
          label: "À surveiller",
          badge: watchedSlaCount,
          active: slaFilter === "watch",
          onSelect: () => {
            setActiveTab("sla");
            setSlaFilter("watch");
          },
        },
      ],
    },
    {
      id: "rules",
      label: "Règles",
      badge: rules.length,
      activeHint: activeTab === "rules" ? rulesFilterLabel : undefined,
      submenuItems: [
        {
          label: "Toutes",
          badge: rules.length,
          active: rulesViewFilter === "all",
          onSelect: () => {
            setActiveTab("rules");
            setRulesViewFilter("all");
          },
        },
        {
          label: "Actives",
          badge: activeRulesCount,
          active: rulesViewFilter === "active",
          onSelect: () => {
            setActiveTab("rules");
            setRulesViewFilter("active");
          },
        },
        {
          label: "Auto-tâches",
          badge: autoTaskRuleCount,
          active: rulesViewFilter === "auto_task",
          onSelect: () => {
            setActiveTab("rules");
            setRulesViewFilter("auto_task");
          },
        },
      ],
    },
  ];

  const panelHeaderActions =
    activeTab === "alerts" ? (
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
        <div className="text-right text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {filteredNotifications.length} visible(s)
        </div>
        <OpsSearchField
          value={alertSearch}
          onChange={(event) => setAlertSearch(event.target.value)}
          placeholder="Rechercher une alerte..."
          className="w-full sm:w-[300px]"
        />
      </div>
    ) : activeTab === "digest" ? (
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          status={prefsData?.delivery_mode === "preview" ? "info" : "ok"}
          label={prefsData?.delivery_mode === "preview" ? "Aperçu email" : "Envoi actif"}
        />
        <SecondaryButton onClick={() => void runDigest()} disabled={busyKey === "digest-run"}>
          <Mail className="h-3.5 w-3.5" /> {busyKey === "digest-run" ? "Génération..." : "Générer"}
        </SecondaryButton>
      </div>
    ) : activeTab === "sla" ? (
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          status={(slaSummary.breached_count || 0) > 0 ? "danger" : "ok"}
          label={`${slaSummary.breached_count || 0} dépassé(s)`}
        />
        <SecondaryButton onClick={() => void runSla()} disabled={busyKey === "sla-run"}>
          <RefreshCw className="h-3.5 w-3.5" /> {busyKey === "sla-run" ? "Recalcul..." : "Recalculer"}
        </SecondaryButton>
      </div>
    ) : (
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
        <div className="text-right text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {visibleRules.length} visible(s)
        </div>
        <OpsSearchField
          value={rulesSearch}
          onChange={(event) => setRulesSearch(event.target.value)}
          placeholder="Rechercher une règle..."
          className="w-full sm:w-[300px]"
        />
      </div>
    );

  const panelFooter =
    activeTab === "alerts" ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <StatusPill
            status={(notifSummary.unread_count || 0) > 0 ? "warn" : "ok"}
            label={`${notifSummary.unread_count || 0} non lue(s)`}
          />
          <StatusPill
            status={(notifSummary.critical_unread_count || 0) > 0 ? "danger" : "muted"}
            label={`${notifSummary.critical_unread_count || 0} critique(s)`}
          />
        </div>
        <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {generatedAt ? `Synchro ${formatDateTimeFr(generatedAt)}` : "Synchro en attente"}
        </div>
      </div>
    ) : activeTab === "digest" ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <StatusPill
            status={(digestSummary.urgent_count || 0) > 0 ? "warn" : "ok"}
            label={`${digestSummary.urgent_count || 0} urgence(s)`}
          />
          <StatusPill
            status={(rulesSummary.matched_rules_count || 0) > 0 ? "purple" : "muted"}
            label={`${rulesSummary.matched_rules_count || 0} règle(s) matchée(s)`}
          />
        </div>
        <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          Dernier digest: {lastDigestLabel(prefsData?.last_digest_sent_at)}
        </div>
      </div>
    ) : activeTab === "sla" ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <StatusPill
            status={(slaSummary.breached_count || 0) > 0 ? "danger" : "ok"}
            label={`${slaSummary.breached_count || 0} dépassé(s)`}
          />
          <StatusPill status={watchedSlaCount > 0 ? "warn" : "muted"} label={`${watchedSlaCount} à surveiller`} />
        </div>
        <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {slaItems.length} tâche(s) suivie(s)
        </div>
      </div>
    ) : (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <StatusPill status={activeRulesCount > 0 ? "ok" : "muted"} label={`${activeRulesCount} active(s)`} />
          <StatusPill
            status={autoTaskRuleCount > 0 ? "purple" : "muted"}
            label={`${autoTaskRuleCount} auto-tâche(s)`}
          />
        </div>
        <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          {rulesSummary.matched_rules_count || 0} match dans le dernier digest
        </div>
      </div>
    );

  return (
    <div>
      <AppPageHeader
        title="Alertes"
        breadcrumb="Alertes"
        description="Alertes persistantes, digest, règles et pilotage SLA."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/automations" className={headerLinkClass} style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
              <Bot className="h-3.5 w-3.5" /> Automatisation
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
          <LoadingCard label="Chargement des notifications, du digest et des SLA..." />
        ) : !notificationsData ? (
          <EmptyCard
            title="Alertes indisponibles"
            description="Le workbench n'a pas encore pu charger les alertes persistantes."
            action={
              <SecondaryButton onClick={() => setRefreshNonce((value) => value + 1)}>
                <RefreshCw className="h-3.5 w-3.5" /> Réessayer
              </SecondaryButton>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <StatusPill
                  status={(notifSummary.unread_count || 0) > 0 ? "warn" : "ok"}
                  label={
                    (notifSummary.unread_count || 0) > 0 ? `${notifSummary.unread_count} non lue(s)` : "Boîte calme"
                  }
                />
                <StatusPill
                  status={(slaSummary.breached_count || 0) > 0 ? "danger" : "muted"}
                  label={
                    (slaSummary.breached_count || 0) > 0
                      ? `${slaSummary.breached_count} SLA dépassé(s)`
                      : "SLA sous contrôle"
                  }
                />
                <StatusPill
                  status={(rulesSummary.matched_rules_count || 0) > 0 ? "purple" : "muted"}
                  label={`${rulesSummary.matched_rules_count || 0} règle(s) matchée(s)`}
                />
              </div>
              <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                {generatedAt ? `Synchro ${formatDateTimeFr(generatedAt)}` : "Synchro en attente"}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label="Non lues"
                value={notifSummary.unread_count || 0}
                sub={`${notifSummary.due_today_count || 0} échéance(s) aujourd'hui`}
                accent="purple"
                icon={<Mail className="h-4 w-4" />}
              />
              <StatCard
                label="Critiques ouvertes"
                value={notifSummary.critical_unread_count || 0}
                sub={`${notifSummary.high_unread_count || 0} hautes`}
                accent={(notifSummary.critical_unread_count || 0) > 0 ? "red" : "amber"}
                icon={<AlertTriangle className="h-4 w-4" />}
              />
              <StatCard
                label="SLA en risque"
                value={slaSummary.breached_count || 0}
                sub={`${watchedSlaCount} à surveiller`}
                accent={(slaSummary.breached_count || 0) > 0 ? "amber" : "green"}
                icon={<Clock3 className="h-4 w-4" />}
              />
              <StatCard
                label="Règles actives"
                value={activeRulesCount}
                sub={`${autoTaskRuleCount} auto-tâche(s)`}
                accent="blue"
                icon={<Wand2 className="h-4 w-4" />}
              />
            </div>

            <OpsPanelShell
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(tab) => setActiveTab(tab)}
              headerActions={panelHeaderActions}
              footer={panelFooter}
            >
              {activeTab === "alerts" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_340px]">
                    <div className="space-y-3">
                      {filteredNotifications.length === 0 ? (
                        <OpsEmptyState
                          icon={<CheckCircle2 className="h-5 w-5" />}
                          title="Aucune alerte pour ce filtre"
                          description="La file reste propre. Vous pouvez attendre le prochain digest ou revoir les règles."
                          action={
                            <Link
                              to="/app/notifications"
                              className="inline-flex items-center gap-1.5 rounded-xl bg-[#eff6ff] px-3 py-2 text-[#1d4ed8]"
                              style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                            >
                              Voir les alertes <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                          }
                        />
                      ) : (
                        filteredNotifications.map((item: any) => {
                          const rowBusy = busyKey === `notif:${item.id}`;
                          const severity = String(item?.severity || "").toLowerCase();
                          const surfaceTone = item.read
                            ? "border-[#e2e8f0] bg-[#f8fafc]"
                            : severity === "critical"
                              ? "border-[#fecaca] bg-[#fff7f7]"
                              : severity === "high"
                                ? "border-[#fde68a] bg-[#fffbeb]"
                                : "border-[#dbeafe] bg-[#f8fbff]";
                          const barTone = item.read
                            ? "bg-[#cbd5e1]"
                            : severity === "critical"
                              ? "bg-[#dc2626]"
                              : severity === "high"
                                ? "bg-[#d97706]"
                                : "bg-[#4f46e5]";
                          return (
                            <div key={item.id} className={`relative overflow-hidden rounded-2xl border ${surfaceTone}`}>
                              <div className={`absolute inset-y-0 left-0 w-1 ${barTone}`} />
                              <div className="flex items-start justify-between gap-4 p-4 pl-5">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <StatusPill {...modulePill(item.module, item.module_label)} />
                                    <StatusPill {...severityPill(item.severity)} />
                                    <StatusPill
                                      status={item.read ? "muted" : "ok"}
                                      label={item.read ? "Lu" : "Nouveau"}
                                    />
                                  </div>
                                  <div className="mt-2 text-[0.975rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                                    {item.title}
                                  </div>
                                  {item.subtitle ? (
                                    <div className="mt-1 text-sm font-semibold text-[#475569]">{item.subtitle}</div>
                                  ) : null}
                                  {item.description ? (
                                    <p className="mt-1.5 text-sm leading-relaxed text-[#64748b]">{item.description}</p>
                                  ) : null}
                                  <div
                                    className="mt-3 flex flex-wrap items-center gap-3 text-[#94a3b8]"
                                    style={{ fontSize: "0.6875rem" }}
                                  >
                                    <span>
                                      {item.due_at
                                        ? `Cible ${formatDateTimeFr(item.due_at)}`
                                        : `Créée ${formatDateFr(item.created_at)}`}
                                    </span>
                                    {item.read_at ? (
                                      <>
                                        <span>•</span>
                                        <span>Lue {formatDateTimeFr(item.read_at)}</span>
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="flex flex-col items-end gap-2">
                                  <Link
                                    to={item.href || "/app/notifications"}
                                    className="inline-flex items-center gap-1 rounded-xl bg-white px-3 py-2 text-[#1d4ed8] shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                                    style={{ fontSize: "0.75rem", fontWeight: 700 }}
                                  >
                                    Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                                  </Link>
                                  <button
                                    type="button"
                                    disabled={rowBusy}
                                    onClick={() => void markOne(item, !item.read)}
                                    className="text-[#475569] transition-colors hover:text-[#0f172a] disabled:opacity-60"
                                    style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                  >
                                    {rowBusy ? "..." : item.read ? "Marquer non lue" : "Marquer lue"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold text-[#0f172a]">Priorité du moment</div>
                            <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                              Le signal à garder en haut de pile avant d'aller dans les réglages.
                            </div>
                          </div>
                          <StatusPill
                            status={
                              heroPriority?.source === "notification"
                                ? "purple"
                                : heroPriority?.source === "sla"
                                  ? "warn"
                                  : "ok"
                            }
                            label={
                              heroPriority?.source === "notification"
                                ? "Alerte"
                                : heroPriority?.source === "sla"
                                  ? "SLA"
                                  : "Calme"
                            }
                          />
                        </div>
                        <div className="mt-4 rounded-2xl border border-[#dde7f1] bg-white p-4">
                          <div className="text-[0.95rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                            {heroAsideTitle}
                          </div>
                          <p className="mt-1.5 text-sm leading-relaxed text-[#64748b]">{heroAsideDescription}</p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Link
                              to={heroAsideHref}
                              className="inline-flex items-center gap-1.5 rounded-xl bg-[#eef2ff] px-3 py-2 text-[#4338ca]"
                              style={{ fontSize: "0.75rem", fontWeight: 700 }}
                            >
                              Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                            <SecondaryButton onClick={() => void markAllRead()} disabled={busyKey === "mark-all"}>
                              {busyKey === "mark-all" ? "En cours..." : "Tout marquer lu"}
                            </SecondaryButton>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="text-sm font-bold text-[#0f172a]">Pilotage rapide</div>
                        <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                          Un résumé compact pour lancer le bon geste sans quitter la vue.
                        </div>
                        <div className="mt-4 space-y-2">
                          {focusSignals.map((signal) => (
                            <div
                              key={signal.label}
                              className="flex items-center justify-between rounded-xl border border-[#e2e8f0] bg-white px-3 py-2.5"
                            >
                              <div className="text-sm font-medium text-[#334155]">{signal.label}</div>
                              <StatusPill status={signal.tone} label="OK" />
                            </div>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <SecondaryButton onClick={() => void runSla()} disabled={busyKey === "sla-run"}>
                            <RefreshCw className="h-3.5 w-3.5" />{" "}
                            {busyKey === "sla-run" ? "Recalcul..." : "Recalculer les SLA"}
                          </SecondaryButton>
                          <Link
                            to="/app/tasks"
                            className="inline-flex items-center gap-1.5 rounded-xl border border-[#d7e3ef] bg-white px-3 py-2 text-[#475569]"
                            style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                          >
                            Tâches <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeTab === "digest" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_360px]">
                    <div className="space-y-3">
                      {digestSections.length === 0 ? (
                        <OpsEmptyState
                          icon={<Mail className="h-5 w-5" />}
                          title="Aucune section digest"
                          description="Le digest n'a pas encore remonté de signaux utiles."
                        />
                      ) : (
                        digestSections.map((section: any) => (
                          <div key={section.key} className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-[0.95rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                                  {section.title}
                                </div>
                                {section.description ? (
                                  <p className="mt-1.5 text-sm leading-relaxed text-[#64748b]">{section.description}</p>
                                ) : null}
                              </div>
                              <StatusPill
                                status={(section.count || 0) > 0 ? "info" : "muted"}
                                label={`${section.count || 0}`}
                              />
                            </div>
                            {Array.isArray(section.items) && section.items.length > 0 ? (
                              <div className="mt-4 space-y-2">
                                {section.items.slice(0, 4).map((item: any) => (
                                  <div key={item.id} className="rounded-xl border border-[#dde7f1] bg-white p-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <StatusPill {...modulePill(item.module, item.module_label)} />
                                      <StatusPill {...severityPill(item.severity)} />
                                    </div>
                                    <div className="mt-2 text-sm font-bold text-[#0f172a]">{item.title}</div>
                                    {item.description ? (
                                      <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                                        {item.description}
                                      </div>
                                    ) : null}
                                    <div className="mt-3 flex items-center justify-between gap-2">
                                      <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                                        {item.due_at
                                          ? `Cible ${formatDateTimeFr(item.due_at)}`
                                          : item.subtitle || "Signal digest"}
                                      </div>
                                      <Link
                                        to={item.href || "/app/notifications"}
                                        className="text-[#1d4ed8]"
                                        style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                      >
                                        Ouvrir
                                      </Link>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-4 text-xs text-[#94a3b8]">Aucun signal dans cette section.</div>
                            )}
                          </div>
                        ))
                      )}
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold text-[#0f172a]">Réglages digest</div>
                            <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                              Cadence, portée et priorité du résumé envoyé à l'équipe.
                            </div>
                          </div>
                          <StatusPill
                            status={prefsData?.delivery_mode === "preview" ? "info" : "ok"}
                            label={prefsData?.delivery_mode === "preview" ? "Aperçu" : "Actif"}
                          />
                        </div>

                        <div className="mt-4 rounded-2xl border border-[#dbeafe] bg-[#eff6ff] p-4">
                          <div className="text-sm font-bold text-[#0f172a]">
                            {digestData?.headline || "Aucun digest pour le moment."}
                          </div>
                          <div className="mt-1.5 text-xs leading-relaxed text-[#64748b]">
                            Dernier digest : {lastDigestLabel(prefsData?.last_digest_sent_at)}
                            {digestSummary.recommended_focus
                              ? ` · Focus recommandé : ${digestSummary.recommended_focus}`
                              : ""}
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <SelectField
                            label="Portée"
                            value={prefsForm.digest_scope}
                            onChange={(event) =>
                              setPrefsForm((prev) => ({ ...prev, digest_scope: event.target.value }))
                            }
                          >
                            <option value="all">Vue complète</option>
                            <option value="urgent">Urgent seulement</option>
                            <option value="team">Équipe / exécution</option>
                          </SelectField>
                          <InputField
                            label="Heure cible"
                            type="number"
                            min={0}
                            max={23}
                            value={prefsForm.digest_hour}
                            onChange={(event) => setPrefsForm((prev) => ({ ...prev, digest_hour: event.target.value }))}
                          />
                        </div>

                        <div className="mt-4 space-y-2">
                          {[
                            ["email_digest_enabled", "Préparer le digest email", "Preview d'envoi"],
                            ["include_weekends", "Inclure le week-end", "Usage continu"],
                            ["critical_boost", "Booster les urgences", "Met les critiques en avant"],
                          ].map(([key, label, sub]: [PrefsBooleanKey, string, string]) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setPrefsForm((prev) => ({ ...prev, [key]: !prev[key] }))}
                              className={`w-full rounded-xl border p-3 text-left transition-colors ${
                                prefsForm[key] ? "border-[#bfdbfe] bg-[#eff6ff]" : "border-[#e2e8f0] bg-white"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-bold text-[#0f172a]">{label}</div>
                                  <div className="mt-1 text-[0.6875rem] text-[#64748b]">{sub}</div>
                                </div>
                                <StatusPill
                                  status={prefsForm[key] ? "ok" : "muted"}
                                  label={prefsForm[key] ? "Oui" : "Non"}
                                />
                              </div>
                            </button>
                          ))}
                        </div>

                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <SecondaryButton disabled={busyKey === "prefs"} onClick={() => void savePreferences()}>
                            {busyKey === "prefs" ? "Enregistrement..." : "Enregistrer"}
                          </SecondaryButton>
                          <PrimaryButton disabled={busyKey === "digest-run"} onClick={() => void runDigest()}>
                            <Mail className="h-3.5 w-3.5" /> {busyKey === "digest-run" ? "Génération..." : "Générer"}
                          </PrimaryButton>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="text-sm font-bold text-[#0f172a]">Historique digest</div>
                        <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                          Les dernières générations et les règles qui ont le plus servi.
                        </div>
                        <div className="mt-4 space-y-2">
                          {digestRuns.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-[#d7e3ef] bg-white p-4 text-sm text-[#94a3b8]">
                              Aucune génération historisée.
                            </div>
                          ) : (
                            digestRuns.slice(0, 4).map((run: any) => (
                              <div key={run.id} className="rounded-xl border border-[#dde7f1] bg-white p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="text-sm font-bold text-[#0f172a]">{run.headline}</div>
                                  <StatusPill
                                    status={(run.auto_tasks_created || 0) > 0 ? "purple" : "muted"}
                                    label={`${run.auto_tasks_created || 0} auto-tâche(s)`}
                                  />
                                </div>
                                <div className="mt-1 text-[0.6875rem] text-[#64748b]">
                                  {formatDateTimeFr(run.generated_at)} · {run.matched_rules_count || 0} règle(s) ·{" "}
                                  {run.total_items || 0} item(s)
                                </div>
                                {Array.isArray(run.notes) && run.notes.length > 0 ? (
                                  <div className="mt-2 text-[0.6875rem] text-[#94a3b8]">{run.notes[0]}</div>
                                ) : null}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeTab === "sla" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_360px]">
                    <div className="space-y-3">
                      {filteredSlaItems.length === 0 ? (
                        <OpsEmptyState
                          icon={<ShieldAlert className="h-5 w-5" />}
                          title="Aucun risque SLA"
                          description="La file suivie par SLA est propre pour ce filtre."
                        />
                      ) : (
                        filteredSlaItems.slice(0, 10).map((item: any) => (
                          <div
                            key={item.task_id}
                            className={`rounded-2xl border p-4 ${
                              item.sla_state === "breached"
                                ? "border-[#fecaca] bg-[#fff7f7]"
                                : item.sla_state === "due_soon" || item.sla_state === "blocked"
                                  ? "border-[#fde68a] bg-[#fffbeb]"
                                  : "border-[#e2e8f0] bg-[#fafbfd]"
                            }`}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill {...modulePill(item.module, item.module_label)} />
                              <StatusPill
                                {...severityPill(
                                  item.priority === "critical"
                                    ? "critical"
                                    : item.priority === "high"
                                      ? "high"
                                      : "medium",
                                )}
                              />
                              <StatusPill
                                status={
                                  item.sla_state === "breached"
                                    ? "danger"
                                    : item.sla_state === "due_soon" || item.sla_state === "blocked"
                                      ? "warn"
                                      : "ok"
                                }
                                label={item.sla_label || item.sla_state}
                              />
                            </div>
                            <div className="mt-2 text-[0.95rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                              {item.title}
                            </div>
                            <div className="mt-1 text-sm text-[#64748b]">
                              {item.assignee_label || "Non assignée"} · {item.status_label || item.status}
                            </div>
                            <div className="mt-2 text-[0.6875rem] text-[#94a3b8]">
                              {item.target_at ? `Cible ${formatDateTimeFr(item.target_at)}` : "Sans cible"}
                              {item.breach_minutes
                                ? ` · +${minutesToLabel(item.breach_minutes)}`
                                : item.minutes_remaining != null
                                  ? ` · reste ${minutesToLabel(item.minutes_remaining)}`
                                  : ""}
                              {item.escalation_level ? ` · escalade ${item.escalation_level}` : ""}
                            </div>
                            <div className="mt-3">
                              <Link
                                to={item.href || "/app/tasks"}
                                className="inline-flex items-center gap-1 text-[#1d4ed8]"
                                style={{ fontSize: "0.75rem", fontWeight: 700 }}
                              >
                                Ouvrir la tâche <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold text-[#0f172a]">Politique SLA</div>
                            <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                              Seuils de lecture, alerte précoce et escalade automatique.
                            </div>
                          </div>
                          <StatusPill status="info" label="Persistant" />
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-3">
                          {[
                            ["critical", "Critique"],
                            ["high", "Haute"],
                            ["medium", "Normale"],
                            ["low", "Basse"],
                          ].map(([key, label]: [PolicyFormKey, string]) => (
                            <InputField
                              key={key}
                              label={`${label} (h)`}
                              type="number"
                              min={1}
                              max={336}
                              value={policyForm[key]}
                              onChange={(event) => setPolicyForm((prev) => ({ ...prev, [key]: event.target.value }))}
                            />
                          ))}
                          <InputField
                            label="Prévenir avant (h)"
                            type="number"
                            min={1}
                            max={168}
                            value={policyForm.notify_before_hours}
                            onChange={(event) =>
                              setPolicyForm((prev) => ({ ...prev, notify_before_hours: event.target.value }))
                            }
                          />
                          <InputField
                            label="Escalader après (h)"
                            type="number"
                            min={1}
                            max={336}
                            value={policyForm.escalate_after_hours}
                            onChange={(event) =>
                              setPolicyForm((prev) => ({ ...prev, escalate_after_hours: event.target.value }))
                            }
                          />
                        </div>

                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <SecondaryButton onClick={() => void runSla()} disabled={busyKey === "sla-run"}>
                            <RefreshCw className="h-3.5 w-3.5" /> {busyKey === "sla-run" ? "Recalcul..." : "Recalculer"}
                          </SecondaryButton>
                          <PrimaryButton onClick={() => void savePolicy()} disabled={busyKey === "policy"}>
                            {busyKey === "policy" ? "Enregistrement..." : "Enregistrer"}
                          </PrimaryButton>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="text-sm font-bold text-[#0f172a]">Vue rapide</div>
                        <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                          Le minimum pour savoir si on doit relancer l'équipe ou simplement laisser tourner.
                        </div>
                        <div className="mt-4 space-y-2">
                          {[
                            {
                              label: "Alertes non lues",
                              value: notifSummary.unread_count || 0,
                              tone: (notifSummary.unread_count || 0) > 0 ? "info" : "muted",
                            },
                            {
                              label: "Critiques ouvertes",
                              value: notifSummary.critical_unread_count || 0,
                              tone: (notifSummary.critical_unread_count || 0) > 0 ? "danger" : "muted",
                            },
                            {
                              label: "SLA à reprendre",
                              value: slaSummary.breached_count || 0,
                              tone: (slaSummary.breached_count || 0) > 0 ? "warn" : "muted",
                            },
                          ].map((item: { label: string; value: number; tone: NotificationPillTone }) => (
                            <div
                              key={item.label}
                              className="flex items-center justify-between rounded-xl border border-[#e2e8f0] bg-white px-3 py-2.5"
                            >
                              <div className="text-sm font-medium text-[#334155]">{item.label}</div>
                              <StatusPill status={item.tone} label={String(item.value)} />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeTab === "rules" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_380px]">
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-[220px] flex-1">
                            <SelectField
                              label="Module"
                              value={rulesModuleFilter}
                              onChange={(event) => setRulesModuleFilter(event.target.value)}
                            >
                              <option value="all">Tous les modules</option>
                              <option value="collections">Factures en retard</option>
                              <option value="payments">Paiements</option>
                              <option value="purchases">Achats</option>
                              <option value="recurring">Récurrence</option>
                              <option value="tasks">Tâches</option>
                              <option value="campaigns">Campagnes</option>
                              <option value="scheduler">Planification</option>
                              <option value="setup">Configuration</option>
                            </SelectField>
                          </div>
                          <SecondaryButton onClick={() => setRulesModuleFilter("all")}>
                            <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
                          </SecondaryButton>
                        </div>
                      </div>

                      {visibleRules.length === 0 ? (
                        <OpsEmptyState
                          icon={<Wand2 className="h-5 w-5" />}
                          title="Aucune règle pour ce filtre"
                          description="Ajuste le filtre module ou crée une règle depuis le panneau de droite."
                        />
                      ) : (
                        visibleRules.map((rule: any) => {
                          const isBusy = busyKey === `rule:${rule.id}` || busyKey === `rule-delete:${rule.id}`;
                          const isEditing = editingRuleId === rule.id;
                          return (
                            <div
                              key={rule.id}
                              className={`rounded-2xl border p-4 ${
                                isEditing ? "border-[#c4b5fd] bg-[#faf5ff]" : "border-[#e9eef4] bg-[#fafbfd]"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <StatusPill {...modulePill(rule.module, rule.module_label)} />
                                    <StatusPill {...severityPill(rule.min_severity)} />
                                    <StatusPill
                                      status={rule.active ? "ok" : "muted"}
                                      label={rule.active ? "Active" : "Suspendue"}
                                    />
                                    {rule.include_in_digest ? <StatusPill status="info" label="Digest" /> : null}
                                    {rule.auto_task ? <StatusPill status="purple" label="Auto-tâche" /> : null}
                                    {isEditing ? <StatusPill status="purple" label="Édition" /> : null}
                                  </div>
                                  <div className="mt-2 text-[0.95rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                                    {rule.name}
                                  </div>
                                  <div className="mt-1 text-sm text-[#64748b]">
                                    {triggerLabel(rule.trigger_type)} · {roleLabel(rule.owner_role)} ·{" "}
                                    {rule.matched_count || 0} signal(s)
                                  </div>
                                  {rule.notes ? (
                                    <p className="mt-2 text-sm leading-relaxed text-[#64748b]">{rule.notes}</p>
                                  ) : null}
                                  {ruleTargetingLabels(rule).length > 0 ? (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {ruleTargetingLabels(rule).map((label: string) => (
                                        <span
                                          key={label}
                                          className="inline-flex items-center rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-2.5 py-1 text-[#1d4ed8]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                        >
                                          {label}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                  {Array.isArray(rule.sample_titles) && rule.sample_titles.length > 0 ? (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {rule.sample_titles.slice(0, 3).map((title: string) => (
                                        <span
                                          key={title}
                                          className="inline-flex items-center rounded-full border border-[#e2e8f0] bg-white px-2.5 py-1 text-[#475569]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 600 }}
                                        >
                                          {title}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                  <div className="mt-3 text-[0.6875rem] text-[#94a3b8]">
                                    Dernier match :{" "}
                                    {rule.last_matched_at ? formatDateTimeFr(rule.last_matched_at) : "jamais"}
                                  </div>
                                </div>
                                <div className="flex flex-col items-end gap-2">
                                  <SecondaryButton disabled={isBusy} onClick={() => loadRuleIntoEditor(rule)}>
                                    <PencilLine className="h-3.5 w-3.5" /> Modifier
                                  </SecondaryButton>
                                  <ActionMenu label="Actions" align="right">
                                    <ActionMenuButton icon={Copy} onClick={() => duplicateRule(rule)}>
                                      Dupliquer
                                    </ActionMenuButton>
                                    <ActionMenuButton
                                      onClick={() =>
                                        void patchRule(
                                          rule,
                                          { active: !rule.active },
                                          rule.active
                                            ? `Règle “${rule.name}” suspendue.`
                                            : `Règle “${rule.name}” réactivée.`,
                                        )
                                      }
                                    >
                                      {rule.active ? "Suspendre" : "Activer"}
                                    </ActionMenuButton>
                                    <ActionMenuButton
                                      onClick={() =>
                                        void patchRule(
                                          rule,
                                          { include_in_digest: !rule.include_in_digest },
                                          rule.include_in_digest
                                            ? `Règle “${rule.name}” retirée du digest.`
                                            : `Règle “${rule.name}” ajoutée au digest.`,
                                        )
                                      }
                                    >
                                      {rule.include_in_digest ? "Retirer du digest" : "Mettre au digest"}
                                    </ActionMenuButton>
                                    <ActionMenuButton
                                      onClick={() =>
                                        void patchRule(
                                          rule,
                                          { auto_task: !rule.auto_task },
                                          rule.auto_task
                                            ? `Auto-tâche désactivée pour “${rule.name}”.`
                                            : `Auto-tâche activée pour “${rule.name}”.`,
                                        )
                                      }
                                    >
                                      {rule.auto_task ? "Couper l'auto-tâche" : "Activer l'auto-tâche"}
                                    </ActionMenuButton>
                                    <ActionMenuButton tone="danger" icon={Trash2} onClick={() => void deleteRule(rule)}>
                                      Supprimer
                                    </ActionMenuButton>
                                  </ActionMenu>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-bold text-[#0f172a]">
                            {editingRuleId ? "Modifier une règle" : "Nouvelle règle"}
                          </div>
                          <div className="mt-1 text-xs leading-relaxed text-[#64748b]">
                            Cadre le module, le déclencheur et l'option d'auto-tâche sans quitter le board.
                          </div>
                        </div>
                        <StatusPill
                          status={editingRuleId ? "purple" : "info"}
                          label={editingRuleId ? "Édition" : "Création"}
                        />
                      </div>

                      {editingRuleId ? (
                        <div className="mt-4 rounded-xl border border-[#ddd6fe] bg-[#f5f3ff] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs font-semibold text-[#5b21b6]">
                              Vous modifiez une règle existante.
                            </div>
                            <SecondaryButton onClick={() => resetRuleEditor(ruleForm.module)}>
                              <RotateCcw className="h-3.5 w-3.5" /> Revenir en création
                            </SecondaryButton>
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-4 space-y-3">
                        <InputField
                          label="Nom de la règle"
                          value={ruleForm.name}
                          onChange={(event) => setRuleForm((prev) => ({ ...prev, name: event.target.value }))}
                          placeholder="Ex. Paiements sans référence"
                        />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <SelectField
                            label="Module"
                            value={ruleForm.module}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, module: event.target.value }))}
                          >
                            <option value="collections">Factures en retard</option>
                            <option value="payments">Paiements</option>
                            <option value="purchases">Achats</option>
                            <option value="recurring">Récurrence</option>
                            <option value="tasks">Tâches</option>
                            <option value="campaigns">Campagnes</option>
                            <option value="scheduler">Planification</option>
                            <option value="setup">Configuration</option>
                          </SelectField>
                          <SelectField
                            label="Déclencheur"
                            value={ruleForm.trigger_type}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, trigger_type: event.target.value }))}
                          >
                            <option value="urgent_unread">Alertes non lues</option>
                            <option value="sla_breached">SLA dépassé</option>
                            <option value="due_today">Échéance aujourd'hui</option>
                            <option value="payment_gap">Paiement à fiabiliser</option>
                            <option value="purchase_waiting">Achat à débloquer</option>
                            <option value="recurring_due">Récurrence à exécuter</option>
                          </SelectField>
                          <SelectField
                            label="Seuil minimum"
                            value={ruleForm.min_severity}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, min_severity: event.target.value }))}
                          >
                            <option value="critical">Critique</option>
                            <option value="high">Haute</option>
                            <option value="medium">Normale</option>
                            <option value="low">Basse</option>
                          </SelectField>
                          <SelectField
                            label="Rôle responsable"
                            value={ruleForm.owner_role}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, owner_role: event.target.value }))}
                          >
                            <option value="owner">Owner</option>
                            <option value="admin">Admin</option>
                            <option value="accountant">Compta</option>
                            <option value="viewer">Viewer</option>
                          </SelectField>
                          <InputField
                            label="Montant mini (€)"
                            value={ruleForm.min_amount}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, min_amount: event.target.value }))}
                            placeholder="Ex. 1500"
                            inputMode="decimal"
                          />
                          <InputField
                            label="Ancienneté mini (jours)"
                            value={ruleForm.min_age_days}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, min_age_days: event.target.value }))}
                            placeholder="Ex. 7"
                            inputMode="numeric"
                          />
                        </div>
                        <InputField
                          label="Mot-clé optionnel"
                          value={ruleForm.keyword}
                          onChange={(event) => setRuleForm((prev) => ({ ...prev, keyword: event.target.value }))}
                          placeholder="Client, fournisseur, sujet..."
                        />
                        <div>
                          <label className="mb-1.5 block text-sm font-medium text-[#374151]">Note interne</label>
                          <textarea
                            value={ruleForm.notes}
                            onChange={(event) => setRuleForm((prev) => ({ ...prev, notes: event.target.value }))}
                            rows={3}
                            className="w-full rounded-lg border border-[#e2e8f0] bg-white px-3.5 py-2.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20"
                            placeholder="Pourquoi cette règle est utile dans le quotidien équipe ?"
                          />
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2">
                        {[
                          ["include_in_digest", "Remonter dans le digest"],
                          ["auto_task", "Créer une tâche auto"],
                        ].map(([key, label]: [RuleBooleanKey, string]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setRuleForm((prev) => ({ ...prev, [key]: !prev[key] }))}
                            className={`w-full rounded-xl border p-3 text-left transition-colors ${
                              ruleForm[key] ? "border-[#bfdbfe] bg-[#eff6ff]" : "border-[#e2e8f0] bg-white"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-bold text-[#0f172a]">{label}</div>
                              <StatusPill
                                status={ruleForm[key] ? "ok" : "muted"}
                                label={ruleForm[key] ? "Oui" : "Non"}
                              />
                            </div>
                          </button>
                        ))}
                      </div>

                      <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <SecondaryButton onClick={() => resetRuleEditor(ruleForm.module)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
                        </SecondaryButton>
                        <PrimaryButton
                          disabled={busyKey === "rule-create" || busyKey === `rule-save:${editingRuleId}`}
                          onClick={() => void saveRule()}
                        >
                          {busyKey === "rule-create" || busyKey === `rule-save:${editingRuleId}`
                            ? editingRuleId
                              ? "Enregistrement..."
                              : "Ajout..."
                            : editingRuleId
                              ? "Enregistrer"
                              : "Ajouter"}
                        </PrimaryButton>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <OpsMiniStat
                      label="Digest auto"
                      value={prefsForm.email_digest_enabled ? "Oui" : "Non"}
                      detail="Mode email"
                      accent="blue"
                    />
                    <OpsMiniStat
                      label="Week-end"
                      value={prefsForm.include_weekends ? "Oui" : "Non"}
                      detail="Couverture"
                      accent="green"
                    />
                    <OpsMiniStat
                      label="Booster urgences"
                      value={prefsForm.critical_boost ? "Oui" : "Non"}
                      detail="Tri du digest"
                      accent="purple"
                    />
                    <OpsMiniStat
                      label="Scope digest"
                      value={scopeLabel(prefsForm.digest_scope)}
                      detail="Vue choisie"
                      accent="amber"
                    />
                  </div>

                  <div className="rounded-2xl border border-[#e9eef4] bg-[#fafbfd] p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[1rem] font-[760] tracking-[-0.02em] text-[#0f172a]">Pilotage global</div>
                        <div className="mt-1.5 text-sm leading-relaxed text-[#64748b]">
                          Vue d'ensemble du workbench notifications: alertes, digest, règles et SLA réunis.
                        </div>
                      </div>
                      <StatusPill status="info" label="Vue synthèse" />
                    </div>
                    <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      {heroMetrics.map((item) => (
                        <div key={item.label} className="rounded-2xl border border-[#dde7f1] bg-white p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">
                              {item.label}
                            </div>
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#f4f7fb] text-[#64748b]">
                              {item.icon}
                            </div>
                          </div>
                          <div className="mt-3 text-[1.55rem] font-[820] leading-none tracking-[-0.04em] text-[#0f172a]">
                            {item.value}
                          </div>
                          <div className="mt-2 text-xs text-[#64748b]">{item.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </OpsPanelShell>
          </>
        )}
      </div>
    </div>
  );
}
