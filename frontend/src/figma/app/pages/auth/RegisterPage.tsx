"use client";

import { useEffect, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { AuthLayout } from "../../components/app/AuthLayout";
import { Loader2, CheckCircle, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiFetch, formatApiError } from "@/lib/api";
import { refreshSession as refreshUserSession } from "@/lib/useSession";
import { isCookieAuthMode, setAuthTokens } from "@/lib/auth";
import { clearCachedCsrfToken } from "@/lib/authCookies";
import { setHadSession } from "@/lib/sessionFlags";
import { getLegalConfig, getLegalDocVersion } from "@/lib/legalConfig";
import { TRIAL_DAYS } from "@/lib/billingConstants";

type SignupLegalDoc = {
  slug: "terms" | "dpa";
  version: string;
  url: string;
};

type DemoInvitationInfo = {
  email: string;
  preset: string;
  expires_at: string;
};

export function RegisterPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [message, setMessage] = useState("");
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [professionalUseConfirmed, setProfessionalUseConfirmed] = useState(false);
  const [legalDocs, setLegalDocs] = useState<SignupLegalDoc[]>([
    { slug: "terms", version: getLegalDocVersion("terms"), url: "/legal/terms" },
    { slug: "dpa", version: getLegalDocVersion("dpa"), url: "/legal/dpa" },
  ]);
  const [legalDocsLoading, setLegalDocsLoading] = useState(true);
  const [legalDocsError, setLegalDocsError] = useState("");
  const [signupReady, setSignupReady] = useState(false);
  const [signupReadinessMessage, setSignupReadinessMessage] = useState("");
  const [demoInvitationToken, setDemoInvitationToken] = useState("");
  const [demoInvitation, setDemoInvitation] = useState<DemoInvitationInfo | null>(null);
  const [demoInvitationLoading, setDemoInvitationLoading] = useState(false);
  const [demoInvitationError, setDemoInvitationError] = useState("");
  const { companyName: legalCompanyName, privacyContactEmail } = getLegalConfig();
  const demoRequested = Boolean(demoInvitationToken);
  const signupFormDisabled = legalDocsLoading || !signupReady;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = (fragment.get("demo_invitation") || "").trim();
    if (!token) return;
    setDemoInvitationToken(token);
    // The fragment is not sent over HTTP, but removing it also prevents the
    // one-time bearer link from lingering in copied URLs and browser history.
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!demoInvitationToken) return;
    let cancelled = false;
    setDemoInvitationLoading(true);
    setDemoInvitationError("");
    apiFetch("/api/auth/demo-invitations/inspect", {
      method: "POST",
      body: JSON.stringify({ token: demoInvitationToken }),
      timeoutMs: 8000,
    })
      .then((payload: DemoInvitationInfo) => {
        if (cancelled) return;
        setDemoInvitation(payload);
        setEmail(
          String(payload?.email || "")
            .trim()
            .toLowerCase(),
        );
      })
      .catch((err: any) => {
        if (!cancelled) {
          setDemoInvitation(null);
          setDemoInvitationError(formatApiError(err, "Invitation de démo invalide ou expirée."));
        }
      })
      .finally(() => {
        if (!cancelled) setDemoInvitationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demoInvitationToken]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("preferred_plan", "pro");
      localStorage.removeItem("preferred_checkout");
      localStorage.removeItem("preferred_post_verify_destination");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLegalDocsLoading(true);
    setLegalDocsError("");
    apiFetch("/api/legal/public-required", { timeoutMs: 8000 })
      .then((payload: any) => {
        if (cancelled) return;
        // Fail closed with an older backend that does not expose the explicit
        // legal-readiness signal yet.
        const ready = payload?.signupReady === true;
        setSignupReady(ready);
        setSignupReadinessMessage(
          ready ? "" : String(payload?.message || "Les inscriptions sont temporairement indisponibles.").trim(),
        );
        const required = Array.isArray(payload?.required) ? payload.required : [];
        const docs = required
          .map((doc: any): SignupLegalDoc | null => {
            const slug = String(doc?.slug || "")
              .trim()
              .toLowerCase();
            if (slug !== "terms" && slug !== "dpa") return null;
            const version = String(doc?.version || "").trim();
            const url = String(doc?.url || (slug === "terms" ? "/legal/terms" : "/legal/dpa")).trim();
            if (!version) return null;
            return { slug, version, url };
          })
          .filter(Boolean) as SignupLegalDoc[];
        if (docs.length) {
          setLegalDocs(docs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSignupReady(false);
          setSignupReadinessMessage(
            "Impossible de confirmer les documents contractuels. Réessayez prochainement ou contactez le support.",
          );
          setLegalDocsError("Versions légales non confirmées.");
        }
      })
      .finally(() => {
        if (!cancelled) setLegalDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const termsDoc = legalDocs.find((doc) => doc.slug === "terms") || {
    slug: "terms",
    version: getLegalDocVersion("terms"),
    url: "/legal/terms",
  };
  const dpaDoc = legalDocs.find((doc) => doc.slug === "dpa") || {
    slug: "dpa",
    version: getLegalDocVersion("dpa"),
    url: "/legal/dpa",
  };
  const docsToAccept = legalDocs.filter((doc) => doc.version.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const emailNorm = email.trim().toLowerCase();
      if (!signupReady) {
        setLoading(false);
        setMessage(signupReadinessMessage || "Les inscriptions sont temporairement indisponibles.");
        return;
      }
      if (demoRequested && (!demoInvitation || demoInvitationError)) {
        setLoading(false);
        setMessage("Cette invitation de démo ne peut pas être utilisée. Demandez un nouveau lien.");
        return;
      }
      if (!legalAccepted) {
        setLoading(false);
        setMessage("Acceptez les CGV/CGU et le DPA pour créer votre espace.");
        return;
      }
      if (!professionalUseConfirmed) {
        setLoading(false);
        setMessage("Confirmez que vous créez cet espace pour une activité professionnelle.");
        return;
      }
      const response: any = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          company_name: companyName.trim(),
          email: emailNorm,
          password,
          plan: "pro",
          professional_use_confirmed: true,
          accepted_legal_docs: docsToAccept.map((doc) => ({ slug: doc.slug, version: doc.version })),
          ...(demoRequested ? { demo_data: true, demo_invitation_token: demoInvitationToken } : {}),
        }),
      });

      if (response?.notice) {
        setVerificationPending(true);
        setMessage(response.notice);
        return;
      }

      if (response?.verification_required) {
        if (typeof window !== "undefined") {
          localStorage.setItem("preferred_plan", "pro");
          localStorage.removeItem("preferred_checkout");
          sessionStorage.setItem("pending_verification_email", emailNorm);
        }
        setVerificationPending(true);
        setMessage(
          response?.email_sent === false
            ? "Compte créé. Email de vérification non envoyé : contactez le support."
            : "Compte créé. Vérifiez votre email pour activer votre espace.",
        );
      } else {
        if (!isCookieAuthMode() && response?.access_token) {
          setAuthTokens({ accessToken: response.access_token, refreshToken: response.refresh_token, persist: true });
        }
        if (isCookieAuthMode()) {
          clearCachedCsrfToken();
        }
        setHadSession();
        await refreshUserSession(true);
        if (demoRequested && response?.demo_seeded !== false) {
          router.replace("/app/company?demo=1");
        } else {
          router.replace("/app/company?welcome=1");
        }
      }
    } catch (err: any) {
      setVerificationPending(false);
      setMessage(formatApiError(err, "Inscription impossible"));
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm) {
      setMessage("Renseignez votre email pour renvoyer la vérification.");
      return;
    }
    setResending(true);
    try {
      await apiFetch("/api/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: emailNorm }),
      });
      setMessage("Si un compte existe, un email de vérification a été renvoyé.");
    } catch (err: any) {
      setMessage(formatApiError(err, "Réenvoi impossible."));
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout pill={demoRequested ? "Démo guidée" : "Essai gratuit"}>
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
        {demoRequested ? "Créer mon espace démo" : "Créer mon compte"}
      </h1>
      <p className="text-[#4b5563] mb-7" style={{ fontSize: "0.875rem" }}>
        {demoRequested
          ? `Données fictives dans un espace privé pendant ${TRIAL_DAYS} jours.`
          : `Essayez Pro gratuitement pendant ${TRIAL_DAYS} jours, sans carte bancaire. Brouillons et prévisualisations uniquement, sans émission définitive, email client ni transmission.`}
      </p>

      {message && (
        <div
          role={verificationPending ? "status" : "alert"}
          aria-live={verificationPending ? "polite" : "assertive"}
          className={`mb-5 px-4 py-3 rounded-lg border flex items-start gap-2.5 ${verificationPending ? "bg-[#ecfdf5] text-[#047857] border-[#a7f3d0]" : "bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]"}`}
          style={{ fontSize: "0.8125rem" }}
        >
          {verificationPending && <CheckCircle aria-hidden="true" className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <span>{message}</span>
        </div>
      )}

      {!legalDocsLoading && !signupReady && signupReadinessMessage && (
        <div
          id="signup-readiness-status"
          role="status"
          aria-live="polite"
          className="mb-5 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3 text-[#1e40af]"
          style={{ fontSize: "0.8125rem" }}
        >
          <p>{signupReadinessMessage}</p>
          <Link to="/contact" className="mt-2 inline-block font-semibold underline underline-offset-2">
            Contacter le support
          </Link>
        </div>
      )}

      {demoRequested && demoInvitationLoading && (
        <div
          role="status"
          aria-live="polite"
          className="mb-5 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3 text-[0.8125rem] text-[#1d4ed8]"
        >
          Vérification de votre invitation…
        </div>
      )}
      {demoRequested && demoInvitationError && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-[0.8125rem] text-[#b91c1c]"
        >
          <p>{demoInvitationError}</p>
          <Link to="/contact" className="mt-2 inline-block font-semibold text-[#1d4ed8] hover:text-[#1e40af]">
            Contacter le support
          </Link>
        </div>
      )}

      {!verificationPending ? (
        <form
          onSubmit={handleSubmit}
          aria-describedby={
            !legalDocsLoading && !signupReady && signupReadinessMessage ? "signup-readiness-status" : undefined
          }
          className="auth-register__form space-y-4"
        >
          <div>
            <label
              htmlFor="company"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Raison sociale
            </label>
            <input
              id="company"
              name="company"
              type="text"
              autoComplete="organization"
              placeholder="Nom de votre entreprise"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              disabled={signupFormDisabled}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
              style={{ fontSize: "0.875rem" }}
              required
            />
          </div>
          <div>
            <label
              htmlFor="email"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Email professionnel
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="vous@entreprise.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              readOnly={demoRequested}
              aria-readonly={demoRequested}
              disabled={signupFormDisabled}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
              style={{ fontSize: "0.875rem" }}
              required
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Mot de passe
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                maxLength={256}
                placeholder="Min. 12 caractères"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={signupFormDisabled}
                className="w-full px-3.5 py-2.5 pr-10 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                style={{ fontSize: "0.875rem" }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label="Afficher ou masquer le mot de passe"
                aria-pressed={showPassword}
                disabled={signupFormDisabled}
                className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[#6b7280] transition-colors hover:bg-[#f3f4f6] hover:text-[#4b5563]"
              >
                {showPassword ? (
                  <EyeOff aria-hidden="true" className="w-4 h-4" />
                ) : (
                  <Eye aria-hidden="true" className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
          <div className="space-y-3 rounded-lg border border-[#dbe4f0] bg-[#f8fafc] px-3.5 py-3">
            <label className="flex items-start gap-2.5 text-[#374151]" htmlFor="professional-use-confirmation">
              <input
                id="professional-use-confirmation"
                type="checkbox"
                checked={professionalUseConfirmed}
                onChange={(event) => setProfessionalUseConfirmed(event.target.checked)}
                disabled={signupFormDisabled}
                className="mt-0.5 h-4 w-4 rounded border-[#94a3b8] accent-[#1d4ed8]"
                required
              />
              <span style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                Je crée ce compte pour une entreprise ou une activité professionnelle.
              </span>
            </label>
            <div className="border-t border-[#e2e8f0]" />
            <label className="flex items-start gap-2.5 text-[#374151]" htmlFor="legal-acceptance">
              <input
                id="legal-acceptance"
                type="checkbox"
                checked={legalAccepted}
                onChange={(event) => setLegalAccepted(event.target.checked)}
                disabled={signupFormDisabled}
                className="mt-0.5 h-4 w-4 rounded border-[#94a3b8] accent-[#1d4ed8]"
                required
              />
              <span style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                J’accepte les{" "}
                <Link to={termsDoc.url} className="font-semibold text-[#1d4ed8] hover:text-[#1e40af]">
                  CGV/CGU
                </Link>{" "}
                (v. {termsDoc.version || "à confirmer"}) et le{" "}
                <Link to={dpaDoc.url} className="font-semibold text-[#1d4ed8] hover:text-[#1e40af]">
                  DPA RGPD
                </Link>{" "}
                (v. {dpaDoc.version || "à confirmer"}).
              </span>
            </label>
            <p className="pl-6 text-[#475569]" style={{ fontSize: "0.7rem", lineHeight: 1.4 }}>
              {legalDocsLoading
                ? "Vérification des versions légales..."
                : legalDocsError || "Une preuve d’acceptation est enregistrée."}
            </p>
          </div>
          <p className="text-[0.7rem] leading-relaxed text-[#475569]">
            {legalCompanyName} traite ces données pour créer et sécuriser le compte (mesures précontractuelles,
            l’exécution du contrat et l’intérêt légitime de sécurité). Un compte non vérifié et inutilisé peut être
            anonymisé à J+7. Un essai expiré et inutilisé peut l’être 30 jours après sa fin, uniquement sans donnée
            métier, pièce comptable, activité récente, mesure de conservation ou obligation légale. Vos droits :{" "}
            {privacyContactEmail}.{" "}
            <Link to="/legal/privacy" className="font-semibold text-[#1d4ed8] underline underline-offset-2">
              Confidentialité
            </Link>
            .
          </p>
          <button
            type="submit"
            disabled={
              loading ||
              !legalAccepted ||
              !professionalUseConfirmed ||
              legalDocsLoading ||
              !signupReady ||
              Boolean(legalDocsError) ||
              (demoRequested && (demoInvitationLoading || !demoInvitation || Boolean(demoInvitationError)))
            }
            className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all disabled:opacity-60 shadow-[0_1px_3px_rgba(29,78,216,0.3)] flex items-center justify-center gap-2"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Création…
              </>
            ) : demoRequested ? (
              "Créer l’espace démo"
            ) : (
              "Commencer mon essai gratuit"
            )}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <button
            className="w-full py-2.5 border border-[#d1d5db] rounded-lg text-[#374151] hover:bg-[#f9fafb] transition-colors disabled:opacity-60"
            style={{ fontSize: "0.875rem" }}
            onClick={resendVerification}
            disabled={resending}
            type="button"
          >
            {resending ? "Envoi..." : "Renvoyer l'email"}
          </button>
          <Link
            to="/app/login"
            className="block text-center text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
            style={{ fontSize: "0.8125rem", fontWeight: 500 }}
          >
            Se connecter
          </Link>
        </div>
      )}

      <div className="mt-6 pt-4 border-t border-[#f3f4f6] text-center">
        <span className="text-[#475569]" style={{ fontSize: "0.8125rem" }}>
          Déjà un compte ?{" "}
        </span>
        <Link
          to="/app/login"
          className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
          style={{ fontSize: "0.8125rem", fontWeight: 500 }}
        >
          Se connecter
        </Link>
      </div>
    </AuthLayout>
  );
}
