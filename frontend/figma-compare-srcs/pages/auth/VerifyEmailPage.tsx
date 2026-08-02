import { useState, useEffect } from "react";
import { Link } from "react-router";
import { AuthLayout } from "../../components/app/AuthLayout";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";

export function VerifyEmailPage() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [email, setEmail] = useState("");
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setStatus("success"), 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <AuthLayout pill="Vérification email">
      {status === "loading" && (
        <div className="text-center py-12">
          <Loader2 className="w-8 h-8 text-[#1d4ed8] animate-spin mx-auto mb-4" />
          <p className="text-[#6b7280]" style={{ fontSize: "0.875rem" }}>Vérification en cours…</p>
        </div>
      )}
      {status === "success" && (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-[#ecfdf5] flex items-center justify-center mx-auto mb-5">
            <CheckCircle className="w-7 h-7 text-[#059669]" />
          </div>
          <h1 className="text-[#111827] mb-2" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Email vérifié</h1>
          <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>
            Votre compte est activé. Vous pouvez maintenant vous connecter.
          </p>
          <Link to="/app/login?verified=1"
            className="inline-block w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all text-center shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Se connecter
          </Link>
        </div>
      )}
      {status === "error" && (
        <div>
          <div className="w-14 h-14 rounded-full bg-[#fef2f2] flex items-center justify-center mx-auto mb-5">
            <AlertCircle className="w-7 h-7 text-[#dc2626]" />
          </div>
          <h1 className="text-[#111827] mb-2 text-center" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Vérification impossible</h1>
          <p className="text-[#6b7280] mb-7 text-center" style={{ fontSize: "0.875rem" }}>Lien de vérification invalide ou expiré.</p>
          {resendMsg && (
            <div className="mb-5 px-4 py-3 rounded-lg bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]" style={{ fontSize: "0.8125rem" }}>{resendMsg}</div>
          )}
          <div className="space-y-3">
            <input type="email" placeholder="Votre email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} />
            <button onClick={() => { if (email) setResendMsg("Si un compte existe, un email de vérification a été renvoyé."); }}
              className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Renvoyer l'email
            </button>
            <Link to="/app/login" className="block text-center text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
              Se connecter
            </Link>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
