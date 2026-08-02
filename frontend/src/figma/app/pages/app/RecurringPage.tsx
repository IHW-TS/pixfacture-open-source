"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { Link } from "@/figma/react-router-compat";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession } from "@/lib/useSession";
import {
  AppPageHeader,
  Card,
  InputField,
  PrimaryButton,
  PrimaryLinkButton,
  SecondaryButton,
  SelectField,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import { CopyPlus, Pause, Pencil, Play, Plus, RefreshCw, RotateCw } from "lucide-react";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";

type RecurringPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";
type RecurringFilter = "all" | "active" | "paused" | "ended";

const tableTh: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 700,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "0.625rem 1rem",
  textAlign: "left",
};

const tableTd: CSSProperties = {
  fontSize: "0.8125rem",
  color: "#374151",
  padding: "0.75rem 1rem",
  borderTop: "1px solid #f1f5f9",
  verticalAlign: "middle",
};

const money = (value: any, currency = "EUR") =>
  `${Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${
    currency === "EUR" ? "€" : currency
  }`;

function cadenceLabel(value: string, intervalDays?: number | null) {
  const normalized = String(value || "monthly").toLowerCase();
  if (normalized === "monthly") return "Mensuel";
  if (normalized === "quarterly") return "Trimestriel";
  if (normalized === "yearly") return "Annuel";
  if (normalized === "custom_days") return `Tous les ${intervalDays || 30} jours`;
  return normalized;
}

function cadenceHint(value: string, intervalDays?: number | null) {
  const normalized = String(value || "monthly").toLowerCase();
  if (normalized === "monthly") return "1 brouillon / mois";
  if (normalized === "quarterly") return "1 brouillon / trimestre";
  if (normalized === "yearly") return "1 brouillon / an";
  if (normalized === "custom_days") return `Cycle ${intervalDays || 30} jours`;
  return "Cadence personnalisée";
}

function runStatusPill(status: string | null | undefined): { status: RecurringPillTone; label: string } {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "success" || normalized === "ok") return { status: "ok", label: "OK" };
  if (normalized === "error" || normalized === "failed") return { status: "danger", label: "Erreur" };
  if (!normalized) return { status: "muted", label: "—" };
  return { status: "muted", label: normalized };
}

function toApiDateTime(dateValue?: string | null) {
  const value = (dateValue || "").trim();
  if (!value) return null;
  return `${value}T09:00:00`;
}

function toInputDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function isEndedProfile(profile: any) {
  const status = String(profile?.status || profile?.state || "").toLowerCase();
  return ["ended", "archived", "completed", "terminated"].includes(status);
}

function profileStatus(profile: any): { status: RecurringPillTone; label: string } {
  if (isEndedProfile(profile)) return { status: "muted", label: "Terminé" };
  if (profile?.active === false) return { status: "warn", label: "En pause" };
  return { status: "ok", label: "Actif" };
}

function historyStatus(status: string | null | undefined): { status: RecurringPillTone; label: string } {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "success" || normalized === "ok") return { status: "muted", label: "Brouillon" };
  if (normalized === "issued" || normalized === "sent") return { status: "info", label: "Émise" };
  if (normalized === "paid") return { status: "ok", label: "Payée" };
  if (normalized === "error" || normalized === "failed") return { status: "danger", label: "Erreur" };
  return runStatusPill(status);
}

