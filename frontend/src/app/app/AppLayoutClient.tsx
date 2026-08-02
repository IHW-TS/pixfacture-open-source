"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { GlobalSearchModal } from "@/components/GlobalSearchModal";
import { rawApi } from "@/lib/api";
import { isInternalUser } from "@/lib/internal";
import onboardingFlow from "@/lib/onboardingFlow";
import { useSession } from "@/lib/useSession";
import { CockpitProvider } from "@/lib/useCockpit";
import LegalAcceptanceGuard from "@/components/LegalAcceptanceGuard";
import BillingStatusBanner from "@/components/BillingStatusBanner";
import SandboxBanner from "@/components/SandboxBanner";
import AuthConfigMismatchBanner from "@/components/AuthConfigMismatchBanner";
import { AppLayout as FigmaAppLayout } from "../../figma/app/components/app/AppLayout";
import { Toaster } from "../../figma/app/components/ui/sonner";
import { canAccessAppPath, defaultAppPath } from "@/lib/permissions";
import { APP_ROUTE_LABELS, getAppRouteLabel } from "@/lib/appNavigation";

// The session bootstrap aborts after 5 seconds. Surface recovery actions before
// that deadline so a stalled request never leaves the user in a dead-end loader.
const SESSION_SLOW_NOTICE_MS = 3500;
const COMPANY_SETUP_ROUTES = [
  "/app/company",
  "/app/settings/company",
  "/app/billing",
  "/app/billing/paywall",
  "/app/settings/billing",
  "/app/logout",
  "/app/password-reset",
];
const SUBSCRIPTION_SETUP_ROUTES = [
  "/app/onboarding",
  "/app/billing",
  "/app/billing/paywall",
  "/app/settings/billing",
  "/app/company",
  "/app/settings/company",
  "/app/logout",
  "/app/password-reset",
];
const INTERNAL_ONLY_ROUTES = ["/app/diagnostic", "/app/session-debug"];
const COMPANY_PROFILE_UPDATED_EVENT = "pixfacture:company-profile-updated";
const OPAQUE_ROUTE_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9]{6,}|[A-Za-z0-9_-]{20,})$/i;

const { getCompanyProfileReadiness, isSubscriptionAccessReady, pathMatchesPrefix } = onboardingFlow;

const currentAppLocation = (fallbackPathname: string) => {
  if (typeof window === "undefined") return fallbackPathname || "/app/dashboard";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
};

export const getAppDocumentTitle = (pathname: string) => {
  const segments = pathname.split("/").filter(Boolean).slice(1);
  if (!segments.length) return "Espace | PixFacture";

  const last = segments.at(-1) || "";
  const parent = segments.at(-2) || "";
  if (last === "new") {
    return `Nouveau · ${getAppRouteLabel(parent)} | PixFacture`;
  }
  if (OPAQUE_ROUTE_SEGMENT.test(last)) {
    return `Détail · ${getAppRouteLabel(parent)} | PixFacture`;
  }

  const labeledSegment = [...segments].reverse().find((segment) => APP_ROUTE_LABELS[segment]);
  return `${getAppRouteLabel(labeledSegment || last)} | PixFacture`;
};

