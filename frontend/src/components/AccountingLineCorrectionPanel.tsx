"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Hash } from "lucide-react";
import { api, formatApiError } from "@/lib/api";

const CUSTOM_ACCOUNT_VALUE = "__custom__";
const SALES_ACCOUNT_OPTIONS = [
  { value: "701", label: "701 - Produits finis" },
  { value: "704", label: "704 - Travaux" },
  { value: "705", label: "705 - Études" },
  { value: "706", label: "706 - Services" },
  { value: "707", label: "707 - Marchandises" },
  { value: "708", label: "708 - Activités annexes" },
  { value: "7085", label: "7085 - Ports/frais" },
];

type AccountingLine = {
  id: string;
  product_name?: string | null;
  line_total?: number | string | null;
  accounting_account?: string | null;
};

function cleanAccount(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "");
}

function accountCode(value: unknown) {
  return cleanAccount(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function needsCorrection(line: AccountingLine) {
  const amount = Math.abs(Number(line?.line_total || 0));
  const code = accountCode(line?.accounting_account);
  return amount > 0.0001 && (!code || code.startsWith("471"));
}

function validFinalAccount(value: unknown) {
  const raw = cleanAccount(value);
  if (raw === CUSTOM_ACCOUNT_VALUE) return false;
  const code = accountCode(raw);
  return /^[A-Z0-9._-]{3,20}$/.test(raw.toUpperCase()) && code.length >= 3 && !code.startsWith("471");
}

function accountSelectValue(value: unknown) {
  const account = cleanAccount(value);
  if (account === CUSTOM_ACCOUNT_VALUE) return CUSTOM_ACCOUNT_VALUE;
  if (!account || accountCode(account).startsWith("471")) return "";
  return SALES_ACCOUNT_OPTIONS.some((option) => option.value === account) ? account : CUSTOM_ACCOUNT_VALUE;
}

export function AccountingLineCorrectionPanel({
  documentId,
  documentType,
  status,
  lines,
  onSaved,
}: {
  documentId: string | null | undefined;
  documentType: "invoice" | "quote";
  status?: string | null;
  lines?: AccountingLine[] | null;
  onSaved?: () => void | Promise<void>;
}) {
  const isDraft = String(status || "").toLowerCase() === "draft";
  const correctionLines = useMemo(() => (Array.isArray(lines) ? lines.filter(needsCorrection) : []), [lines]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft((prev) => {
      const next: Record<string, string> = {};
      for (const line of correctionLines) {
        next[line.id] = prev[line.id] || cleanAccount(line.accounting_account);
      }
      return next;
    });
  }, [correctionLines]);

  if (!documentId || isDraft || correctionLines.length <= 0) return null;

  const invalidCount = correctionLines.filter((line) => !validFinalAccount(draft[line.id])).length;
  const endpoint =
    documentType === "invoice"
      ? `/api/invoices/${documentId}/accounting-lines`
      : `/api/quotes/${documentId}/accounting-lines`;
  const title = documentType === "invoice" ? "Correction comptable de la facture" : "Correction comptable du devis";
  const description =
    documentType === "invoice"
      ? "La facture émise reste inchangée pour le client. Ici, vous renseignez seulement la catégorie compta utilisée par l’export."
      : "Le devis envoyé reste inchangé pour le client. Ici, vous renseignez seulement la catégorie compta utilisée par la conversion ou l’export.";

  const save = async () => {
    if (invalidCount > 0) {
      setError("Choisissez une catégorie compta définitive. À valider par mon comptable est temporaire.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api(endpoint, {
        method: "PATCH",
        body: JSON.stringify({
          lines: correctionLines.map((line) => ({
            id: line.id,
            accounting_account: cleanAccount(draft[line.id]),
          })),
        }),
      });
      setMessage("Catégorie compta mise à jour. Le document client et son PDF restent inchangés.");
      await onSaved?.();
    } catch (err) {
      setError(formatApiError(err, "Impossible d’enregistrer la catégorie compta."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      id="accounting-correction"
      className="rounded-2xl border border-[#bfdbfe] bg-white px-4 py-4 shadow-[0_18px_42px_-34px_rgba(15,23,42,0.7)]"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eff6ff] text-[#2563eb]">
            <Hash className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="m-0 text-[0.95rem] font-extrabold text-[#0f172a]">{title}</h3>
            <p className="mt-1 max-w-3xl text-[0.8rem] leading-relaxed text-[#64748b]">{description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving || invalidCount > 0}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-3.5 py-2 text-[0.8rem] font-extrabold text-[#1d4ed8] transition hover:bg-[#dbeafe] disabled:cursor-not-allowed disabled:opacity-55"
        >
          <CheckCircle2 className="h-4 w-4" />
          {saving ? "Enregistrement…" : "Enregistrer la catégorie"}
        </button>
      </div>

      <div className="mt-4 grid gap-2">
        {correctionLines.map((line, index) => {
          const lineDraft = draft[line.id] || "";
          const selectValue = accountSelectValue(lineDraft);
          const customOpen = selectValue === CUSTOM_ACCOUNT_VALUE;

          return (
            <div
              key={line.id}
              className="grid gap-3 rounded-xl border border-[#dbeafe] bg-[#f8fafc] px-3 py-2 md:grid-cols-[minmax(0,1fr)_300px]"
            >
              <div className="min-w-0">
                <div className="text-[0.72rem] font-extrabold uppercase tracking-[0.08em] text-[#94a3b8]">
                  Ligne {index + 1}
                </div>
                <div className="truncate text-[0.86rem] font-bold text-[#0f172a]">
                  {line.product_name || "Ligne sans libellé"}
                </div>
              </div>
              <div className="grid gap-2">
                <label className="grid gap-1 text-[0.72rem] font-bold text-[#64748b]">
                  Catégorie compta
                  <span className="text-[0.7rem] font-semibold normal-case leading-snug text-[#94a3b8]">
                    À valider par mon comptable est temporaire.
                  </span>
                  <span className="relative block">
                    <select
                      title="Catégorie utilisée pour classer la ligne dans la comptabilité."
                      value={selectValue}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        if (nextValue === CUSTOM_ACCOUNT_VALUE) {
                          setDraft((prev) => {
                            const current = cleanAccount(prev[line.id]);
                            return {
                              ...prev,
                              [line.id]:
                                current &&
                                !accountCode(current).startsWith("471") &&
                                accountSelectValue(current) === CUSTOM_ACCOUNT_VALUE
                                  ? current
                                  : CUSTOM_ACCOUNT_VALUE,
                            };
                          });
                          return;
                        }
                        setDraft((prev) => ({ ...prev, [line.id]: nextValue }));
                      }}
                      className="mt-1 h-10 w-full appearance-none rounded-lg border border-[#bfdbfe] bg-white px-3 py-2 pr-9 text-[0.84rem] font-bold text-[#0f172a] outline-none transition hover:border-[#60a5fa] focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/20"
                    >
                      <option value="">Choisir une catégorie</option>
                      {SALES_ACCOUNT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value={CUSTOM_ACCOUNT_VALUE}>Code fourni par mon comptable</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748b]" />
                  </span>
                </label>
                {customOpen ? (
                  <label className="grid gap-1 text-[0.72rem] font-bold text-[#64748b]">
                    Code fourni par mon comptable
                    <input
                      value={lineDraft === CUSTOM_ACCOUNT_VALUE ? "" : lineDraft}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [line.id]: event.target.value || CUSTOM_ACCOUNT_VALUE,
                        }))
                      }
                      placeholder="Ex : 7061"
                      className="h-10 w-full rounded-lg border border-[#bfdbfe] bg-white px-3 py-2 font-mono text-[0.84rem] font-bold text-[#0f172a] outline-none transition placeholder:text-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/20"
                    />
                  </label>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {error ? <p className="mt-3 text-[0.78rem] font-bold text-[#b91c1c]">{error}</p> : null}
      {message ? <p className="mt-3 text-[0.78rem] font-bold text-[#047857]">{message}</p> : null}
    </section>
  );
}
