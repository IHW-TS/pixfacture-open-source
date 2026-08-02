"use client";

import { useEffect, useState } from "react";
import { rawApi } from "@/lib/api";
import { isCookieAuthMode } from "@/lib/auth";

type AuthConfigMismatchBannerProps = {
  enabled: boolean;
  isInternal: boolean;
  userKey?: string | null;
};

const parseHeaderBool = (value: string | null) => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
};

export default function AuthConfigMismatchBanner({ enabled, isInternal, userKey }: AuthConfigMismatchBannerProps) {
  const [mismatch, setMismatch] = useState(false);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !userKey || !isInternal) {
      setMismatch(false);
      setCheckedKey(null);
      return;
    }
    if (checkedKey === userKey) return;

    let alive = true;
    const runCheck = async () => {
      try {
        const res = await rawApi("/api/diagnostic/config", { method: "GET" });
        if (!res.ok) return;
        const csrfRequired = parseHeaderBool(res.headers.get("x-csrf-required"));
        if (csrfRequired === null) return;
        const cookieMode = isCookieAuthMode();
        if (!alive) return;
        setMismatch(csrfRequired !== cookieMode);
        setCheckedKey(userKey);
      } catch {
        // ignore diagnostic failures
      }
    };
    void runCheck();
    return () => {
      alive = false;
    };
  }, [enabled, userKey, checkedKey, isInternal]);

  if (!mismatch) return null;

  return (
    <div className="alert-inline warning mb-12 flex gap-10 items-center flex-wrap" role="status">
      <span>Configuration d'auth incoh\u00e9rente (cookie vs bearer).</span>
      {isInternal && (
        <a className="btn secondary" href="/app/admin/diagnostic">
          Ouvrir diagnostic
        </a>
      )}
    </div>
  );
}