export function RecurringPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const paymentsGate = resolveProFeatureGate(capabilities, "payments");
  const recurringEnabled = paymentsGate.enabled;
  const searchParams = useSearchParams();
  const sourceFromQuery = searchParams?.get("source") || "";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>({ items: [], summary: null, now: null });
  const [runs, setRuns] = useState<any[]>([]);
  const [invoiceOptions, setInvoiceOptions] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [runningBatch, setRunningBatch] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<RecurringFilter>("all");
  const [page, setPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.recurring.pageSize.v1");
  const [historyPageSize, setHistoryPageSize] = usePersistedListPageSize("pixfacture.recurring.historyPageSize.v1");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<any>({
    source_invoice_id: "",
    name: "",
    cadence: "monthly",
    interval_days: "30",
    next_run_at: "",
    note: "",
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [profilesRes, invoicesRes, runsRes] = await Promise.allSettled([
        rawApi("/api/recurring"),
        rawApi("/api/invoices?limit=50&offset=0"),
        rawApi("/api/recurring/runs"),
      ]);

      let nextPayload: any = { items: [], summary: null, now: null };
      if (profilesRes.status === "fulfilled" && profilesRes.value.ok) {
        nextPayload = (await profilesRes.value.json().catch(() => nextPayload)) || nextPayload;
      } else {
        const profileErr = profilesRes.status === "fulfilled" ? await profilesRes.value.json().catch(() => null) : null;
        throw new Error(
          extractUserFacingApiMessage(
            profileErr,
            profilesRes.status === "fulfilled" ? profilesRes.value.status : undefined,
            "Impossible de charger la récurrence.",
          ),
        );
      }
      setPayload(nextPayload);

      if (invoicesRes.status === "fulfilled" && invoicesRes.value.ok) {
        const invoiceData = await invoicesRes.value.json().catch(() => []);
        setInvoiceOptions(
          Array.isArray(invoiceData) ? invoiceData.filter((item: any) => item?.type !== "credit_note") : [],
        );
      } else {
        setInvoiceOptions([]);
      }

      if (runsRes.status === "fulfilled" && runsRes.value.ok) {
        const runsData = await runsRes.value.json().catch(() => ({ items: [] }));
        setRuns(Array.isArray(runsData?.items) ? runsData.items : []);
      } else {
        setRuns([]);
      }
    } catch (err) {
      setPayload({ items: [], summary: null, now: null });
      setRuns([]);
      setInvoiceOptions([]);
      setError(formatApiError(err, "Impossible de charger les plans récurrents."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!recurringEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [recurringEnabled, sessionLoading]);

  useEffect(() => {
    if (!sourceFromQuery || !invoiceOptions.length || form.source_invoice_id) return;
    const found = invoiceOptions.find((invoice) => invoice.id === sourceFromQuery);
    if (!found) return;
    setForm((prev: any) => ({
      ...prev,
      source_invoice_id: found.id,
      name: prev.name || `${found.customer_name || "Client"} · ${found.number || "récurrence mensuelle"}`,
      next_run_at: prev.next_run_at || new Date().toISOString().slice(0, 10),
    }));
    setShowForm(true);
  }, [sourceFromQuery, invoiceOptions, form.source_invoice_id]);

  const items = useMemo(() => (Array.isArray(payload?.items) ? payload.items : []), [payload?.items]);
  const summary = payload?.summary || {};
  const now = useMemo(() => (payload?.now ? new Date(payload.now) : new Date()), [payload?.now]);
  const dueNow = useMemo(
    () =>
      items.filter(
        (item: any) =>
          item.active !== false && item.next_run_at && new Date(item.next_run_at).getTime() <= now.getTime(),
      ),
    [items, now],
  );
  const selectedSource = useMemo(
    () => invoiceOptions.find((invoice) => invoice.id === form.source_invoice_id) || null,
    [invoiceOptions, form.source_invoice_id],
  );

  const activeCount = Number(summary?.active_count ?? items.filter((item: any) => item.active !== false).length);
  const pausedCount = Number(summary?.paused_count ?? items.filter((item: any) => item.active === false).length);
  const endedItems = useMemo(() => items.filter((item: any) => isEndedProfile(item)), [items]);
  const invoiceById = useMemo(
    () => new Map<string, any>(invoiceOptions.map((invoice: any) => [String(invoice.id), invoice])),
    [invoiceOptions],
  );
  const profileById = useMemo(() => new Map<string, any>(items.map((item: any) => [String(item.id), item])), [items]);

  const filteredItems = useMemo(() => {
    if (tab === "active") return items.filter((item: any) => item.active !== false && !isEndedProfile(item));
    if (tab === "paused") return items.filter((item: any) => item.active === false);
    if (tab === "ended") return endedItems;
    return items;
  }, [endedItems, items, tab]);
  const pageItems = useMemo(() => paginateList(filteredItems, page, pageSize), [filteredItems, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [tab]);

  const tabs: Array<{ key: RecurringFilter; label: string; count: number }> = [
    { key: "all", label: "Tous", count: items.length },
    { key: "active", label: "Actifs", count: activeCount },
    { key: "paused", label: "En pause", count: pausedCount },
    { key: "ended", label: "Terminés", count: endedItems.length },
  ];

  const amountForProfile = (profile: any) => {
    const source = invoiceById.get(String(profile?.source_invoice_id || ""));
    return Number(profile?.source_total_inc_vat ?? profile?.last_generated_total ?? source?.total_inc_vat ?? 0);
  };

  const historyRows = useMemo(
    () =>
      runs.flatMap((run: any) =>
        (Array.isArray(run?.items) ? run.items : []).map((entry: any, index: number) => {
          const profile = profileById.get(String(entry?.profile_id || ""));
          const source = invoiceById.get(String(profile?.source_invoice_id || ""));
          return {
            id: `${run.id || "run"}-${entry?.profile_id || index}-${index}`,
            date: run.finished_at || run.started_at,
            plan: entry?.profile_name || profile?.name || "Plan récurrent",
            invoiceId: entry?.invoice_id || profile?.last_generated_invoice_id || "",
            invoiceNumber: entry?.invoice_number || profile?.last_generated_invoice_number || entry?.invoice_id || "—",
            amount: Number(
              profile?.source_total_inc_vat ?? profile?.last_generated_total ?? source?.total_inc_vat ?? 0,
            ),
            currency: profile?.currency || "EUR",
            status: historyStatus(entry?.status),
          };
        }),
      ),
    [profileById, runs, invoiceById],
  );
  const pageHistoryRows = useMemo(
    () => paginateList(historyRows, historyPage, historyPageSize),
    [historyPage, historyPageSize, historyRows],
  );

  useEffect(() => {
    setHistoryPage(1);
  }, [historyRows.length]);

  const resetForm = () => {
    setForm({
      source_invoice_id: sourceFromQuery || "",
      name: "",
      cadence: "monthly",
      interval_days: "30",
      next_run_at: "",
      note: "",
    });
    setEditingId(null);
  };

  const openCreateForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (profile: any) => {
    setEditingId(profile.id);
    setForm({
      source_invoice_id: profile.source_invoice_id || "",
      name: profile.name || "",
      cadence: profile.cadence || "monthly",
      interval_days: String(profile.interval_days || 30),
      next_run_at: toInputDate(profile.next_run_at),
      note: profile.note || "",
    });
    setShowForm(true);
  };

  const saveProfile = async () => {
    if (!editingId && !form.source_invoice_id) {
      setError("Choisissez d'abord une facture source.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = JSON.stringify({
        source_invoice_id: editingId ? undefined : form.source_invoice_id,
        name: (form.name || "").trim() || null,
        cadence: form.cadence,
        interval_days: form.cadence === "custom_days" ? Number(form.interval_days || 30) : null,
        next_run_at: toApiDateTime(form.next_run_at),
        note: (form.note || "").trim() || null,
      });
      await api(editingId ? `/api/recurring/${editingId}` : "/api/recurring", {
        method: editingId ? "PATCH" : "POST",
        body,
      });
      setNotice(editingId ? "Plan récurrent mis à jour." : "Plan récurrent créé.");
      resetForm();
      setShowForm(false);
      await load();
    } catch (err) {
      setError(formatApiError(err, editingId ? "Mise à jour du plan impossible." : "Création du plan impossible."));
    } finally {
      setSaving(false);
    }
  };

  const runDueBatch = async () => {
    if (!dueNow.length) {
      setNotice("Aucune échéance due à exécuter pour le moment.");
      return;
    }
    setRunningBatch(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/recurring/run-due", {
        method: "POST",
        body: JSON.stringify({ profile_ids: dueNow.map((item: any) => item.id), limit: Math.min(dueNow.length, 50) }),
      });
      const generated = Number(result?.run?.generated_count || 0);
      const errors = Number(result?.run?.error_count || 0);
      setNotice(`${generated} brouillon(s) généré(s)${errors ? ` · ${errors} erreur(s)` : ""}.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Exécution batch impossible."));
    } finally {
      setRunningBatch(false);
    }
  };

  const runProfileAction = async (profile: any, action: "generate" | "toggle" | "delete") => {
    setBusyId(profile.id);
    setError(null);
    setNotice(null);
    try {
      if (action === "generate") {
        const result: any = await api(`/api/recurring/${profile.id}/generate`, { method: "POST" });
        setNotice(`Brouillon généré${result?.invoice_number ? ` (${result.invoice_number})` : ""}.`);
      } else if (action === "toggle") {
        await api(`/api/recurring/${profile.id}`, {
          method: "PATCH",
          body: JSON.stringify({ active: !profile.active }),
        });
        setNotice(profile.active ? "Plan mis en pause." : "Plan réactivé.");
      } else {
        if (typeof window !== "undefined" && !window.confirm(`Supprimer le plan « ${profile.name || "plan"} » ?`)) {
          return;
        }
        await api(`/api/recurring/${profile.id}`, { method: "DELETE" });
        setNotice("Plan supprimé.");
      }
      await load();
    } catch (err) {
      setError(
        formatApiError(
          err,
          action === "generate"
            ? "Génération impossible."
            : action === "toggle"
              ? "Mise à jour impossible."
              : "Suppression impossible.",
        ),
      );
    } finally {
      setBusyId(null);
    }
  };

  if (sessionLoading) {
    return (
      <div>
        <AppPageHeader
          title="Récurrence"
          breadcrumb="Avancé"
          description="Plans récurrents et génération automatique."
        />
        <WorkbenchPage>
          <LoadingCard label="Chargement des droits…" />
        </WorkbenchPage>
      </div>
    );
  }

  if (!recurringEnabled) {
    return (
      <div>
        <AppPageHeader
          title="Récurrence"
          breadcrumb="Avancé"
          description="Création planifiée de brouillons disponible avec Pro."
        />
        <WorkbenchPage>
          <UpgradeNoticeCard
            title={
              paymentsGate.reactivationRequired
                ? paymentsGate.statusLabel
                : "Factures récurrentes réservées au plan Pro"
            }
            description={
              paymentsGate.reactivationDescription ||
              "Starter reste centré sur la création manuelle de clients, devis et factures. Passez à Pro pour planifier la génération de brouillons récurrents."
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
        title="Récurrence"
        breadcrumb="Avancé"
        description="Plans récurrents et génération automatique."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> Rafraîchir
            </SecondaryButton>
            <PrimaryButton onClick={openCreateForm}>
              <Plus className="h-3.5 w-3.5" /> Nouveau plan
            </PrimaryButton>
          </div>
        }
      />

      <WorkbenchPage>
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {showForm ? (
          <Card className="overflow-hidden p-0" padding={false}>
            <div className="border-b border-[#f1f5f9] bg-[#fafbfd] px-5 py-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "#94a3b8",
                    }}
                  >
                    {editingId ? "Modification" : "Nouveau plan"}
                  </div>
                  <h3 className="mt-1 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 750 }}>
                    {editingId ? "Modifier le plan récurrent" : "Créer une récurrence depuis une facture existante"}
                  </h3>
                  <p className="mt-1 max-w-2xl text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                    Choisissez la facture modèle, la cadence et la première date de génération. Chaque exécution créera
                    un brouillon à contrôler avant émission.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    status={selectedSource ? "ok" : "muted"}
                    label={selectedSource ? "Source sélectionnée" : "Source requise"}
                  />
                  <SecondaryButton
                    onClick={() => {
                      resetForm();
                      setShowForm(false);
                    }}
                  >
                    Fermer
                  </SecondaryButton>
                </div>
              </div>
            </div>

            <div className="p-5">
              {invoiceOptions.length === 0 && !loading ? (
                <EmptyCard
                  title="Aucune facture source disponible"
                  description="Crée d'abord une facture réelle puis reviens ici pour en faire un plan récurrent."
                  action={<PrimaryLinkButton to="/app/invoices/new">Créer une facture</PrimaryLinkButton>}
                />
              ) : (
                <div className="space-y-4">
                  <SelectField
                    label="Facture source"
                    value={form.source_invoice_id}
                    disabled={Boolean(editingId)}
                    onChange={(event) => setForm((prev: any) => ({ ...prev, source_invoice_id: event.target.value }))}
                  >
                    <option value="">Choisir une facture…</option>
                    {invoiceOptions.map((invoice: any) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.number || invoice.id} · {invoice.customer_name || "Client"} ·{" "}
                        {money(invoice.total_inc_vat || 0, invoice.currency || "EUR")}
                      </option>
                    ))}
                  </SelectField>

                  {selectedSource ? (
                    <div className="rounded-2xl border border-[#dbeafe] bg-[#eff6ff] p-4">
                      <div className="text-[#1d4ed8]" style={{ fontSize: "0.6875rem", fontWeight: 700 }}>
                        Source sélectionnée
                      </div>
                      <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 750 }}>
                        {selectedSource.number || selectedSource.id}
                      </div>
                      <div className="mt-1 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                        {selectedSource.customer_name || "Client"} ·{" "}
                        {money(selectedSource.total_inc_vat || 0, selectedSource.currency || "EUR")}
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2">
                    <InputField
                      label="Nom du plan"
                      value={form.name}
                      onChange={(event) => setForm((prev: any) => ({ ...prev, name: event.target.value }))}
                      placeholder="Abonnement mensuel support"
                    />
                    <InputField
                      label="Prochaine génération"
                      type="date"
                      value={form.next_run_at}
                      onChange={(event) => setForm((prev: any) => ({ ...prev, next_run_at: event.target.value }))}
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-end">
                    <SelectField
                      label="Cadence"
                      value={form.cadence}
                      onChange={(event) => setForm((prev: any) => ({ ...prev, cadence: event.target.value }))}
                    >
                      <option value="monthly">Mensuel</option>
                      <option value="quarterly">Trimestriel</option>
                      <option value="yearly">Annuel</option>
                      <option value="custom_days">Tous les X jours</option>
                    </SelectField>
                    {form.cadence === "custom_days" ? (
                      <InputField
                        label="Intervalle (jours)"
                        type="number"
                        min="1"
                        max="365"
                        value={form.interval_days}
                        onChange={(event) => setForm((prev: any) => ({ ...prev, interval_days: event.target.value }))}
                      />
                    ) : (
                      <div
                        className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3.5 py-2.5 text-[#64748b]"
                        style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}
                      >
                        {cadenceHint(form.cadence)}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      Note interne
                    </label>
                    <textarea
                      value={form.note}
                      onChange={(event) => setForm((prev: any) => ({ ...prev, note: event.target.value }))}
                      placeholder="Ex: abonnement mensuel support 3h / licence / maintenance"
                      className="min-h-[96px] w-full rounded-xl border border-[#e2e8f0] bg-white px-3.5 py-2.5 text-sm text-[#0f172a] placeholder:text-[#94a3b8] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20"
                    />
                  </div>

                  <div className="flex flex-col gap-3 border-t border-[#f1f5f9] pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                      La génération produit un brouillon: vous gardez la validation finale avant envoi.
                    </p>
                    <PrimaryButton onClick={saveProfile} disabled={saving || (!editingId && !invoiceOptions.length)}>
                      <CopyPlus className="h-3.5 w-3.5" />
                      {saving ? "Enregistrement…" : editingId ? "Enregistrer" : "Créer le plan"}
                    </PrimaryButton>
                  </div>
                </div>
              )}
            </div>
          </Card>
        ) : null}

        {loading ? (
          <LoadingCard label="Chargement de la récurrence…" />
        ) : (
          <Card className="overflow-hidden p-0" padding={false}>
            <div className="flex flex-col gap-3 border-b border-[#f1f5f9] bg-white px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {tabs.map((item) => {
                  const selected = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTab(item.key)}
                      className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 transition-all"
                      style={{
                        fontSize: "0.8125rem",
                        fontWeight: 600,
                        background: selected ? "#eff6ff" : "transparent",
                        color: selected ? "#1d4ed8" : "#475569",
                      }}
                    >
                      {item.label}
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5"
                        style={{
                          fontSize: "0.6875rem",
                          fontWeight: 750,
                          background: selected ? "#2563eb" : "#f1f5f9",
                          color: selected ? "#fff" : "#94a3b8",
                        }}
                      >
                        {item.count}
                      </span>
                    </button>
                  );
                })}
              </div>
              <PrimaryButton
                onClick={runDueBatch}
                disabled={runningBatch || !dueNow.length}
                className="self-start lg:self-auto"
                style={{
                  background: "#eff6ff",
                  border: "1px solid #dbeafe",
                  boxShadow: "none",
                  color: "#1d4ed8",
                }}
              >
                <Play className="h-3.5 w-3.5" /> {runningBatch ? "Exécution…" : "Exécuter les dues"}
              </PrimaryButton>
            </div>

            {filteredItems.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                  {items.length === 0 ? "Aucun plan récurrent" : "Aucun plan dans ce filtre"}
                </p>
                <p className="mx-auto mt-2 max-w-xl text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                  {items.length === 0
                    ? "Créez un premier plan depuis une facture source pour automatiser vos brouillons."
                    : "Change de filtre pour retrouver les autres plans."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="pf-data-table w-full min-w-[980px]">
                  <thead>
                    <tr style={{ background: "#fafbfd" }}>
                      <th style={tableTh}>Plan</th>
                      <th style={tableTh}>Client</th>
                      <th style={tableTh}>Cadence</th>
                      <th style={tableTh}>Montant</th>
                      <th style={tableTh}>Prochaine</th>
                      <th style={tableTh}>Statut</th>
                      <th style={{ ...tableTh, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((item: any) => {
                      const status = profileStatus(item);
                      const isBusy = busyId === item.id;
                      const isActive = item.active !== false;
                      const amount = amountForProfile(item);
                      return (
                        <tr key={item.id} className="transition-colors hover:bg-[#f8fafc]">
                          <td style={tableTd}>
                            <div className="text-[#0f172a]" style={{ fontWeight: 700 }}>
                              {item.name || "Plan sans nom"}
                            </div>
                          </td>
                          <td style={tableTd}>{item.customer_name || "Client"}</td>
                          <td style={tableTd}>
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1 text-[#475569]"
                              style={{ fontSize: "0.6875rem", fontWeight: 650 }}
                            >
                              <RotateCw className="h-3 w-3" />
                              {cadenceLabel(item.cadence, item.interval_days)}
                            </span>
                          </td>
                          <td style={{ ...tableTd, color: "#0f172a", fontWeight: 700 }}>
                            {money(amount, item.currency || "EUR")}
                          </td>
                          <td style={tableTd}>{formatDateFr(item.next_run_at, "—")}</td>
                          <td style={tableTd}>
                            <StatusPill status={status.status} label={status.label} />
                          </td>
                          <td style={{ ...tableTd, textAlign: "right" }}>
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openEditForm(item)}
                                disabled={isBusy}
                                className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 transition-all active:scale-[0.97] disabled:opacity-50"
                                style={{
                                  fontSize: "0.8125rem",
                                  fontWeight: 700,
                                  background: "#eff6ff",
                                  color: "#1d4ed8",
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" /> Éditer
                              </button>
                              <button
                                type="button"
                                onClick={() => void runProfileAction(item, "toggle")}
                                disabled={isBusy || isEndedProfile(item)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 transition-all active:scale-[0.97] disabled:opacity-50"
                                style={{
                                  fontSize: "0.8125rem",
                                  fontWeight: 700,
                                  background: isActive ? "#fffbeb" : "#ecfdf5",
                                  color: isActive ? "#b45309" : "#047857",
                                }}
                              >
                                {isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                {isActive ? "Pause" : "Reprendre"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <ListPagination
              page={page}
              totalItems={filteredItems.length}
              pageSize={pageSize}
              pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
              itemLabel="plan"
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPage(1);
                setPageSize(nextPageSize);
              }}
              pageSizeAriaLabel="Plans par page"
            />
          </Card>
        )}

        <Card className="overflow-hidden p-0" padding={false}>
          <div className="border-b border-[#f1f5f9] bg-white px-5 py-4">
            <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
              Historique des exécutions
            </h3>
          </div>

          {historyRows.length === 0 ? (
            <div className="px-5 py-9">
              <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                Aucun run batch enregistré pour le moment.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="pf-data-table w-full min-w-[760px]">
                <thead>
                  <tr style={{ background: "#fafbfd" }}>
                    <th style={tableTh}>Date</th>
                    <th style={tableTh}>Plan</th>
                    <th style={tableTh}>Facture</th>
                    <th style={tableTh}>Montant</th>
                    <th style={tableTh}>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {pageHistoryRows.map((row: any) => (
                    <tr key={row.id} className="transition-colors hover:bg-[#f8fafc]">
                      <td style={tableTd}>{formatDateFr(row.date, "—")}</td>
                      <td style={tableTd}>{row.plan}</td>
                      <td style={tableTd}>
                        {row.invoiceId ? (
                          <Link
                            to={`/app/invoices/${row.invoiceId}`}
                            className="font-semibold text-[#1d4ed8] hover:text-[#1e40af]"
                          >
                            {row.invoiceNumber}
                          </Link>
                        ) : (
                          <span className="text-[#94a3b8]">{row.invoiceNumber}</span>
                        )}
                      </td>
                      <td style={{ ...tableTd, color: "#0f172a", fontWeight: 700 }}>
                        {money(row.amount, row.currency || "EUR")}
                      </td>
                      <td style={tableTd}>
                        <StatusPill status={row.status.status} label={row.status.label} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination
            page={historyPage}
            totalItems={historyRows.length}
            pageSize={historyPageSize}
            pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
            itemLabel="run"
            onPageChange={setHistoryPage}
            onPageSizeChange={(nextPageSize) => {
              setHistoryPage(1);
              setHistoryPageSize(nextPageSize);
            }}
            pageSizeAriaLabel="Runs par page"
          />
        </Card>
      </WorkbenchPage>
    </div>
  );
}
