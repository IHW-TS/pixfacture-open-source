"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
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
  BarChart3,
  CheckCircle2,
  Clock3,
  CopyPlus,
  Edit3,
  Inbox,
  Mail,
  Megaphone,
  PlayCircle,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  Users,
  Wand2,
} from "lucide-react";

const PRESETS = {
  dunning_call: {
    name: "Relance du paiement portefeuille",
    dispatch_mode: "hybrid",
    owner_role: "accountant",
    description: "Prépare un emailing ciblé puis ouvre un suivi opérateur unique pour traiter l'encours en retard.",
    subject_template: "{campaign_name} · {recipient_count} client(s) · {overdue_balance} € en retard",
    body_template:
      "Campagne {campaign_name}.\n\nClients ciblés : {customer_names}.\nRetard portefeuille : {overdue_balance} € · encours : {open_balance} €.\nObjectif : sécuriser une date de règlement puis noter la prochaine étape.",
  },
  payment_review: {
    name: "Fiabilisation paiements",
    dispatch_mode: "email_preview",
    owner_role: "accountant",
    description: "Prépare un message simple pour clarifier référence, moyen de paiement et prochaine étape.",
    subject_template: "Paiements à fiabiliser · {recipient_count} client(s) · {open_balance} € ouverts",
    body_template:
      "Campagne {campaign_name}.\n\nClients ciblés : {customer_names}.\nEncours ouvert : {open_balance} €.\nLe message doit clarifier la référence de paiement et la prochaine étape attendue.",
  },
  account_review: {
    name: "Revue comptes clés",
    dispatch_mode: "task_push",
    owner_role: "owner",
    description: "Cadre une revue interne rapide des comptes clés avant qu'une friction n'apparaisse.",
    subject_template: "Comptes clés à revoir · {recipient_count} client(s)",
    body_template:
      "Revue portefeuille : {customer_names}.\nSegments : {segments}.\nEncours : {open_balance} €.\nPréparer une note courte et la prochaine action par compte.",
  },
  reactivation: {
    name: "Réactivation clients dormants",
    dispatch_mode: "hybrid",
    owner_role: "owner",
    description: "Prépare une relance commerciale propre sur les comptes dormants.",
    subject_template: "Réactivation portefeuille · {recipient_count} client(s)",
    body_template:
      "Campagne {campaign_name}.\n\nClients à relancer : {customer_names}.\nObjectif : reprendre contact et proposer une prochaine étape concrète.",
  },
  onboarding_check: {
    name: "Suivi nouveaux clients",
    dispatch_mode: "hybrid",
    owner_role: "accountant",
    description: "Prépare un brief d'onboarding pour sécuriser le premier cycle et la qualité de paiement.",
    subject_template: "Nouveaux clients à consolider · {recipient_count} compte(s)",
    body_template:
      "Clients ciblés : {customer_names}.\nEncours : {open_balance} €.\nVérifier le premier cycle, la qualité de paiement et la prochaine facture attendue.",
  },
  customer_review: {
    name: "Revue santé portefeuille",
    dispatch_mode: "task_push",
    owner_role: "accountant",
    description: "Une trame légère pour revoir la santé du portefeuille sans se disperser.",
    subject_template: "Revue santé portefeuille · {recipient_count} client(s)",
    body_template:
      "Portefeuille ciblé : {customer_names}.\nSegments : {segments}.\nEncours : {open_balance} € · retard : {overdue_balance} €.\nPréparer la prochaine action utile par client.",
  },
} as const;

const EMPTY_CAMPAIGN_WORKBENCH = {
  summary: {},
  campaigns: [],
  templates: [],
  recent_runs: [],
};

type CampaignPresetKey = keyof typeof PRESETS;
type CampaignTab = "templates" | "editor" | "execution" | "history";

function resolvePreset(actionKey: string) {
  return PRESETS[actionKey as CampaignPresetKey] || PRESETS.dunning_call;
}

function localDateLabel(value: any) {
  return formatDateFr(value, "—");
}

