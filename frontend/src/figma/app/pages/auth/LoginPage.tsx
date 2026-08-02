"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { AuthLayout } from "../../components/app/AuthLayout";
import { Eye, EyeOff, Loader2, Mail, Lock, ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, formatApiError, sanitizeUserFacingApiMessage } from "@/lib/api";
import { getSessionSnapshot, refreshSession as refreshUserSession } from "@/lib/useSession";
import { isCookieAuthMode, setAuthTokens } from "@/lib/auth";
import { clearCachedCsrfToken } from "@/lib/authCookies";
import { setHadSession } from "@/lib/sessionFlags";
import { useHydrated } from "@/lib/useHydrated";
import { POST_VERIFY_DESTINATION_KEY, postVerifyPathFromStorage } from "@/lib/verifiedBillingIntent";

export function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydrated = useHydrated();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; uri: string; issuer?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextPath, setNextPath] = useState<string | null>(null);

  const normalizeNext = useCallback((value: string | null) => {
    const nextValue = (value || "").trim();
    if (!nextValue) return null;
    if (!nextValue.startsWith("/app/")) return null;
    if (nextValue.startsWith("//")) return null;
    if (nextValue.includes("://")) return null;
    try {
      const parsed = new URL(nextValue, "https://pixfacture.invalid");
      if (parsed.origin !== "https://pixfacture.invalid") return null;
      const carriesBillingIntent = ["/app/billing", "/app/onboarding"].some(
        (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
      );
      if (carriesBillingIntent) {
        parsed.searchParams.delete("plan");
        parsed.searchParams.delete("period");
        parsed.searchParams.delete("checkout");
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }, []);

  const redirectTarget = useCallback(() => {
    if (nextPath) return nextPath;
    if (typeof window === "undefined") return "/app/dashboard";
    const postVerifyTarget = postVerifyPathFromStorage(window.localStorage);
    if (postVerifyTarget) return postVerifyTarget;
    window.localStorage.removeItem("preferred_checkout");
    return "/app/dashboard";
  }, [nextPath]);

  const finishAuthenticatedSession = useCallback(
    async (result?: any) => {
      if (!isCookieAuthMode() && result?.access_token) {
        setAuthTokens({ accessToken: result.access_token, refreshToken: result.refresh_token, persist: true });
      }
      if (isCookieAuthMode()) {
        clearCachedCsrfToken();
      }
      setHadSession();
      await refreshUserSession(true);
      const session = getSessionSnapshot();
      if (!session.user) {
        setHadSession();
        setError(sanitizeUserFacingApiMessage(session.error, undefined, "Session expirée, merci de vous reconnecter."));
        return;
      }
      const target = redirectTarget();
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(POST_VERIFY_DESTINATION_KEY);
        if (target.startsWith("/app/billing?") || target.startsWith("/app/onboarding?")) {
          window.localStorage.removeItem("preferred_checkout");
        }
      }
      router.replace(target);
    },
    [redirectTarget, router],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const notice = window.sessionStorage.getItem("login_notice");
      if (!notice) return;
      window.sessionStorage.removeItem("login_notice");
      setError(sanitizeUserFacingApiMessage(notice, undefined, "Reconnectez-vous pour continuer."));
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    if (!searchParams) return;
    const returnParam = searchParams.get("return_to");
    const returnAlt = searchParams.get("returnTo");
    const nextParam = searchParams.get("next");
    const planParam = searchParams.get("plan");
    const periodParam = searchParams.get("period");
    const normalized = normalizeNext(returnParam || returnAlt || nextParam);
    setNextPath(normalized);
    if (typeof window !== "undefined") {
      if (planParam === "starter" || planParam === "pro") localStorage.setItem("preferred_plan", planParam);
      if (periodParam === "monthly" || periodParam === "yearly") {
        localStorage.setItem("preferred_billing_period", periodParam);
      }
    }
  }, [normalizeNext, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mfaSetup) {
        await apiFetch("/api/auth/mfa/verify", {
          method: "POST",
          body: JSON.stringify({ code: mfaCode.trim() }),
        });
        setMfaSetup(null);
        setMfaRequired(false);
        setMfaCode("");
        await finishAuthenticatedSession();
        return;
      }

      const result: any = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          mfa_code: mfaCode.trim() || undefined,
        }),
      });

      await finishAuthenticatedSession(result);
    } catch (err: any) {
      const code = (err?.code || "").toString().toLowerCase();
      if (code === "mfa_setup_required") {
        setMfaRequired(true);
        setMfaCode("");
        setMfaSetup(null);
        clearCachedCsrfToken();
        try {
          const setup: any = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
          const secret = String(setup?.secret || "");
          if (!secret) throw new Error("missing_mfa_secret");
          setMfaSetup({
            secret,
            uri: String(setup?.uri || ""),
            issuer: setup?.issuer ? String(setup.issuer) : undefined,
          });
          setError(
            "Double authentification obligatoire : ajoutez cette clé dans votre application, puis validez le code.",
          );
        } catch (setupErr) {
          setError(formatApiError(setupErr, "Activation de la double authentification impossible."));
        }
        return;
      }
      if (code === "mfa_required" || code === "mfa_invalid") {
        setMfaRequired(true);
        setMfaSetup(null);
        setError(
          code === "mfa_invalid"
            ? "Code de double authentification invalide."
            : "Code de double authentification requis pour continuer.",
        );
        return;
      }
      setError(formatApiError(err, "Identifiants invalides"));
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    "w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-xl bg-white text-[#0f172a] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)]";

  return (
    <AuthLayout pill="Connexion sécurisée">
      <div className="auth-login__heading mb-7">
        <h1
          className="text-[#0f172a] mb-1"
          style={{ fontSize: "1.625rem", fontWeight: 800, letterSpacing: "-0.025em" }}
        >
          Bon retour 👋
        </h1>
        <p className="text-[#334155]" style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>
          Connectez-vous à votre espace de facturation sécurisé.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-5 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]"
          style={{ fontSize: "0.8125rem" }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="auth-login__form space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-[#374151] mb-1.5"
            style={{ fontSize: "0.8125rem", fontWeight: 500 }}
          >
            Email professionnel
          </label>
          <div className="relative">
            <Mail aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94a3b8]" />
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="vous@entreprise.fr"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (mfaRequired || mfaSetup || mfaCode) {
                  setMfaRequired(false);
                  setMfaSetup(null);
                  setMfaCode("");
                  setError("");
                }
              }}
              className={`${inputCls} auth-login__input pl-10`}
              style={{ fontSize: "0.875rem" }}
              disabled={!hydrated || loading}
              required
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="password" className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
              Mot de passe
            </label>
            <Link
              to="/app/password-reset"
              className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
              style={{ fontSize: "0.75rem", fontWeight: 500 }}
            >
              Oublié ?
            </Link>
          </div>
          <div className="relative">
            <Lock aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94a3b8]" />
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              maxLength={256}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputCls} auth-login__input pl-10 pr-10`}
              style={{ fontSize: "0.875rem" }}
              disabled={!hydrated || loading}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label="Afficher ou masquer le mot de passe"
              aria-pressed={showPassword}
              className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[#64748b] transition-colors hover:bg-[#f1f5f9] hover:text-[#475569]"
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" className="w-4 h-4" />
              ) : (
                <Eye aria-hidden="true" className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {mfaRequired && (
          <div>
            {mfaSetup ? (
              <div className="mb-3 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-3 py-3 text-[#1e3a8a]">
                <div className="mb-1 text-xs font-semibold">Clé de double authentification</div>
                <div
                  data-testid="mfa-setup-secret"
                  className="break-all rounded-lg border border-[#dbeafe] bg-white px-3 py-2 font-mono text-xs font-bold"
                >
                  {mfaSetup.secret}
                </div>
                {mfaSetup.uri ? (
                  <div className="mt-2 break-all text-[11px] leading-4 text-[#475569]">URI : {mfaSetup.uri}</div>
                ) : null}
              </div>
            ) : null}
            <label
              htmlFor="mfa-code"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Code de double authentification (6 chiffres)
            </label>
            <input
              id="mfa-code"
              name="mfa_code"
              type="text"
              autoComplete="one-time-code"
              placeholder="000 000"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              className={`${inputCls} text-center tracking-[0.35em]`}
              style={{ fontSize: "1.25rem", fontWeight: 700 }}
              disabled={!hydrated || loading}
              maxLength={6}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !hydrated}
          className="w-full py-2.5 rounded-xl text-white flex items-center justify-center gap-2 transition-all disabled:opacity-60 hover:shadow-lg"
          style={{
            fontSize: "0.875rem",
            fontWeight: 600,
            background: loading || !hydrated ? "#93c5fd" : "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
            boxShadow: "0 2px 8px rgba(29,78,216,0.35)",
          }}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Connexion en cours…
            </>
          ) : mfaSetup ? (
            <>
              <span>Valider la double authentification</span>
              <ArrowRight className="w-4 h-4" />
            </>
          ) : (
            <>
              <span>Se connecter</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <Link
        to="/app/register?plan=pro"
        className="mt-3 w-full py-2.5 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] text-[#1e3a8a] flex items-center justify-center gap-2 transition-all hover:bg-[#dbeafe]"
        style={{ fontSize: "0.875rem", fontWeight: 650 }}
      >
        <span>Essayer gratuitement</span>
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </Link>
    </AuthLayout>
  );
}
