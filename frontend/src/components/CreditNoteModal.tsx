"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";
import { ReceiptText, X } from "lucide-react";

export type CreditNoteLine = {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
};

export type CreditNoteCreatePayload = {
  note?: string;
  lines: { line_id: string; quantity: number }[];
};

type CreditNoteModalProps = {
  open: boolean;
  invoiceNumber?: string | null;
  currency?: string | null;
  lines: CreditNoteLine[];
  submitting?: boolean;
  onSubmit: (payload: CreditNoteCreatePayload) => void | Promise<void>;
  onClose: () => void;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const parseNum = (raw: string) => {
  const normalized = (raw || "").replace(/\s/g, "").replace(",", ".");
  const v = Number(normalized);
  return Number.isFinite(v) ? v : 0;
};

const buildDefaultNote = (invoiceNumber: string | null | undefined, isFullCredit: boolean) => {
  const prefix = isFullCredit ? "Avoir total" : "Avoir partiel";
  const label = (invoiceNumber || "").trim();
  return label ? `${prefix} de la facture ${label}` : prefix;
};

const normalizeCurrency = (currency: string | null | undefined) => {
  const value = String(currency || "EUR")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : "EUR";
};

const formatMoney = (amount: number, currency: string | null | undefined = "EUR") =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: normalizeCurrency(currency),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(round2(amount));

const formatQuantityInput = (amount: number) => {
  if (!Number.isFinite(amount)) return "0";
  const rounded = Math.round((amount + Number.EPSILON) * 1000000) / 1000000;
  return String(rounded).replace(".", ",");
};

const formatAmountInput = (amount: number) =>
  Math.abs(round2(amount)).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const isGeneratedNote = (value: string, invoiceNumber: string | null | undefined) => {
  const trimmed = (value || "").trim();
  return (
    !trimmed || trimmed === buildDefaultNote(invoiceNumber, true) || trimmed === buildDefaultNote(invoiceNumber, false)
  );
};

export default function CreditNoteModal({
  open,
  invoiceNumber,
  currency = "EUR",
  lines,
  submitting = false,
  onSubmit,
  onClose,
}: CreditNoteModalProps) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const [note, setNote] = useState<string>("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const resolvedCurrency = normalizeCurrency(currency);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNote(buildDefaultNote(invoiceNumber, true));
    const init: Record<string, string> = {};
    for (const l of lines) {
      const max = Math.abs(Number(l.quantity || 0));
      if (max > 0) init[l.id] = formatQuantityInput(max);
    }
    setQuantities(init);
    setAmountDrafts({});
  }, [open, invoiceNumber, lines]);

  useEffect(() => {
    if (!mounted) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [mounted]);

  const computed = useMemo(() => {
    return (lines || []).map((l) => {
      const max = Math.abs(Number(l.quantity || 0));
      const raw = quantities[l.id] ?? "";
      let qty = parseNum(raw);
      if (qty < 0) qty = 0;
      if (qty > max) qty = max;
      const ht = round2(qty * Number(l.unit_price || 0));
      const vat = round2((ht * Number(l.vat_rate || 0)) / 100);
      const ttc = round2(ht + vat);
      const sourceHt = round2(max * Number(l.unit_price || 0));
      const sourceVat = round2((sourceHt * Number(l.vat_rate || 0)) / 100);
      const sourceTtc = round2(sourceHt + sourceVat);
      const unitTtc = Number(l.unit_price || 0) * (1 + Number(l.vat_rate || 0) / 100);
      return { ...l, max, qty, ht, vat, ttc, sourceHt, sourceVat, sourceTtc, unitTtc };
    });
  }, [lines, quantities]);

  const totals = useMemo(() => {
    const ht = round2(computed.reduce((s, l) => s + (l.qty > 0 ? l.ht : 0), 0));
    const vat = round2(computed.reduce((s, l) => s + (l.qty > 0 ? l.vat : 0), 0));
    const ttc = round2(ht + vat);
    const selected = computed.filter((l) => l.qty > 0).length;
    return { ht, vat, ttc, selected };
  }, [computed]);

  const sourceTotals = useMemo(() => {
    const ht = round2(computed.reduce((s, l) => s + l.sourceHt, 0));
    const vat = round2(computed.reduce((s, l) => s + l.sourceVat, 0));
    const ttc = round2(ht + vat);
    return { ht, vat, ttc };
  }, [computed]);

  const isFullCredit = useMemo(() => {
    const creditable = computed.filter((l) => l.max > 0);
    return creditable.length > 0 && creditable.every((l) => Math.abs(l.qty - l.max) < 1e-9);
  }, [computed]);

  useEffect(() => {
    if (!open) return;
    setNote((current) => {
      if (!isGeneratedNote(current, invoiceNumber)) return current;
      return buildDefaultNote(invoiceNumber, isFullCredit);
    });
  }, [open, invoiceNumber, isFullCredit]);

  if (!mounted) return null;

  const fillAll = () => {
    const next: Record<string, string> = {};
    for (const l of lines) {
      const max = Math.abs(Number(l.quantity || 0));
      if (max > 0) next[l.id] = formatQuantityInput(max);
    }
    setQuantities(next);
    setAmountDrafts({});
    setError(null);
  };

  const fillRatio = (ratio: number) => {
    const next: Record<string, string> = {};
    for (const l of lines) {
      const max = Math.abs(Number(l.quantity || 0));
      next[l.id] = formatQuantityInput(Math.max(0, max * ratio));
    }
    setQuantities(next);
    setAmountDrafts({});
    setError(null);
  };

  const clearAll = () => {
    const next: Record<string, string> = {};
    for (const l of lines) {
      next[l.id] = "0";
    }
    setQuantities(next);
    setAmountDrafts({});
    setError(null);
  };

  const setLineCreditAmount = (line: (typeof computed)[number], raw: string) => {
    const amount = Math.abs(parseNum(raw));
    const unitTtc = Math.abs(Number(line.unitTtc || 0));
    const qty = unitTtc > 0 ? Math.min(line.max, amount / unitTtc) : 0;
    setQuantities({ ...quantities, [line.id]: formatQuantityInput(qty) });
    setAmountDrafts({ ...amountDrafts, [line.id]: raw });
    if (error) setError(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const selectedLines = computed.filter((l) => l.qty > 0).map((l) => ({ line_id: l.id, quantity: l.qty }));
    if (selectedLines.length === 0) {
      setError("Sélectionnez au moins une ligne (quantité > 0). ");
      return;
    }
    setError(null);
    const cleanNote = note.trim();
    onSubmit({
      note: isGeneratedNote(cleanNote, invoiceNumber)
        ? buildDefaultNote(invoiceNumber, isFullCredit)
        : cleanNote || undefined,
      lines: selectedLines,
    });
  };

  const sourceInvoiceLabel = (invoiceNumber || "").trim() || "facture source";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Créer un avoir"
      className="modal-overlay ui-overlay z-70"
      data-state={state}
    >
      <div className="ui-dialog w-full max-w-[1480px] overflow-hidden rounded-3xl border border-[#dbe4ef] bg-white shadow-[0_30px_80px_-34px_rgba(15,23,42,0.85)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] bg-[#fbfdff] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#fffbeb] text-[#d97706]">
              <ReceiptText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="pf-invoice-overline text-[#94a3b8]">Avoir client</div>
              <h3 className="truncate text-base font-[850] text-[#0f172a]">Créer un avoir</h3>
            </div>
          </div>
          <button
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#dbe4ef] text-[#64748b] transition hover:bg-[#f8fafc] hover:text-[#0f172a]"
            aria-label="Fermer"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form className="max-h-[calc(90vh-84px)] overflow-y-auto p-5" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-[#dbe4ef] bg-[#f8fafc] px-4 py-3">
                <div className="pf-invoice-overline text-[#94a3b8]">Facture source</div>
                <div className="mt-1 text-base font-black text-[#0f172a]">{sourceInvoiceLabel}</div>
              </div>
              <div className="rounded-2xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3">
                <div className="pf-invoice-overline text-[#94a3b8]">Crédit sélectionné</div>
                <div className="mt-1 text-base font-black text-[#92400e]">
                  {totals.selected} ligne(s) · {formatMoney(totals.ttc, resolvedCurrency)}
                </div>
              </div>
              <div className="rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3">
                <div className="pf-invoice-overline text-[#94a3b8]">Facture initiale</div>
                <div className="mt-1 text-base font-black text-[#0f172a]">
                  {formatMoney(sourceTotals.ttc, resolvedCurrency)}
                </div>
              </div>
            </div>

            <section className="flex min-w-0 flex-1 flex-col gap-4">
              <label className="flex flex-col gap-1 text-[0.78rem] font-[760] text-[#334155]">
                Note / motif
                <input
                  className="h-10 rounded-xl border border-[#dbe4ef] bg-white px-3 text-[#0f172a] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex h-9 items-center justify-center rounded-full border border-[#fde68a] bg-[#fffbeb] px-4 text-sm font-bold text-[#d97706] transition hover:bg-[#fef3c7]"
                  type="button"
                  onClick={fillAll}
                  disabled={submitting}
                >
                  Avoir complet
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-full border border-[#e2e8f0] bg-white px-4 text-sm font-bold text-[#334155] transition hover:bg-[#f8fafc]"
                  type="button"
                  onClick={() => fillRatio(0.5)}
                  disabled={submitting}
                >
                  Avoir 50 %
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-full border border-[#e2e8f0] bg-white px-4 text-sm font-bold text-[#334155] transition hover:bg-[#f8fafc]"
                  type="button"
                  onClick={clearAll}
                  disabled={submitting}
                >
                  Tout à 0
                </button>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[#dbe4ef] bg-white">
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse text-left">
                    <thead className="bg-[#f8fafc] text-[#64748b]">
                      <tr>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">Désignation</th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">
                          Quantité à créditer
                        </th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">
                          Montant TTC à créditer
                        </th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">Max</th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">PU HT</th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em]">TVA</th>
                        <th className="px-4 py-3 text-xs font-extrabold uppercase tracking-[0.08em] text-right">
                          Total TTC
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eef2f7]">
                      {computed.map((l) => (
                        <tr key={l.id} className="align-middle">
                          <td className="px-4 py-3 text-sm font-bold text-[#0f172a]">{l.product_name}</td>
                          <td className="px-4 py-3">
                            <input
                              className="h-9 w-28 rounded-xl border border-[#dbe4ef] bg-white px-3 text-sm font-bold text-[#0f172a] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              type="text"
                              inputMode="decimal"
                              aria-label={`Quantité à créditer pour ${l.product_name}`}
                              value={quantities[l.id] ?? ""}
                              onChange={(e) => {
                                setQuantities({ ...quantities, [l.id]: e.target.value });
                                setAmountDrafts((current) => {
                                  const next = { ...current };
                                  delete next[l.id];
                                  return next;
                                });
                                if (error) setError(null);
                              }}
                              disabled={submitting}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input
                              className="h-9 w-36 rounded-xl border border-[#dbe4ef] bg-white px-3 text-sm font-bold text-[#0f172a] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              type="text"
                              inputMode="decimal"
                              aria-label={`Montant TTC à créditer pour ${l.product_name}`}
                              value={amountDrafts[l.id] ?? formatAmountInput(l.ttc)}
                              onChange={(e) => setLineCreditAmount(l, e.target.value)}
                              onBlur={() =>
                                setAmountDrafts((current) => {
                                  const next = { ...current };
                                  delete next[l.id];
                                  return next;
                                })
                              }
                              disabled={submitting || Math.abs(Number(l.unitTtc || 0)) <= 0}
                            />
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-[#64748b]">{l.max.toFixed(2)}</td>
                          <td className="px-4 py-3 text-sm font-semibold text-[#64748b]">
                            {formatMoney(Number(l.unit_price || 0), resolvedCurrency)}
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-[#64748b]">
                            {Number(l.vat_rate || 0).toLocaleString("fr-FR", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                            %
                          </td>
                          <td className="px-4 py-3 text-right text-sm font-extrabold text-[#0f172a]">
                            {formatMoney(l.ttc, resolvedCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-[#dbe4ef] bg-[#fbfdff] text-sm font-extrabold text-[#0f172a]">
                      <tr>
                        <td colSpan={6} className="px-4 py-3 text-right text-[#64748b]">
                          Total HT
                        </td>
                        <td className="px-4 py-3 text-right">{formatMoney(totals.ht, resolvedCurrency)}</td>
                      </tr>
                      <tr>
                        <td colSpan={6} className="px-4 py-3 text-right text-[#64748b]">
                          Total TVA
                        </td>
                        <td className="px-4 py-3 text-right">{formatMoney(totals.vat, resolvedCurrency)}</td>
                      </tr>
                      <tr className="bg-[#fffbeb] text-[#92400e]">
                        <td colSpan={6} className="px-4 py-3 text-right">
                          Total TTC
                        </td>
                        <td className="px-4 py-3 text-right">{formatMoney(totals.ttc, resolvedCurrency)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {error ? (
                <div
                  className="rounded-xl border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-sm font-semibold text-[#dc2626]"
                  role="status"
                >
                  {error}
                </div>
              ) : null}
            </section>
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[#eef2f7] pt-4">
            <button
              className="inline-flex h-10 items-center justify-center rounded-full border border-[#dbe4ef] bg-white px-5 text-sm font-bold text-[#334155] transition hover:bg-[#f8fafc]"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              Annuler
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-full bg-[#f59e0b] px-5 text-sm font-extrabold text-white shadow-sm transition hover:bg-[#d97706] disabled:opacity-60"
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting ? "Création..." : "Créer l'avoir"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