function initialForm(actionKey = "dunning_call") {
  const preset = resolvePreset(actionKey);
  return {
    name: preset.name,
    action_key: actionKey,
    description: preset.description,
    dispatch_mode: preset.dispatch_mode,
    owner_role: preset.owner_role,
    active: true,
    subject_template: preset.subject_template,
    body_template: preset.body_template,
  };
}

function dispatchLabel(value: string) {
  if (value === "task_push") return "Tâche assignée";
  if (value === "hybrid") return "Preview + tâche";
  return "Aperçu email";
}

function dispatchTone(value: string): "ok" | "info" | "warn" {
  if (value === "task_push") return "warn";
  if (value === "hybrid") return "info";
  return "ok";
}

function roleLabel(value: string) {
  if (value === "owner") return "Direction";
  if (value === "admin") return "Admin";
  if (value === "viewer") return "Lecture";
  return "Compta";
}

function runTone(value: string | null | undefined): "ok" | "warn" | "danger" | "muted" | "info" | "purple" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "ok" || normalized === "success") return "ok";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "error" || normalized === "failed") return "danger";
  if (normalized === "purple") return "purple";
  if (normalized === "info") return "info";
  return "muted";
}

function templateSegmentMeta(actionKey: string | null | undefined) {
  const key = String(actionKey || "").toLowerCase();
  if (key === "payment_review") return { label: "Paiements", color: "blue" };
  if (key === "dunning_call") return { label: "Paiement", color: "amber" };
  if (key === "account_review") return { label: "Comptes clés", color: "purple" };
  if (key === "reactivation") return { label: "Dormants", color: "muted" };
  if (key === "onboarding_check") return { label: "Onboarding", color: "blue" };
  if (key === "customer_review") return { label: "Portefeuille", color: "purple" };
  return { label: "Template", color: "muted" };
}

