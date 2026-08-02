"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError, rawApi } from "@/lib/api";
import { QUOTE_PRESETS } from "@/lib/quotePresets";
import {
  AppPageHeader,
  Card,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  StatCard,
} from "./AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "./Feedback";
import { ArrowLeft, Calculator, FilePlus2, Plus, ReceiptText, Search, Sparkles, Trash2 } from "lucide-react";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function money(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function defaultLine() {
  return { id: uid(), product_name: "", quantity: 1, unit_price: 0, vat_rate: 20 };
}

const FACTURX_PROFILES = [
  { value: "minimum", label: "Minimum" },
  { value: "basic", label: "Basic" },
  { value: "en16931", label: "EN16931" },
  { value: "extended", label: "Extended" },
  { value: "extended-ctc-fr", label: "Extended CTC FR" },
];

export function DocumentComposer({ mode, backHref }: { mode: "invoice" | "quote"; backHref: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isInvoice = mode === "invoice";
  const fromQuote = isInvoice ? searchParams.get("from_quote") : null;
  const customerSeed = searchParams.get("customer_id") || "";
  const [customers, setCustomers] = useState<any[]>([]);
  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState(isInvoice ? "" : "service");
  const [convertingQuote, setConvertingQuote] = useState(Boolean(fromQuote));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<any>({
    customer_id: customerSeed,
    currency: "EUR",
    payment_terms: isInvoice ? "30 jours fin de mois" : "Validité 30 jours",
    due_days: 30,
    service_date: new Date().toISOString().slice(0, 10),
    valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    purchase_order_number: "",
    note: "",
    operation_nature: "services",
    facturx_profile: "en16931",
  });
  const [lines, setLines] = useState<any[]>([
    {
      id: uid(),
      product_name: isInvoice ? "Abonnement SaaS" : "Prestation de service",
      quantity: 1,
      unit_price: isInvoice ? 390 : 500,
      vat_rate: 20,
    },
  ]);

  useEffect(() => {
    let cancelled = false;
    const loadReferenceData = async () => {
      setLoadingCustomers(true);
      try {
        const [customersRes, itemsRes] = await Promise.allSettled([
          rawApi("/api/customers?limit=200&offset=0"),
          rawApi("/api/items"),
        ]);

        if (!cancelled) {
          if (customersRes.status === "fulfilled" && customersRes.value.ok) {
            const data = await customersRes.value.json().catch(() => []);
            setCustomers(Array.isArray(data) ? data : []);
          } else {
            setCustomers([]);
          }

          if (itemsRes.status === "fulfilled" && itemsRes.value.ok) {
            const data = await itemsRes.value.json().catch(() => []);
            const safeItems = Array.isArray(data) ? data.filter((item) => item?.active !== false) : [];
            setCatalogItems(safeItems);
          } else {
            setCatalogItems([]);
          }
        }
      } catch {
        if (!cancelled) {
          setCustomers([]);
          setCatalogItems([]);
        }
      } finally {
        if (!cancelled) setLoadingCustomers(false);
      }
    };
    loadReferenceData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!fromQuote) {
      setConvertingQuote(false);
      return;
    }
    let cancelled = false;
    const convert = async () => {
      setConvertingQuote(true);
      setError(null);
      setNotice("Conversion du devis en facture en cours…");
      try {
        const result: any = await api(`/api/quotes/${fromQuote}/convert`, { method: "POST" });
        const invoiceId = result?.invoice_id;
        if (!invoiceId) {
          throw new Error("Conversion réussie mais facture introuvable.");
        }
        if (!cancelled) {
          router.replace(`/app/invoices/${invoiceId}`);
        }
      } catch (err) {
        if (!cancelled) {
          setError(formatApiError(err, "Conversion du devis impossible."));
          setNotice(null);
          setConvertingQuote(false);
        }
      }
    };
    convert();
    return () => {
      cancelled = true;
    };
  }, [fromQuote, router]);

  const selectedCustomer = useMemo(
    () => customers.find((item) => item.id === form.customer_id) || null,
    [customers, form.customer_id],
  );

  const selectedPreset = useMemo(
    () => QUOTE_PRESETS.find((item) => item.id === selectedPresetId) || null,
    [selectedPresetId],
  );

  const filteredCatalogItems = useMemo(() => {
    const query = (catalogQuery || "").trim().toLowerCase();
    const base = Array.isArray(catalogItems) ? catalogItems : [];
    const filtered = !query
      ? base
      : base.filter((item) => {
          const haystack = `${item?.name || ""} ${item?.description || ""} ${item?.unit_code || ""}`.toLowerCase();
          return haystack.includes(query);
        });
    return filtered.slice(0, 8);
  }, [catalogItems, catalogQuery]);

  const totals = useMemo(() => {
    const totalHT = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0);
    const totalVAT = lines.reduce(
      (sum, line) =>
        sum + Number(line.quantity || 0) * Number(line.unit_price || 0) * (Number(line.vat_rate || 0) / 100),
      0,
    );
    return {
      totalHT,
      totalVAT,
      totalTTC: totalHT + totalVAT,
    };
  }, [lines]);

  const updateLine = (id: string, field: string, value: any) => {
    setLines((prev) => prev.map((line) => (line.id === id ? { ...line, [field]: value } : line)));
  };

  const removeLine = (id: string) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((line) => line.id !== id)));
  };

  const addCatalogItem = (item: any) => {
    setLines((prev) => [
      ...prev,
      {
        id: uid(),
        product_name: item?.name || "",
        quantity: 1,
        unit_price: Number(item?.unit_price || 0),
        vat_rate: Number(item?.vat_rate || 20),
      },
    ]);
    setNotice(`Article ajouté : ${item?.name || "article"}.`);
  };

  const applyQuotePreset = (presetId: string) => {
    const preset = QUOTE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const nextValidUntil = new Date(Date.now() + preset.validUntilDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    setSelectedPresetId(preset.id);
    setLines(
      (preset.lines || []).map((line) => ({
        id: uid(),
        product_name: line.product_name || "",
        quantity: Number(line.quantity || 1),
        unit_price: Number(line.unit_price || 0),
        vat_rate: Number(line.vat_rate || 20),
      })),
    );
    setForm((prev: any) => ({
      ...prev,
      payment_terms: preset.payment_terms || prev.payment_terms,
      valid_until: nextValidUntil,
      note: preset.note || prev.note || "",
    }));
    setNotice(`Modèle appliqué : ${preset.label}.`);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (!form.customer_id) {
        throw new Error("Sélectionnez un client avant de continuer.");
      }
      const normalizedLines = lines
        .map((line) => ({
          product_name: (line.product_name || "").trim(),
          quantity: Number(line.quantity || 0),
          unit_price: Number(line.unit_price || 0),
          vat_rate: Number(line.vat_rate || 0),
          vat_category: Number(line.vat_rate || 0) === 0 ? "O" : "S",
        }))
        .filter((line) => line.product_name);
      if (!normalizedLines.length) {
        throw new Error("Ajoutez au moins une ligne avec une désignation.");
      }
      const payload = isInvoice
        ? {
            customer_id: form.customer_id,
            currency: form.currency || "EUR",
            note: form.note || null,
            payment_terms: form.payment_terms || null,
            due_days: Number(form.due_days || 0) || 30,
            service_date: form.service_date || null,
            purchase_order_number: form.purchase_order_number || null,
            operation_nature: form.operation_nature || "services",
            facturx_profile: form.facturx_profile || null,
            lines: normalizedLines,
          }
        : {
            customer_id: form.customer_id,
            currency: form.currency || "EUR",
            note: form.note || null,
            payment_terms: form.payment_terms || null,
            service_date: form.service_date || null,
            valid_until: form.valid_until || null,
            purchase_order_number: form.purchase_order_number || null,
            lines: normalizedLines,
          };
      const created: any = await api(isInvoice ? "/api/invoices" : "/api/quotes", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!created?.id) {
        throw new Error(
          isInvoice
            ? "La facture a été créée mais son identifiant est introuvable."
            : "Le devis a été créé mais son identifiant est introuvable.",
        );
      }
      router.push(isInvoice ? `/app/invoices/${created.id}` : `/app/quotes/${created.id}`);
    } catch (err) {
      setError(formatApiError(err, isInvoice ? "Création de la facture impossible." : "Création du devis impossible."));
    } finally {
      setSaving(false);
    }
  };

  if (convertingQuote) {
    return (
      <div>
        <AppPageHeader
          title="Conversion devis → facture"
          breadcrumb="Facturation"
          backHref="/app/quotes"
          description="Le devis accepté est converti en facture avec les informations déjà validées."
        />
        <div className="p-6 lg:p-8 space-y-4">
          {notice ? <NoticeBanner tone="info">{notice}</NoticeBanner> : null}
          {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
          {!error ? <LoadingCard label="Création de la facture en cours…" /> : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <AppPageHeader
        title={isInvoice ? "Nouvelle facture" : "Nouveau devis"}
        breadcrumb={isInvoice ? "Facturation · Création" : "Commercial · Création"}
        backHref={backHref}
        description={
          isInvoice
            ? "La facture est créée en brouillon puis émise depuis sa fiche."
            : "Créez un devis avec lignes, validité et partage client."
        }
        actions={
          <div className="flex gap-2">
            <Link
              to={backHref}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-[#e2e8f0] bg-white text-[#374151] rounded-lg hover:bg-[#f8fafc] hover:border-[#cbd5e1] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Retour
            </Link>
            <PrimaryButton onClick={submit} disabled={saving || loadingCustomers}>
              <FilePlus2 className="w-3.5 h-3.5" />{" "}
              {saving ? "Création…" : isInvoice ? "Créer la facture" : "Créer le devis"}
            </PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-6">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {notice ? <NoticeBanner tone="info">{notice}</NoticeBanner> : null}

        {loadingCustomers ? (
          <LoadingCard label="Chargement des clients…" />
        ) : customers.length === 0 ? (
          <EmptyCard
            title="Aucun client disponible"
            description="Créez d’abord un client pour pouvoir établir un devis ou une facture réelle depuis ce nouvel écran."
            action={
              <Link
                to="/app/customers/new"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white shadow-[0_2px_8px_rgba(29,78,216,0.3)]"
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  background: "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
                }}
              >
                <Plus className="w-3.5 h-3.5" /> Créer un client
              </Link>
            }
          />
        ) : (
          <>
            <div className="grid lg:grid-cols-[minmax(0,1.4fr)_360px] gap-6">
              <Card>
                <div className="grid md:grid-cols-2 gap-4">
                  <SelectField
                    label="Client"
                    required
                    value={form.customer_id}
                    onChange={(e) => setForm((prev: any) => ({ ...prev, customer_id: e.target.value }))}
                  >
                    <option value="">Sélectionner…</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Devise"
                    value={form.currency}
                    onChange={(e) => setForm((prev: any) => ({ ...prev, currency: e.target.value }))}
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                    <option value="CHF">CHF</option>
                  </SelectField>
                  <InputField
                    label="Date de service"
                    type="date"
                    value={form.service_date}
                    onChange={(e) => setForm((prev: any) => ({ ...prev, service_date: e.target.value }))}
                  />
                  {isInvoice ? (
                    <InputField
                      label="Jours avant échéance"
                      type="number"
                      min={1}
                      value={form.due_days}
                      onChange={(e) => setForm((prev: any) => ({ ...prev, due_days: e.target.value }))}
                    />
                  ) : (
                    <InputField
                      label="Valable jusqu’au"
                      type="date"
                      value={form.valid_until}
                      onChange={(e) => setForm((prev: any) => ({ ...prev, valid_until: e.target.value }))}
                    />
                  )}
                  <InputField
                    label="Conditions de paiement"
                    value={form.payment_terms}
                    onChange={(e) => setForm((prev: any) => ({ ...prev, payment_terms: e.target.value }))}
                    placeholder={isInvoice ? "30 jours fin de mois" : "Paiement à 30 jours"}
                  />
                  <InputField
                    label="N° de commande"
                    value={form.purchase_order_number}
                    onChange={(e) => setForm((prev: any) => ({ ...prev, purchase_order_number: e.target.value }))}
                    placeholder="Optionnel"
                  />
                  {isInvoice ? (
                    <SelectField
                      label="Nature de l’opération"
                      value={form.operation_nature}
                      onChange={(e) => setForm((prev: any) => ({ ...prev, operation_nature: e.target.value }))}
                    >
                      <option value="services">Services</option>
                      <option value="goods">Biens</option>
                      <option value="mixed">Mixte</option>
                    </SelectField>
                  ) : (
                    <div />
                  )}
                  {isInvoice ? (
                    <SelectField
                      label="Profil Factur-X"
                      value={form.facturx_profile}
                      onChange={(e) => setForm((prev: any) => ({ ...prev, facturx_profile: e.target.value }))}
                    >
                      {FACTURX_PROFILES.map((profile) => (
                        <option key={profile.value} value={profile.value}>
                          {profile.label}
                        </option>
                      ))}
                    </SelectField>
                  ) : (
                    <div />
                  )}
                </div>
              </Card>

              <div className="space-y-4">
                <StatCard
                  label="Total HT"
                  value={money(totals.totalHT)}
                  accent="blue"
                  icon={<ReceiptText className="w-4 h-4" />}
                />
                <StatCard
                  label="TVA"
                  value={money(totals.totalVAT)}
                  accent="amber"
                  icon={<Calculator className="w-4 h-4" />}
                />
                <StatCard
                  label="Total TTC"
                  value={money(totals.totalTTC)}
                  accent="green"
                  icon={<ReceiptText className="w-4 h-4" />}
                />
                <Card>
                  <div className="text-[#0f172a] mb-2" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    Client sélectionné
                  </div>
                  {selectedCustomer ? (
                    <div className="space-y-2" style={{ fontSize: "0.8125rem" }}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[#94a3b8]">Raison sociale</span>
                        <span className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                          {selectedCustomer.name}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[#94a3b8]">Email</span>
                        <span className="text-[#475569]">{selectedCustomer.email || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[#94a3b8]">SIRET</span>
                        <span className="text-[#475569] font-mono" style={{ fontSize: "0.75rem" }}>
                          {selectedCustomer.siret || "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[#94a3b8]">TVA</span>
                        <span className="text-[#475569] font-mono" style={{ fontSize: "0.75rem" }}>
                          {selectedCustomer.vat_number || "—"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      Sélectionnez un client pour vérifier son email, son SIRET et sa TVA avant création.
                    </p>
                  )}
                </Card>
              </div>
            </div>

            <Card>
              <div className="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                    Lignes {isInvoice ? "de facturation" : "du devis"}
                  </h3>
                  <p className="text-[#64748b] mt-1" style={{ fontSize: "0.8125rem" }}>
                    Chaque ligne est reprise dans les calculs HT / TVA / TTC.
                  </p>
                </div>
                <SecondaryButton onClick={() => setLines((prev) => [...prev, defaultLine()])}>
                  <Plus className="w-3.5 h-3.5" /> Ajouter une ligne
                </SecondaryButton>
              </div>

              <div className="space-y-3">
                <div
                  className="hidden md:grid gap-3 px-3 text-[#64748b]"
                  style={{
                    gridTemplateColumns: "minmax(0,1.8fr) 110px 140px 110px 120px 40px",
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  <span>Désignation</span>
                  <span>Qté</span>
                  <span>PU HT</span>
                  <span>TVA %</span>
                  <span>Total HT</span>
                  <span />
                </div>
                {lines.map((line, index) => {
                  const lineTotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
                  return (
                    <div
                      key={line.id}
                      className="grid gap-3 items-center rounded-xl border border-[#e2e8f0] p-3"
                      style={{ gridTemplateColumns: "minmax(0,1.8fr) 110px 140px 110px 120px 40px" }}
                    >
                      <input
                        value={line.product_name}
                        onChange={(e) => updateLine(line.id, "product_name", e.target.value)}
                        placeholder={`Ligne ${index + 1} — désignation`}
                        className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                        style={{ fontSize: "0.875rem" }}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.id, "quantity", e.target.value)}
                        className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                        style={{ fontSize: "0.875rem" }}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.unit_price}
                        onChange={(e) => updateLine(line.id, "unit_price", e.target.value)}
                        className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                        style={{ fontSize: "0.875rem" }}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={line.vat_rate}
                        onChange={(e) => updateLine(line.id, "vat_rate", e.target.value)}
                        className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                        style={{ fontSize: "0.875rem" }}
                      />
                      <div className="text-[#0f172a] text-right" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                        {money(lineTotal)}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[#e2e8f0] text-[#94a3b8] hover:text-[#dc2626] hover:border-[#fecaca] hover:bg-[#fef2f2] transition-all"
                        title="Supprimer la ligne"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
