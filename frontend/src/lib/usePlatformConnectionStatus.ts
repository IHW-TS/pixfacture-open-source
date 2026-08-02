"use client";

import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useSession } from "@/lib/useSession";

type PlatformProvider = {
  slug: string;
  label: string;
};

type PlatformConnectionStatus = {
  active: boolean | null;
  providers: PlatformProvider[];
  loading: boolean;
  error: string | null;
};

type PlatformConnectionOptions = {
  enabled?: boolean;
};

export const usePlatformConnectionStatus = (options: PlatformConnectionOptions = {}): PlatformConnectionStatus => {
  const { enabled = true } = options;
  const { loading: sessionLoading, user } = useSession();
  const [active, setActive] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<PlatformProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setActive(null);
      setProviders([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (sessionLoading || !user) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    api("/api/inbox/connection", {})
      .then((data: any) => {
        if (!mounted) return;
        const list = Array.isArray(data?.providers) ? data.providers : [];
        setProviders(list);
        setActive(Boolean(data?.active));
      })
      .catch((err: any) => {
        if (!mounted) return;
        setProviders([]);
        setActive(false);
        setError(formatApiError(err, "Statut plateforme indisponible."));
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [enabled, sessionLoading, user]);

  return { active, providers, loading, error };
};
