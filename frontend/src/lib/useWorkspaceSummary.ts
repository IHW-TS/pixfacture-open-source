"use client";

import { useCallback, useEffect, useState } from "react";
import { extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";

export function useWorkspaceSummary(options: { auto?: boolean } = {}) {
  const auto = options.auto !== false;
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(auto);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/workspace/summary");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          extractUserFacingApiMessage(payload, res.status, "Impossible de charger le résumé de l’espace."),
        );
      }
      const data = await res.json().catch(() => null);
      setSummary(data || null);
      return data || null;
    } catch (err) {
      setSummary(null);
      setError(formatApiError(err, "Impossible de charger le résumé de l’espace."));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    void load();
  }, [auto, load]);

  return {
    summary,
    loading,
    error,
    reload: load,
  };
}