function CampTag({ color, label }: { color: string; label: string }) {
  const cfg: Record<string, { bg: string; text: string; dot: string }> = {
    green: { bg: "#f0fdf4", text: "#15803d", dot: "#22c55e" },
    blue: { bg: "#eff6ff", text: "#1d4ed8", dot: "#3b82f6" },
    amber: { bg: "#fffbeb", text: "#b45309", dot: "#f59e0b" },
    purple: { bg: "#faf5ff", text: "#7c3aed", dot: "#a78bfa" },
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

export function CampaignsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateForm, setTemplateForm] = useState(initialForm());
  const [presetKey, setPresetKey] = useState("dunning_call");
  const [activeTab, setActiveTab] = useState<CampaignTab>("templates");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/ops/portfolio-campaign-workbench");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw data || new Error("Workbench campagnes indisponible.");
      setPayload(data || null);
    } catch (err) {
      setPayload(EMPTY_CAMPAIGN_WORKBENCH);
      setError(formatApiError(err, "Impossible de charger les campagnes portefeuille."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshNonce]);

  const summary = payload?.summary || {};
  const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  const templates = useMemo(() => (Array.isArray(payload?.templates) ? payload.templates : []), [payload?.templates]);
  const recentRuns = Array.isArray(payload?.recent_runs) ? payload.recent_runs : [];
  const activeTemplateCount = templates.filter((item: any) => item.active).length;
  const selectedPreset = resolvePreset(presetKey);
  const selectedTemplateMeta = templates.find((item: any) => String(item.id) === String(editingTemplateId)) || null;

  const filteredTemplates = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter((item: any) =>
      [item.name, item.action_label, item.dispatch_mode_label, item.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [templates, templateSearch]);

  const dueCampaignCount = campaigns.filter((item: any) => Boolean(item?.due_now)).length;
  const previewReadyCount = campaigns.reduce((sum: number, item: any) => sum + Number(item?.email_ready_count || 0), 0);
  const previewMissingCount = campaigns.reduce(
    (sum: number, item: any) => sum + Number(item?.missing_email_count || 0),
    0,
  );
  const recentRunWarningCount = recentRuns.filter((item: any) => runTone(item?.tone || item?.status) !== "ok").length;

  useEffect(() => {
    if (!editingTemplateId && templates.length > 0) {
      setTemplateForm((prev: any) => ({
        ...prev,
        ...(() => {
          const currentActionKey = prev.action_key || templates[0].action_key || "dunning_call";
          const preset = resolvePreset(currentActionKey);
          return {
            name: prev.name || preset.name,
            action_key: prev.action_key || currentActionKey,
            description: prev.description || preset.description,
            dispatch_mode: prev.dispatch_mode || preset.dispatch_mode,
            owner_role: prev.owner_role || preset.owner_role,
            subject_template: prev.subject_template || preset.subject_template,
            body_template: prev.body_template || preset.body_template,
          };
        })(),
      }));
    }
  }, [templates, editingTemplateId]);

  const applyPreset = (actionKey: string) => {
    setEditingTemplateId(null);
    setPresetKey(actionKey);
    setTemplateForm(initialForm(actionKey));
    setActiveTab("editor");
  };

  const startEditTemplate = (template: any) => {
    setEditingTemplateId(String(template.id));
    setPresetKey(template.action_key || "dunning_call");
    setTemplateForm({
      name: template.name || "",
      action_key: template.action_key || "dunning_call",
      description: template.description || "",
      dispatch_mode: template.dispatch_mode || "email_preview",
      owner_role: template.owner_role || "accountant",
      active: Boolean(template.active),
      subject_template: template.subject_template || "",
      body_template: template.body_template || "",
    });
    setActiveTab("editor");
  };

  const resetTemplateForm = () => {
    setEditingTemplateId(null);
    const nextPreset = templateForm.action_key || presetKey || "dunning_call";
    setPresetKey(nextPreset);
    setTemplateForm(initialForm(nextPreset));
    setActiveTab("editor");
  };

  const saveTemplate = async () => {
    setBusyKey("template-save");
    setError(null);
    setNotice(null);
    try {
      const body = {
        name: templateForm.name,
        action_key: templateForm.action_key,
        description: templateForm.description || null,
        dispatch_mode: templateForm.dispatch_mode,
        owner_role: templateForm.owner_role,
        active: Boolean(templateForm.active),
        subject_template: templateForm.subject_template,
        body_template: templateForm.body_template,
      };
      if (editingTemplateId) {
        await api(`/api/ops/portfolio-campaign-templates/${editingTemplateId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setNotice("Template de campagne mis à jour.");
      } else {
        await api("/api/ops/portfolio-campaign-templates", { method: "POST", body: JSON.stringify(body) });
        setNotice("Nouveau template de campagne ajouté.");
      }
      setRefreshNonce((value) => value + 1);
      setEditingTemplateId(null);
      setTemplateForm(initialForm(templateForm.action_key || "dunning_call"));
      setActiveTab("templates");
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer le template de campagne."));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteTemplate = async () => {
    if (!editingTemplateId) return;
    setBusyKey(`template-delete-${editingTemplateId}`);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/ops/portfolio-campaign-templates/${editingTemplateId}`, { method: "DELETE" });
      setNotice("Template de campagne supprimé.");
      setEditingTemplateId(null);
      setTemplateForm(initialForm());
      setRefreshNonce((value) => value + 1);
      setActiveTab("templates");
    } catch (err) {
      setError(formatApiError(err, "Suppression du template impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const runCampaign = async (campaignId: string) => {
    if (!campaignId) return;
    setBusyKey(`run-${campaignId}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/ops/portfolio-campaigns/${campaignId}/run`, { method: "POST" });
      setNotice(`Campagne exécutée : ${result?.campaign_name || "campagne portefeuille"}.`);
      setRefreshNonce((value) => value + 1);
      setActiveTab("history");
    } catch (err) {
      setError(formatApiError(err, "Exécution de la campagne impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const runDueCampaigns = async () => {
    setBusyKey("run-due");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/ops/portfolio-campaigns/run-due", { method: "POST" });
      setNotice(
        `${Number(result?.processed_count || 0)} campagne(s) dues traitée(s) · ${Number(result?.tasks_created || 0)} tâche(s) créée(s).`,
      );
      setRefreshNonce((value) => value + 1);
      setActiveTab("history");
    } catch (err) {
      setError(formatApiError(err, "Exécution des campagnes dues impossible."));
    } finally {
      setBusyKey(null);
    }
  };

  const tabs: Array<{ id: CampaignTab; label: string; badge?: number }> = [
    { id: "templates", label: "Templates", badge: templates.length },
    { id: "editor", label: "Éditeur" },
    { id: "execution", label: "Exécution", badge: campaigns.length },
    { id: "history", label: "Historique", badge: recentRuns.length },
  ];

  const panelActions = (
    <>
      {activeTab === "templates" ? (
        <div className="text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
          {filteredTemplates.length} visible(s)
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setEditingTemplateId(null);
          setTemplateForm(initialForm(presetKey));
          setActiveTab("editor");
        }}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
        style={{ fontSize: "0.8125rem", fontWeight: 600, background: "#eff6ff" }}
      >
        <Plus className="h-3.5 w-3.5" /> Nouveau template
      </button>
      {activeTab === "templates" ? (
        <OpsSearchField
          value={templateSearch}
          onChange={(event) => setTemplateSearch(event.target.value)}
          placeholder="Rechercher un template…"
          className="w-full sm:w-[18rem]"
        />
      ) : null}
    </>
  );

  return (
    <div>
      <AppPageHeader
        title="Campagnes"
        breadcrumb="Pilotage"
        description="Templates, éditeur et suivi."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <Link to="/app/outbox" className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" /> Outbox
              </Link>
            </SecondaryButton>
            <PrimaryButton onClick={() => void runDueCampaigns()} disabled={busyKey === "run-due"}>
              <PlayCircle className="h-3.5 w-3.5" /> {busyKey === "run-due" ? "Exécution…" : "Lancer le preset"}
            </PrimaryButton>
          </div>
        }
      />

      <div className="w-full space-y-6 p-5 lg:p-7">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {loading ? (
          <LoadingCard label="Chargement des campagnes…" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label="Templates actifs"
                value={activeTemplateCount}
                sub="Actifs"
                accent="blue"
                icon={<Target className="h-4 w-4" />}
              />
              <StatCard
                label="À jouer"
                value={Number(summary.due_count || dueCampaignCount || 0)}
                sub={`${campaigns.length} visibles`}
                accent="purple"
                icon={<PlayCircle className="h-4 w-4" />}
              />
              <StatCard
                label="Previews générés"
                value={Number(summary.email_ready_count || previewReadyCount || 0)}
                sub={previewMissingCount > 0 ? `${previewMissingCount} manquant(s)` : "Prêts"}
                accent={previewMissingCount > 0 ? "amber" : "green"}
                icon={<Mail className="h-4 w-4" />}
              />
              <StatCard
                label="Runs récents"
                value={Number(summary.recent_runs_count || recentRuns.length || 0)}
                sub={recentRunWarningCount > 0 ? `${recentRunWarningCount} à surveiller` : "Historique"}
                accent={recentRunWarningCount > 0 ? "amber" : "cyan"}
                icon={<BarChart3 className="h-4 w-4" />}
              />
            </div>

            <OpsPanelShell
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(tab) => setActiveTab(tab)}
              headerActions={panelActions}
            >
              {activeTab === "templates" ? (
                <div className="space-y-5">
                  <div className="grid gap-3 md:grid-cols-2">
                    {filteredTemplates.map((template: any) => {
                      const active = String(template.id) === String(editingTemplateId);
                      const segment = templateSegmentMeta(template.action_key);
                      const matchingCampaign = campaigns.find(
                        (item: any) => String(item?.template?.id || "") === String(template.id),
                      );
                      return (
                        <div
                          key={template.id}
                          onClick={() => startEditTemplate(template)}
                          className="cursor-pointer rounded-2xl p-4 transition-all hover:shadow-md"
                          style={{
                            border: active ? "1.5px solid #1d4ed8" : "1px solid #e9eef4",
                            background: active ? "#f8fbff" : "#fafbfd",
                            boxShadow: active ? "0 0 0 3px #eff6ff" : "none",
                          }}
                        >
                          <div className="mb-3 flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                              <div
                                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                                style={{ background: template.active ? "#eff6ff" : "#f1f5f9" }}
                              >
                                <Megaphone
                                  className="h-4 w-4"
                                  style={{ color: template.active ? "#1d4ed8" : "#94a3b8" }}
                                />
                              </div>
                              <div className="min-w-0">
                                <p
                                  className="truncate text-[#0f172a]"
                                  style={{ fontSize: "0.9375rem", fontWeight: 700 }}
                                >
                                  {template.name}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
                              <CampTag
                                color={template.active ? "green" : "muted"}
                                label={template.active ? "Actif" : "Inactif"}
                              />
                              <CampTag color={segment.color} label={segment.label} />
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 border-t border-[#f1f5f9] pt-3">
                            <div
                              className="min-w-[8rem] flex-1 rounded-lg px-2.5 py-1.5 text-center"
                              style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                            >
                              <p
                                className="text-[#94a3b8]"
                                style={{ fontSize: "0.5625rem", fontWeight: 700, textTransform: "uppercase" }}
                              >
                                Mode
                              </p>
                              <p className="text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                                {template.dispatch_mode_label || dispatchLabel(template.dispatch_mode)}
                              </p>
                            </div>
                            <div
                              className="min-w-[8rem] flex-1 rounded-lg px-2.5 py-1.5 text-center"
                              style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                            >
                              <p
                                className="text-[#94a3b8]"
                                style={{ fontSize: "0.5625rem", fontWeight: 700, textTransform: "uppercase" }}
                              >
                                Modifié
                              </p>
                              <p className="text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                                {localDateLabel(template.updated_at || template.created_at)}
                              </p>
                            </div>

                            <div className="ml-auto flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  startEditTemplate(template);
                                }}
                                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
                                style={{ fontSize: "0.75rem", fontWeight: 600, background: "#eff6ff" }}
                              >
                                <Edit3 className="h-3 w-3" /> Éditer
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (matchingCampaign?.campaign?.id) {
                                    void runCampaign(matchingCampaign.campaign.id);
                                  } else {
                                    setActiveTab("execution");
                                  }
                                }}
                                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-white"
                                style={{
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                                }}
                              >
                                <PlayCircle className="h-3 w-3" /> Lancer
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {filteredTemplates.length === 0 ? (
                    <OpsEmptyState
                      icon={<Inbox className="h-5 w-5" />}
                      title="Aucun template"
                      description="Modifie la recherche ou crée un template."
                      action={
                        <PrimaryButton onClick={() => applyPreset(presetKey)}>
                          <CopyPlus className="h-3.5 w-3.5" /> Charger un preset
                        </PrimaryButton>
                      }
                    />
                  ) : null}
                </div>
              ) : null}

              {activeTab === "editor" ? (
                <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
                  <div className="overflow-hidden rounded-2xl" style={{ border: "1px solid #f1f5f9" }}>
                    <div className="bg-[#fafbfd] px-3 py-2.5" style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <p className="text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                        Templates
                      </p>
                    </div>
                    <div className="divide-y divide-[#f8fafc]">
                      {templates.map((template: any) => {
                        const selected = String(template.id) === String(editingTemplateId);
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => startEditTemplate(template)}
                            className="w-full px-3 py-2.5 text-left transition-all hover:bg-[#f8fafc]"
                            style={{
                              borderLeft: selected ? "2px solid #1d4ed8" : "2px solid transparent",
                              background: selected ? "#f8fbff" : "transparent",
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                style={{ background: template.active ? "#16a34a" : "#cbd5e1" }}
                              />
                              <span
                                className="truncate"
                                style={{
                                  fontSize: "0.8125rem",
                                  fontWeight: selected ? 600 : 500,
                                  color: selected ? "#1d4ed8" : "#374151",
                                }}
                              >
                                {template.name}
                              </span>
                            </div>
                            <p className="pl-3.5 text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                              {template.dispatch_mode_label || dispatchLabel(template.dispatch_mode)}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-2xl border border-[#f1f5f9] bg-[#fafbfd] p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                            {editingTemplateId ? selectedTemplateMeta?.name || "Éditeur" : "Nouveau template"}
                          </h3>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <StatusPill status="info" label={selectedPreset.name} />
                            <StatusPill
                              status={dispatchTone(templateForm.dispatch_mode)}
                              label={dispatchLabel(templateForm.dispatch_mode)}
                            />
                            <StatusPill
                              status={templateForm.owner_role === "owner" ? "warn" : "muted"}
                              label={roleLabel(templateForm.owner_role)}
                            />
                          </div>
                        </div>
                        <label className="flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(templateForm.active)}
                            onChange={(event) =>
                              setTemplateForm((prev: any) => ({ ...prev, active: event.target.checked }))
                            }
                            className="h-3.5 w-3.5 rounded accent-[#1d4ed8]"
                          />
                          <span className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                            Actif
                          </span>
                        </label>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#f1f5f9] p-4">
                      <p
                        className="mb-3 text-[#374151]"
                        style={{
                          fontSize: "0.6875rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        Configuration
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Nom du template
                          </label>
                          <input
                            value={templateForm.name}
                            onChange={(event) =>
                              setTemplateForm((prev: any) => ({ ...prev, name: event.target.value }))
                            }
                            className="w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Action portefeuille
                          </label>
                          <select
                            value={templateForm.action_key}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setPresetKey(nextValue);
                              setTemplateForm((prev: any) => ({ ...prev, action_key: nextValue }));
                            }}
                            className="w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            {Object.entries(PRESETS).map(([key, preset]) => (
                              <option key={key} value={key}>
                                {preset.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Mode de diffusion
                          </label>
                          <select
                            value={templateForm.dispatch_mode}
                            onChange={(event) =>
                              setTemplateForm((prev: any) => ({ ...prev, dispatch_mode: event.target.value }))
                            }
                            className="w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            <option value="email_preview">Aperçu email</option>
                            <option value="task_push">Tâche assignée</option>
                            <option value="hybrid">Preview + tâche</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Rôle pilote
                          </label>
                          <select
                            value={templateForm.owner_role}
                            onChange={(event) =>
                              setTemplateForm((prev: any) => ({ ...prev, owner_role: event.target.value }))
                            }
                            className="w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          >
                            <option value="accountant">Compta</option>
                            <option value="owner">Direction</option>
                            <option value="admin">Admin</option>
                            <option value="viewer">Lecture</option>
                          </select>
                        </div>
                        <div className="md:col-span-2">
                          <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                            Description interne
                          </label>
                          <input
                            value={templateForm.description}
                            onChange={(event) =>
                              setTemplateForm((prev: any) => ({ ...prev, description: event.target.value }))
                            }
                            className="w-full rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                            style={{ fontSize: "0.8125rem", border: "1px solid #e2e8f0" }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#f1f5f9] p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <Mail className="h-4 w-4 text-[#1d4ed8]" />
                        <p
                          className="text-[#374151]"
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                          }}
                        >
                          Message
                        </p>
                      </div>
                      <div className="mb-3">
                        <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                          Objet / titre
                        </label>
                        <textarea
                          rows={2}
                          value={templateForm.subject_template}
                          onChange={(event) =>
                            setTemplateForm((prev: any) => ({ ...prev, subject_template: event.target.value }))
                          }
                          className="w-full resize-none rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                          style={{ fontSize: "0.8125rem", lineHeight: 1.6, border: "1px solid #e2e8f0" }}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[#374151]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                          Corps du message / brief
                        </label>
                        <textarea
                          rows={8}
                          value={templateForm.body_template}
                          onChange={(event) =>
                            setTemplateForm((prev: any) => ({ ...prev, body_template: event.target.value }))
                          }
                          className="w-full resize-none rounded-xl bg-white px-3 py-2 text-[#374151] outline-none"
                          style={{ fontSize: "0.8125rem", lineHeight: 1.7, border: "1px solid #e2e8f0" }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <PrimaryButton onClick={() => void saveTemplate()} disabled={busyKey === "template-save"}>
                        {busyKey === "template-save"
                          ? "Enregistrement…"
                          : editingTemplateId
                            ? "Enregistrer"
                            : "Créer le template"}
                      </PrimaryButton>
                      <SecondaryButton onClick={resetTemplateForm}>
                        <RefreshCw className="h-3.5 w-3.5" /> Réinitialiser
                      </SecondaryButton>
                      {editingTemplateId ? (
                        <SecondaryButton
                          onClick={() => void deleteTemplate()}
                          disabled={busyKey === `template-delete-${editingTemplateId}`}
                          style={{ color: "#dc2626", borderColor: "#fecaca", background: "#fff1f2" }}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Supprimer
                        </SecondaryButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "execution" ? (
                <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
                  <div>
                    <div className="mb-5 grid grid-cols-4 gap-2">
                      {[
                        { label: "EN FILE", value: campaigns.length },
                        { label: "PRÊTS", value: previewReadyCount },
                        { label: "BLOQUÉS", value: previewMissingCount },
                        { label: "RUN EN COURS", value: Number(summary.recent_runs_count || 0) > 0 ? 1 : 0 },
                      ].map((stat) => (
                        <div
                          key={stat.label}
                          className="rounded-xl p-3 text-center"
                          style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                        >
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.5rem",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {stat.label}
                          </p>
                          <p className="text-[#0f172a]" style={{ fontSize: "1.25rem", fontWeight: 800 }}>
                            {stat.value}
                          </p>
                        </div>
                      ))}
                    </div>
                    {campaigns.length === 0 ? (
                      <div
                        className="flex flex-col items-center justify-center rounded-2xl py-16 text-center"
                        style={{ background: "#f8fafc", border: "1px dashed #e2e8f0" }}
                      >
                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
                          <Inbox className="h-6 w-6 text-[#cbd5e1]" />
                        </div>
                        <p className="mb-1 text-[#374151]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                          File d'exécution vide
                        </p>
                        <p
                          className="mb-5 text-[#94a3b8]"
                          style={{ fontSize: "0.8125rem", lineHeight: 1.6, maxWidth: "28ch" }}
                        >
                          Lance une campagne ou choisis un template.
                        </p>
                        <div className="flex items-center gap-2">
                          <Link
                            to="/app/portfolio"
                            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
                            style={{ fontSize: "0.8125rem", fontWeight: 600, background: "#eff6ff" }}
                          >
                            <Users className="h-3.5 w-3.5" /> Portefeuille
                          </Link>
                          <button
                            type="button"
                            onClick={() => setActiveTab("templates")}
                            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-white"
                            style={{
                              fontSize: "0.8125rem",
                              fontWeight: 600,
                              background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                            }}
                          >
                            <PlayCircle className="h-3.5 w-3.5" /> Choisir un template
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {campaigns.map((item: any) => {
                          const campaign = item.campaign || {};
                          const isBusy = busyKey === `run-${campaign.id}`;
                          return (
                            <div
                              key={campaign.id}
                              className="rounded-2xl px-4 py-4 transition-colors hover:bg-[#f8fafc]"
                              style={{ border: "1px solid #f1f5f9" }}
                            >
                              <div className="flex items-center gap-4">
                                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[#eff6ff]">
                                  <Megaphone className="h-4 w-4 text-[#1d4ed8]" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                                    {campaign.name}
                                  </p>
                                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                    {Number(item.email_ready_count || 0)} prêt(s) ·{" "}
                                    {Number(item.missing_email_count || 0)} manquant(s)
                                  </p>
                                </div>
                                <CampTag
                                  color={item.due_now ? "amber" : "blue"}
                                  label={item.due_now ? "À jouer" : "Planifiée"}
                                />
                                <button
                                  type="button"
                                  onClick={() => void runCampaign(campaign.id)}
                                  disabled={isBusy}
                                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-white"
                                  style={{
                                    fontSize: "0.6875rem",
                                    fontWeight: 600,
                                    background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                                  }}
                                >
                                  <PlayCircle className="h-2.5 w-2.5" /> {isBusy ? "…" : "Run"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                      Lancer vite
                    </p>
                    {templates
                      .filter((template: any) => template.active)
                      .map((template: any) => (
                        <div
                          key={template.id}
                          className="flex items-center gap-3 rounded-xl p-3.5 transition-colors hover:bg-[#f8fafc]"
                          style={{ border: "1px solid #f1f5f9" }}
                        >
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[#eff6ff]">
                            <Megaphone className="h-3.5 w-3.5 text-[#1d4ed8]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                              {template.name}
                            </p>
                            <p className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                              {template.dispatch_mode_label || dispatchLabel(template.dispatch_mode)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const matchingCampaign = campaigns.find(
                                (item: any) => String(item?.template?.id || "") === String(template.id),
                              );
                              if (matchingCampaign?.campaign?.id) {
                                void runCampaign(matchingCampaign.campaign.id);
                              } else {
                                startEditTemplate(template);
                              }
                            }}
                            className="flex flex-shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-white"
                            style={{
                              fontSize: "0.6875rem",
                              fontWeight: 600,
                              background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                            }}
                          >
                            <PlayCircle className="h-2.5 w-2.5" /> Run
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {activeTab === "history" ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "RUNS TOTAL", value: recentRuns.length },
                      {
                        label: "ENVOIS OK",
                        value: recentRuns.reduce(
                          (sum: number, run: any) => sum + Number(run.email_ready_count || 0),
                          0,
                        ),
                      },
                      {
                        label: "OUVERTURES",
                        value: recentRuns.reduce(
                          (sum: number, run: any) =>
                            sum + Math.max(0, Number(run.recipients_count || 0) - Number(run.missing_email_count || 0)),
                          0,
                        ),
                      },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-xl p-3 text-center"
                        style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                      >
                        <p
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.5rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {stat.label}
                        </p>
                        <p className="text-[#0f172a]" style={{ fontSize: "1.25rem", fontWeight: 800 }}>
                          {stat.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  {recentRuns.length === 0 ? (
                    <OpsEmptyState
                      icon={<Clock3 className="h-5 w-5" />}
                      title="Aucun run"
                      description="Les exécutions apparaîtront ici."
                    />
                  ) : (
                    <div className="space-y-2">
                      {recentRuns.map((run: any) => (
                        <div
                          key={run.id}
                          className="flex items-center gap-4 rounded-2xl px-4 py-4 transition-colors hover:bg-[#f8fafc]"
                          style={{ border: "1px solid #f1f5f9" }}
                        >
                          <div
                            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                            style={{
                              background: runTone(run.tone || run.status) === "ok" ? "#f0fdf4" : "#fffbeb",
                            }}
                          >
                            <Megaphone
                              className="h-4 w-4"
                              style={{ color: runTone(run.tone || run.status) === "ok" ? "#059669" : "#d97706" }}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                              {run.campaign_name}
                            </p>
                            <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                              {localDateLabel(run.finished_at || run.started_at)}
                            </p>
                          </div>
                          <div className="hidden items-center gap-3 lg:flex">
                            {[
                              { label: "Dest.", value: Number(run.recipients_count || 0) },
                              { label: "Envoyés", value: Number(run.email_ready_count || 0) },
                              {
                                label: "Ouverts",
                                value: Math.max(
                                  0,
                                  Number(run.recipients_count || 0) - Number(run.missing_email_count || 0),
                                ),
                              },
                            ].map((metric) => (
                              <div
                                key={metric.label}
                                className="min-w-[3.5rem] rounded-lg px-3 py-1.5 text-center"
                                style={{ background: "#f8fafc", border: "1px solid #f1f5f9" }}
                              >
                                <p
                                  className="text-[#94a3b8]"
                                  style={{ fontSize: "0.5rem", fontWeight: 700, textTransform: "uppercase" }}
                                >
                                  {metric.label}
                                </p>
                                <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 800 }}>
                                  {metric.value}
                                </p>
                              </div>
                            ))}
                          </div>
                          <CampTag
                            color={runTone(run.tone || run.status) === "ok" ? "green" : "amber"}
                            label={runTone(run.tone || run.status) === "ok" ? "Réussi" : "Partiel"}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </OpsPanelShell>
          </>
        )}
      </div>
    </div>
  );
}
