"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export type PaperLine = {
  product_name: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
  vat_category?: string;
  unit_code?: string;
  exemption_reason_code?: string | null;
  item_id?: string | null;
};

type CatalogItem = {
  id?: string;
  name?: string;
  description?: string | null;
  unit_price?: number;
  vat_rate?: number;
  vat_category?: string;
  unit_code?: string | null;
  exemption_reason_code?: string | null;
};

type Props = {
  lines: PaperLine[];
  currencySymbol?: string;
  showVatCategory?: boolean;
  disabled?: boolean;

  onChangeLine: (index: number, field: keyof PaperLine, value: any) => void;
  onAddLine: () => void;
  onRemoveLine: (index: number) => void;
  lineWarnings?: string[][];

  // Catalogue autocomplete (optional)
  catalogItems?: CatalogItem[];
  catalogLoading?: boolean;
  catalogQuery?: string;
  onCatalogQueryChange?: (value: string) => void;
  onSelectCatalogItem?: (index: number, item: CatalogItem) => void;
  catalogMinChars?: number;
};

const fmtMoney = (v: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
};

const normalize = (v: any) => (v === null || v === undefined ? "" : String(v));

const UNIT_CODE_SUGGESTIONS = ["C62", "HUR", "DAY", "MON", "ANN", "H87", "KGM", "LTR"];