export default function AppLayoutClient({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const authRoutes = ["/app/login", "/app/register", "/app/password-reset", "/app/verify-email"];
  const publicRoutes = [...authRoutes, "/app/invite", "/app/invites/accept"];
  const isAuthRoute = authRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const isPublicRoute = publicRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const {
    loading: sessionLoading,
    user,
    role: sessionRole,
    subscriptionStatus,
    trialEnd,
    sessionError,
    refresh: retrySession,
  } = useSession({ autoRefresh: !isPublicRoute });
  const [f7Notice, setF7Notice] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [sessionSlow, setSessionSlow] = useState(false);
  const [companyProfileReady, setCompanyProfileReady] = useState<boolean | null>(null);
  const [companyProfileRefresh, setCompanyProfileRefresh] = useState(0);
  const roleLower = (sessionRole || "").toLowerCase();
  const isClientRole = roleLower === "client";
  const isInternal = isInternalUser(user);
  const isInternalOnlyRoute = Boolean(pathname && pathMatchesPrefix(pathname, INTERNAL_ONLY_ROUTES));
  const canCompleteOnboarding = ["owner", "admin"].includes(roleLower);
  const shouldCheckLegal = Boolean(user) && !sessionLoading && !isPublicRoute && !isAuthRoute;
  const shouldCheckOnboarding =
    Boolean(user) && shouldCheckLegal && !isClientRole && !isInternal && canCompleteOnboarding;
  const routeAllowed = !user || !pathname ? true : canAccessAppPath(user, pathname);

  useEffect(() => {
    if (!pathname || isPublicRoute) return;
    document.title = getAppDocumentTitle(pathname);
  }, [pathname, isPublicRoute]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F7") {
        e.preventDefault();
        setF7Notice(true);
        if (timeout) {
          clearTimeout(timeout);
        }
        timeout = setTimeout(() => setF7Notice(false), 3000);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handler);
      return () => {
        window.removeEventListener("keydown", handler);
        if (timeout) clearTimeout(timeout);
      };
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        const el = (e.target as HTMLElement | null) || null;
        const tag = (el?.tagName || "").toLowerCase();
        const isTyping = tag === "input" || tag === "textarea" || (el as any)?.isContentEditable;
        if (isTyping) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!pathname) return;
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!routeNotice) return;
    const timeout = window.setTimeout(() => setRouteNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [routeNotice]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setCompanyProfileRefresh((value) => value + 1);
    window.addEventListener(COMPANY_PROFILE_UPDATED_EVENT, handler);
    return () => window.removeEventListener(COMPANY_PROFILE_UPDATED_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!shouldCheckOnboarding) {
      setCompanyProfileReady(null);
      return;
    }
    let cancelled = false;
    const loadCompanyProfile = async () => {
      try {
        const res = await rawApi("/api/company/profile");
        if (!res.ok) {
          if (!cancelled) setCompanyProfileReady(null);
          return;
        }
        const payload = await res.json().catch(() => null);
        if (!cancelled) setCompanyProfileReady(getCompanyProfileReadiness(payload));
      } catch {
        if (!cancelled) setCompanyProfileReady(null);
      }
    };
    void loadCompanyProfile();
    return () => {
      cancelled = true;
    };
  }, [shouldCheckOnboarding, user?.tenant_id, companyProfileRefresh]);

  useEffect(() => {
    if (!sessionLoading || user || isPublicRoute) {
      setSessionSlow(false);
      return;
    }
    const timeout = window.setTimeout(() => setSessionSlow(true), SESSION_SLOW_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [sessionLoading, user, isPublicRoute]);

  useEffect(() => {
    if (!pathname) return;
    if (sessionLoading || !user) return;
    if (!canAccessAppPath(user, pathname)) {
      setRouteNotice(
        isClientRole
          ? "Cette page n’est pas disponible dans le portail client."
          : "Votre rôle ne permet pas cet accès.",
      );
      router.replace(defaultAppPath(user));
      return;
    }
    if (isInternalOnlyRoute && !isInternal) {
      setRouteNotice("Accès réservé au support.");
      router.replace("/app/dashboard");
      return;
    }
  }, [pathname, sessionLoading, sessionRole, user, router, roleLower, isClientRole, isInternal, isInternalOnlyRoute]);

  useEffect(() => {
    if (!pathname || !shouldCheckOnboarding) return;
    if (companyProfileReady === false && !pathMatchesPrefix(pathname, COMPANY_SETUP_ROUTES)) {
      router.replace("/app/company?welcome=1");
      return;
    }
    if (
      companyProfileReady === true &&
      !isSubscriptionAccessReady(subscriptionStatus) &&
      !pathMatchesPrefix(pathname, SUBSCRIPTION_SETUP_ROUTES)
    ) {
      const params = new URLSearchParams({
        onboarding: "subscription",
        return_to: currentAppLocation(pathname),
      });
      setRouteNotice("Choisissez un abonnement avant d'accéder à l'application.");
      router.replace(`/app/billing?${params.toString()}`);
    }
  }, [pathname, shouldCheckOnboarding, companyProfileReady, subscriptionStatus, router]);

  useEffect(() => {
    if (!pathname) return;
    if (sessionLoading) return;
    if (user) return;
    if (sessionError) return;
    if (isPublicRoute) return;
    const requestedPath =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
        : pathname;
    const target = requestedPath ? `/app/login?return_to=${encodeURIComponent(requestedPath)}` : "/app/login";
    router.replace(target);
  }, [pathname, sessionLoading, user, sessionError, isPublicRoute, router]);

  const renderShell = (content: ReactNode) => (
    <div className="figma-root">
      <LegalAcceptanceGuard active={shouldCheckLegal} userKey={user?.id || null} />
      <CockpitProvider>
        <FigmaAppLayout onSearch={() => setSearchOpen(true)}>
          <AuthConfigMismatchBanner
            enabled={Boolean(user) && !sessionLoading && !isPublicRoute && !isAuthRoute && isInternal}
            isInternal={isInternal}
            userKey={user?.id || null}
          />
          {content}
        </FigmaAppLayout>
        <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        <Toaster position="bottom-right" richColors closeButton />
      </CockpitProvider>
    </div>
  );

  if (isAuthRoute || isPublicRoute) {
    return <div className="figma-root">{children}</div>;
  }

  if (sessionLoading && !user) {
    return (
      <div className="figma-root min-h-screen grid place-items-center bg-[#f3f6fb]">
        <div
          className="bg-white border border-[#e2e8f0] rounded-xl px-5 py-4 text-[#475569] shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          role="status"
          aria-live="polite"
        >
          <div>Préparation de votre espace…</div>
          {sessionSlow ? (
            <div className="mt-3 max-w-[320px] text-[0.75rem] leading-[1.45] text-[#64748b]">
              <p>La vérification prend plus de temps que prévu. Vous pouvez relancer le chargement sans attendre.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-lg bg-[#1d4ed8] px-3 py-2 font-semibold text-white"
                >
                  Reprendre maintenant
                </button>
                <button
                  type="button"
                  onClick={() =>
                    router.replace(
                      `/app/login?return_to=${encodeURIComponent(currentAppLocation(pathname || "/app/dashboard"))}`,
                    )
                  }
                  className="rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 font-semibold text-[#334155]"
                >
                  Se connecter
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (!sessionLoading && !user && !isPublicRoute) {
    if (sessionError) {
      return (
        <div className="figma-root min-h-screen grid place-items-center bg-[#f3f6fb] px-4">
          <div className="bg-white border border-[#e2e8f0] rounded-xl px-5 py-4 text-[#475569] shadow-[0_1px_3px_rgba(0,0,0,0.06)] max-w-md w-full">
            <div className="text-[#0f172a] text-[0.9375rem] font-bold">Session indisponible</div>
            <div className="mt-2 text-[0.8125rem] leading-[1.6]">
              {isInternal
                ? sessionError
                : "Votre session n'a pas pu être vérifiée. Reconnectez-vous ou réessayez dans quelques instants."}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void retrySession()}
                className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-white transition-all text-[0.8125rem] font-semibold bg-gradient-to-r from-[#1d4ed8] to-[#4f46e5]"
              >
                Réessayer
              </button>
              <button
                type="button"
                onClick={() => router.replace("/app/login")}
                className="inline-flex items-center justify-center rounded-lg px-3 py-2 border border-[#cbd5e1] text-[#334155] bg-white hover:bg-[#f8fafc] transition-colors text-[0.8125rem] font-semibold"
              >
                Se connecter
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="figma-root min-h-screen grid place-items-center bg-[#f3f6fb]">
        <div className="bg-white border border-[#e2e8f0] rounded-xl px-5 py-4 text-[#475569] shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          Connexion requise. Redirection…
        </div>
      </div>
    );
  }

  if (!sessionLoading && user && !routeAllowed) {
    return renderShell(
      <div className="min-h-[60vh] grid place-items-center px-4" role="status" aria-live="polite">
        <div className="max-w-md rounded-xl border border-[#e2e8f0] bg-white px-5 py-4 text-[#475569] shadow-sm">
          Vérification de vos droits… Redirection vers votre espace autorisé.
        </div>
      </div>,
    );
  }

  if (user && isInternalOnlyRoute && !isInternal) {
    return renderShell(
      <div className="min-h-[60vh] grid place-items-center px-4" role="status" aria-live="polite">
        <div className="max-w-md rounded-xl border border-[#e2e8f0] bg-white px-5 py-4 text-[#475569] shadow-sm">
          Accès réservé au support. Redirection vers votre tableau de bord…
        </div>
      </div>,
    );
  }

  if (!sessionLoading && user && isClientRole) {
    return renderShell(children);
  }

  return renderShell(
    <>
      {f7Notice && (
        <div className="alert-inline toast-top-right" role="status" aria-live="polite">
          Raccourci F7 désactivé pour éviter les interruptions de saisie.
        </div>
      )}
      {routeNotice && (
        <div className="alert-inline toast-top-right" role="status" aria-live="polite">
          {routeNotice}
        </div>
      )}
      <SandboxBanner />
      {!["trial", "trialing"].includes(
        String(subscriptionStatus || "")
          .trim()
          .toLowerCase(),
      ) ? (
        <BillingStatusBanner status={subscriptionStatus} trialEnd={trialEnd} onRefresh={retrySession} />
      ) : null}
      {children}
    </>,
  );
}
