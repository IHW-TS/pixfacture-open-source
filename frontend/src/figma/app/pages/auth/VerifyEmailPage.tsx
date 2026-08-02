"use client";

import { useState, useEffect } from "react";
import { Link } from "@/figma/react-router-compat";
import { AuthLayout } from "../../components/app/AuthLayout";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { api, formatApiError } from "@/lib/api";
import {
  clearVerifiedBillingIntent,
  parseVerifiedBillingIntent,
  persistVerifiedBillingIntent,
} from "@/lib/verifiedBillingIntent";

export function VerifyEmailPage() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [email, setEmail] = useState("");
  const [resendMsg, setResendMsg] = useState("");
  const [resendFailed, setResendFailed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      if (typeof window === "undefined") return;
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const query = new URLSearchParams(window.location.search);
      const token = (query.get("token") || hash.get("token") || "").trim();
      if (!token) {
        if (!cancelled) {
          setStatus("error");
          setError("Lien de vérification invalide ou expiré.");
        }
        return;
      }
      try {
        const response = await api(`/api/auth/verify?token=${encodeURIComponent(token)}`, { method: "GET" });
        const billingIntent = parseVerifiedBillingIntent(response);
        try {
          if (billingIntent) {
            persistVerifiedBillingIntent(window.localStorage, billingIntent);
          } else {
            clearVerifiedBillingIntent(window.localStorage);
          }
        } catch {
          // La vérification du compte reste valide si le stockage navigateur est désactivé.
        }
        if (!cancelled) {
          setStatus("success");
        }
      } catch (err: any) {
        if (!cancelled) {
          setStatus("error");
          setError(formatApiError(err, "Vérification impossible"));
        }
      }
    };

    void verify();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthLayout pill="Vérification email">
      {status === "loading" && (
        <div className="text-center py-12">
          <Loader2 className="w-8 h-8 text-[#1d4ed8] animate-spin mx-auto mb-4" />
          <p className="text-[#6b7280]" style={{ fontSize: "0.875rem" }}>
            Vérification en cours…
          </p>
        </div>
      )}
      {status === "success" && (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-[#ecfdf5] flex items-center justify-center mx-auto mb-5">
            <CheckCircle className="w-7 h-7 text-[#047857]" />
          </div>
          <h1 className="text-[#111827] mb-2" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
            Email vérifié
          </h1>
          <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>
            Votre compte est activé. Vous pouvez maintenant vous connecter.
          </p>
          <Link
            to="/app/login?verified=1"
            className="inline-block w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all text-center shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            Se connecter
          </Link>
        </div>
      )}
      {status === "error" && (
        <div>
          <div className="w-14 h-14 rounded-full bg-[#fef2f2] flex items-center justify-center mx-auto mb-5">
            <AlertCircle className="w-7 h-7 text-[#b91c1c]" />
          </div>
          <h1
            className="text-[#111827] mb-2 text-center"
            style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}
          >
            Vérification impossible
          </h1>
          <p className="text-[#6b7280] mb-7 text-center" style={{ fontSize: "0.875rem" }}>
            {error || "Lien de vérification invalide ou expiré."}
          </p>
          {resendMsg && (
            <div
              role={resendFailed ? "alert" : "status"}
              aria-live={resendFailed ? "assertive" : "polite"}
              className={`mb-5 rounded-lg border px-4 py-3 ${
                resendFailed
                  ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]"
                  : "border-[#a7f3d0] bg-[#ecfdf5] text-[#047857]"
              }`}
              style={{ fontSize: "0.8125rem" }}
            >
              {resendMsg}
            </div>
          )}
          <div className="space-y-3">
            <label htmlFor="verification-resend-email" className="sr-only">
              Email professionnel
            </label>
            <input
              id="verification-resend-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="Votre email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
              style={{ fontSize: "0.875rem" }}
            />
            <button
              onClick={async () => {
                if (!email) return;
                setResendMsg("");
                setResendFailed(false);
                try {
                  await api("/api/auth/resend-verification", {
                    method: "POST",
                    body: JSON.stringify({ email: email.trim() }),
                  });
                  setResendMsg("Si un compte existe, un email de vérification a été renvoyé.");
                } catch (err: any) {
                  setResendFailed(true);
                  setResendMsg(formatApiError(err, "Réessai impossible"));
                }
              }}
              className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
              style={{ fontSize: "0.875rem", fontWeight: 600 }}
            >
              Renvoyer l'email
            </button>
            <Link
              to="/app/login"
              className="block text-center text-[#1d4ed8] hover:text-[#1e40af] transition-colors"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Se connecter
            </Link>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