export default function PaperLinesTable({
  lines,
  currencySymbol = "€",
  showVatCategory,
  disabled,
  onChangeLine,
  onAddLine,
  onRemoveLine,
  lineWarnings,

  catalogItems,
  catalogLoading,
  catalogQuery,
  onCatalogQueryChange,
  onSelectCatalogItem,
  catalogMinChars = 2,
}: Props) {
  const enableAutocomplete = Boolean(onCatalogQueryChange && onSelectCatalogItem);
  const query = (catalogQuery || "").trim();
  const canShowDropdown = enableAutocomplete && query.length >= catalogMinChars;

  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null);
  const [expandedLine, setExpandedLine] = useState<number | null>(null);
  const blurTimer = useRef<any>(null);

  const designationRefs = useRef<Array<HTMLInputElement | null>>([]);

  const suggestions = useMemo(() => {
    if (!canShowDropdown) return [];
    return Array.isArray(catalogItems) ? catalogItems.slice(0, 20) : [];
  }, [catalogItems, canShowDropdown]);

  const dropdownVisible = Boolean(
    canShowDropdown &&
    activeLine !== null &&
    (catalogLoading || suggestions.length > 0 || (suggestions.length === 0 && query.length >= catalogMinChars)),
  );

  useEffect(() => {
    if (activeLine === null) return;
    setHighlightIdx(0);
  }, [query, activeLine]);

  useEffect(() => {
    if (pendingFocusIndex === null) return;
    const el = designationRefs.current[pendingFocusIndex];
    if (el) {
      el.focus();
      try {
        el.select?.();
      } catch {
        // ignore
      }
      setPendingFocusIndex(null);
    }
  }, [lines.length, pendingFocusIndex]);

  const closeDropdownSoon = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setActiveLine(null), 140);
  };
  const cancelCloseDropdown = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = null;
  };

  const applyCatalogItem = (lineIndex: number, item: CatalogItem) => {
    if (!onSelectCatalogItem) return;
    onSelectCatalogItem(lineIndex, item);
    onCatalogQueryChange?.("");
    setHighlightIdx(0);
    setActiveLine(null);
  };

  const handleDesignationKeyDown = (e: KeyboardEvent<HTMLInputElement>, idx: number) => {
    if (!dropdownVisible || activeLine !== idx) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(highlightIdx + 1, Math.max(0, suggestions.length - 1));
      setHighlightIdx(next);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, highlightIdx - 1);
      setHighlightIdx(next);
      return;
    }
    if (e.key === "Enter") {
      if (suggestions.length > 0) {
        e.preventDefault();
        const item = suggestions[Math.min(highlightIdx, suggestions.length - 1)];
        applyCatalogItem(idx, item);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCatalogQueryChange?.("");
      setActiveLine(null);
      return;
    }
  };

  const maybeAutoAddLine = (e: KeyboardEvent<HTMLInputElement>, idx: number, isLastField: boolean) => {
    if (!isLastField) return;
    if (idx !== lines.length - 1) return;
    if (disabled) return;

    const isEnter = e.key === "Enter";
    const isTabForward = e.key === "Tab" && !(e as any).shiftKey;
    if (!isEnter && !isTabForward) return;

    e.preventDefault();
    onAddLine();
    setPendingFocusIndex(lines.length); // index of the new line
  };

  const colSpan = 6 + (showVatCategory ? 1 : 0);

  return (
    <div className="paper-lines">
      <table className="paper-table" aria-label="Lignes">
        <thead>
          <tr>
            <th className="paper-table__col--designation">Désignation</th>
            <th>Qté</th>
            <th>PU HT</th>
            <th>TVA %</th>
            {showVatCategory ? <th>Cat.</th> : null}
            <th className="paper-table__col--right">Total HT</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => {
            const warnings = lineWarnings?.[idx] || [];
            const hasError = warnings.length > 0;
            const isActive = activeLine === idx;
            const isExpanded = expandedLine === idx;

            const safeVatCategory = normalize(l.vat_category || "S");
            const safeUnitCode = normalize(l.unit_code || "C62");
            const safeExemption = normalize(l.exemption_reason_code || "");

            return (
              <Fragment key={idx}>
                <tr className={hasError ? "paper-row--error" : undefined}>
                  <td className="paper-table__cell paper-table__cell--designation">
                    <div
                      className="paper-autocomplete"
                      onMouseDown={cancelCloseDropdown}
                      onMouseUp={cancelCloseDropdown}
                    >
                      <input
                        ref={(el) => {
                          designationRefs.current[idx] = el;
                        }}
                        className="paper-input paper-input--cell"
                        value={l.product_name}
                        onChange={(e) => {
                          const value = e.target.value;
                          onChangeLine(idx, "product_name", value);
                          if (enableAutocomplete) {
                            onCatalogQueryChange?.(value);
                            setActiveLine(idx);
                          }
                        }}
                        onFocus={() => {
                          setActiveLine(idx);
                          if (enableAutocomplete) onCatalogQueryChange?.(l.product_name || "");
                        }}
                        onBlur={closeDropdownSoon}
                        onKeyDown={(e) => handleDesignationKeyDown(e, idx)}
                        placeholder="Prestation / Produit"
                        disabled={disabled}
                        aria-label={`Désignation ligne ${idx + 1}`}
                        autoComplete="off"
                      />

                      {enableAutocomplete && isActive && dropdownVisible ? (
                        <div className="dropdown paper-dropdown" role="listbox" aria-label="Suggestions catalogue">
                          {catalogLoading ? (
                            <div className="dropdown__empty">Recherche…</div>
                          ) : suggestions.length === 0 ? (
                            <div className="dropdown__empty">
                              Aucun résultat. Vous pouvez continuer en saisie libre.
                            </div>
                          ) : (
                            suggestions.map((p, sIdx) => (
                              <button
                                key={p.id || `${idx}-${sIdx}`}
                                type="button"
                                className={`dropdown__item ${sIdx === highlightIdx ? "is-active" : ""}`}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => applyCatalogItem(idx, p)}
                                disabled={disabled}
                              >
                                <div className="dropdown__title">{p.name || "Article"}</div>
                                {p.description ? <div className="dropdown__desc">{p.description}</div> : null}
                                <div className="dropdown__meta">
                                  {fmtMoney(Number(p.unit_price || 0))} {currencySymbol} HT • TVA{" "}
                                  {Number(p.vat_rate || 0)}%
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>

                    {hasError ? <div className="paper-error">{warnings.join(" • ")}</div> : null}
                  </td>

                  <td className="paper-table__cell">
                    <input
                      className="paper-input paper-input--cell paper-input--num"
                      type="number"
                      value={l.quantity}
                      min={0}
                      step="0.01"
                      onChange={(e) => onChangeLine(idx, "quantity", Number(e.target.value))}
                      disabled={disabled}
                      aria-label={`Quantité ligne ${idx + 1}`}
                    />
                  </td>

                  <td className="paper-table__cell">
                    <input
                      className="paper-input paper-input--cell paper-input--num"
                      type="number"
                      value={l.unit_price}
                      min={0}
                      step="0.01"
                      onChange={(e) => onChangeLine(idx, "unit_price", Number(e.target.value))}
                      disabled={disabled}
                      aria-label={`Prix unitaire ligne ${idx + 1}`}
                    />
                  </td>

                  <td className="paper-table__cell">
                    <input
                      className="paper-input paper-input--cell paper-input--num"
                      type="number"
                      value={l.vat_rate}
                      min={0}
                      step="0.1"
                      onChange={(e) => onChangeLine(idx, "vat_rate", Number(e.target.value))}
                      disabled={disabled}
                      aria-label={`TVA ligne ${idx + 1}`}
                    />
                  </td>

                  {showVatCategory ? (
                    <td className="paper-table__cell">
                      <input
                        className="paper-input paper-input--cell"
                        value={safeVatCategory}
                        onChange={(e) => onChangeLine(idx, "vat_category", e.target.value)}
                        onKeyDown={(e) => maybeAutoAddLine(e, idx, true)}
                        disabled={disabled}
                        aria-label={`Catégorie TVA ligne ${idx + 1}`}
                        placeholder="S"
                      />
                    </td>
                  ) : null}

                  <td className="paper-table__cell paper-table__cell--right">
                    <span className="paper-money">
                      {fmtMoney(Number(l.quantity || 0) * Number(l.unit_price || 0))} {currencySymbol}
                    </span>
                  </td>

                  <td className="paper-table__cell paper-table__cell--icon">
                    <div className="row gap-6 justify-center">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setExpandedLine(isExpanded ? null : idx)}
                        disabled={disabled}
                        aria-label={`Détails ligne ${idx + 1}`}
                        title="Détails"
                      >
                        ⚙
                      </button>
                      {lines.length > 1 ? (
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => onRemoveLine(idx)}
                          disabled={disabled}
                          aria-label={`Supprimer ligne ${idx + 1}`}
                          title="Supprimer"
                        >
                          🗑
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>

                {isExpanded ? (
                  <tr className="paper-row-details" key={`${idx}-details`}>
                    <td colSpan={colSpan}>
                      <div className="paper-line-details">
                        <div className="paper-line-details__grid">
                          <label className="paper-label">
                            <span className="paper-label__text">Unité (UN/ECE)</span>
                            <input
                              className="paper-input paper-input--cell"
                              value={safeUnitCode}
                              onChange={(e) => onChangeLine(idx, "unit_code", e.target.value)}
                              disabled={disabled}
                              list={`unit-codes-${idx}`}
                              placeholder="C62"
                            />
                            <datalist id={`unit-codes-${idx}`}>
                              {UNIT_CODE_SUGGESTIONS.map((u) => (
                                <option key={u} value={u} />
                              ))}
                            </datalist>
                          </label>

                          <label className="paper-label">
                            <span className="paper-label__text">Catégorie TVA (EN‑16931)</span>
                            <input
                              className="paper-input paper-input--cell"
                              value={safeVatCategory}
                              onChange={(e) => onChangeLine(idx, "vat_category", e.target.value)}
                              disabled={disabled}
                              placeholder="S"
                            />
                            <div className="paper-muted small">
                              S (standard) • Z (taux zéro) • E (exonéré) • O (hors champ)…
                            </div>
                          </label>

                          <label className="paper-label">
                            <span className="paper-label__text">Code d’exonération (optionnel)</span>
                            <input
                              className="paper-input paper-input--cell"
                              value={safeExemption}
                              onChange={(e) => onChangeLine(idx, "exemption_reason_code", e.target.value)}
                              disabled={disabled}
                              placeholder="Ex: VATEX-EU-79C"
                            />
                          </label>

                          <div className="paper-muted small">
                            {l.item_id ? (
                              <div>
                                Article lié: <span className="mono">{l.item_id}</span>
                              </div>
                            ) : (
                              <div>Article: saisie libre</div>
                            )}
                            <div className="mt-4">
                              Astuce: la catégorie TVA (S/Z/AE/O/E) et l’unité facilitent la conformité EN‑16931 /
                              Factur‑X.
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <div className="paper-lines__actions">
        <button type="button" className="btn secondary" onClick={onAddLine} disabled={disabled}>
          + Ajouter une ligne
        </button>
        <div className="muted small">
          Astuce : utilisez Tab pour passer d’un champ à l’autre. Entrée sur la dernière colonne ajoute une ligne.
        </div>
      </div>
    </div>
  );
}
