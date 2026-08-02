"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { reportError } from "@/lib/reportError";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";

type SearchResult = {
  type: string;
  id: string;
  title: string;
  subtitle?: string | null;
  url: string;
};

type SearchResponse = {
  q: string;
  results: SearchResult[];
};

export function GlobalSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<any | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults([]);
    setError(null);
    setLoading(false);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setResults([]);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);

    const t = setTimeout(() => {
      apiFetch(`/api/search?q=${encodeURIComponent(term)}&limit=24`, {})
        .then((r) => {
          if (!active) return;
          const rr = r as SearchResponse;
          setResults(rr.results || []);
        })
        .catch((e) => {
          if (!active) return;
          setError(e);
          setResults([]);
          reportError(e, { where: "global_search" });
        })
        .finally(() => {
          if (!active) return;
          setLoading(false);
        });
    }, 180);

    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [open, q]);

  const grouped = useMemo(() => {
    const map: Record<string, SearchResult[]> = {};
    for (const r of results) {
      const t = r.type || "other";
      map[t] = map[t] || [];
      map[t].push(r);
    }
    return map;
  }, [results]);

  if (!mounted) return null;

  return (
    <div
      className="modal-backdrop ui-overlay"
      data-state={state}
      role="dialog"
      aria-modal="true"
      aria-label="Recherche"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card search-modal ui-dialog" role="document" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-modal__header">
          <div>
            <div className="font-700">Rechercher</div>
            <div className="muted text-12">Client, n° facture, devis, PO, article…</div>
          </div>
          <button className="btn ghost btn--sm" onClick={onClose} type="button">
            Fermer
          </button>
        </div>

        <div className="search-modal__body">
          <input
            ref={inputRef}
            className="input w-full"
            aria-label="Rechercher dans l’espace"
            placeholder="Client, n° facture, devis, PO, article…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <div className="muted mt-8 text-12">
            Astuce : <span className="kbd">Ctrl</span> + <span className="kbd">K</span>
          </div>

          {loading && <div className="muted mt-12">Recherche…</div>}
          {error && (
            <div className="alert-inline danger mt-12">La recherche a échoué. Réessayez dans quelques secondes.</div>
          )}

          {!loading && !results.length && q.trim() && !error && <div className="muted mt-12">Aucun résultat.</div>}

          {!!results.length && (
            <div className="search-results mt-12">
              {Object.entries(grouped).map(([type, items]) => (
                <div key={type} className="search-group">
                  <div className="search-group__title">{labelType(type)}</div>
                  <div className="search-group__items">
                    {items.map((r) => (
                      <Link key={`${r.type}:${r.id}`} href={r.url} className="search-item" onClick={() => onClose()}>
                        <div className="search-item__title">{r.title}</div>
                        {r.subtitle && <div className="search-item__subtitle">{r.subtitle}</div>}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function labelType(t: string): string {
  const type = (t || "").toLowerCase();
  const map: Record<string, string> = {
    customer: "Clients",
    invoice: "Factures",
    credit_note: "Avoirs",
    quote: "Devis",
    item: "Articles",
    other: "Autres",
  };
  return map[type] || type;
}
