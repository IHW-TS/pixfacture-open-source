"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "./api";
import { useSession } from "./useSession";

type CockpitContextValue = {
  overview: any;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: (options?: { silent?: boolean }) => Promise<any>;
  markNotificationRead: (id: string, read?: boolean) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
};

const CockpitContext = createContext<CockpitContextValue | null>(null);

function buildNotificationSummary(items: any[], fallbackSummary: any = {}) {
  const unreadItems = items.filter((item) => !item?.read);
  const criticalUnread = unreadItems.filter((item) => String(item?.severity || "").toLowerCase() === "critical").length;
  const highUnread = unreadItems.filter((item) => String(item?.severity || "").toLowerCase() === "high").length;
  const dueTodayCount = items.filter((item) => {
    const raw = item?.due_at;
    if (!raw) return false;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return false;
    return date.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
  }).length;

  return {
    ...fallbackSummary,
    total_count: items.length,
    unread_count: unreadItems.length,
    read_count: items.length - unreadItems.length,
    critical_unread_count: criticalUnread,
    high_unread_count: highUnread,
    due_today_count: dueTodayCount,
  };
}

function updateOverviewNotifications(previous: any, nextItems: any[]) {
  if (!previous?.notifications) return previous;
  const nextSummary = buildNotificationSummary(nextItems, previous.notifications.summary);
  return {
    ...previous,
    notifications: {
      ...previous.notifications,
      items: nextItems,
      summary: nextSummary,
    },
    badges: {
      ...(previous.badges || {}),
      notifications_unread_count: nextSummary.unread_count || 0,
    },
  };
}

export function CockpitProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!user) {
        setOverview(null);
        setLoaded(false);
        setLoading(false);
        setError(null);
        return null;
      }
      if (!options.silent) setLoading(true);
      setError(null);
      try {
        const payload = await api("/api/cockpit/overview");
        setOverview(payload || null);
        setLoaded(true);
        return payload || null;
      } catch (err) {
        setError(formatApiError(err, "Impossible de charger le cockpit."));
        setLoaded(true);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [user],
  );

  useEffect(() => {
    if (!user) {
      setOverview(null);
      setLoaded(false);
      setLoading(false);
      setError(null);
      return;
    }
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh({ silent: true });
    }, 60000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [user, refresh]);

  const markNotificationRead = useCallback(
    async (id: string, read = true) => {
      setOverview((previous: any) => {
        const items = Array.isArray(previous?.notifications?.items) ? previous.notifications.items : [];
        return updateOverviewNotifications(
          previous,
          items.map((item: any) => (item.id === id ? { ...item, read } : item)),
        );
      });
      try {
        await api(`/api/ops/notifications/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ read }),
        });
      } catch {
        await refresh({ silent: true });
      }
    },
    [refresh],
  );

  const markAllNotificationsRead = useCallback(async () => {
    setOverview((previous: any) => {
      const items = Array.isArray(previous?.notifications?.items) ? previous.notifications.items : [];
      return updateOverviewNotifications(
        previous,
        items.map((item: any) => ({ ...item, read: true })),
      );
    });
    try {
      await api("/api/ops/notifications/mark-all-read", { method: "POST" });
    } catch {
      await refresh({ silent: true });
    }
  }, [refresh]);

  const value = useMemo(
    () => ({
      overview,
      loading,
      loaded,
      error,
      refresh,
      markNotificationRead,
      markAllNotificationsRead,
    }),
    [overview, loading, loaded, error, refresh, markNotificationRead, markAllNotificationsRead],
  );

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>;
}

export function useCockpit() {
  const context = useContext(CockpitContext);
  if (context) return context;
  return {
    overview: null,
    loading: false,
    loaded: false,
    error: null,
    refresh: async () => null,
    markNotificationRead: async () => {},
    markAllNotificationsRead: async () => {},
  } satisfies CockpitContextValue;
}
