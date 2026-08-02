import { useState } from "react";
import { Link } from "react-router";
import { AuthLayout } from "../../components/app/AuthLayout";
import { Eye, EyeOff, Loader2, Mail, Lock, ArrowRight } from "lucide-react";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setTimeout(() => {
      setLoading(false);
      window.location.hash = "#/app/dashboard";
    }, 800);
  };

  const inputCls = "w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-xl bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)]";

  return (
    <AuthLayout pill="Connexion sécurisée">
      <div className="mb-7">
        <h1 className="text-[#0f172a] mb-1" style={{ fontSize: "1.625rem", fontWeight: 800, letterSpacing: "-0.025em" }}>
          Bon retour 👋
        </h1>
        <p className="text-[#64748b]" style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>
          Connectez-vous à votre espace de facturation sécurisé.
        </p>
      </div>

      {error && (
        <div className="mb-5 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#fef2f2] text-[#dc2626] border border-[#fecaca]" style={{ fontSize: "0.8125rem" }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
            Email professionnel
          </label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94a3b8]" />
            <input
              type="email"
              placeholder="vous@entreprise.fr"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className={`${inputCls} pl-10`}
              style={{ fontSize: "0.875rem" }}
              required
              autoFocus
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Mot de passe</label>
            <Link to="/app/password-reset" className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
              Oublié ?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94a3b8]" />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className={`${inputCls} pl-10 pr-10`}
              style={{ fontSize: "0.875rem" }}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#94a3b8] hover:text-[#64748b] transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {mfaRequired && (
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Code de double authentification (6 chiffres)</label>
            <input
              type="text"
              placeholder="000 000"
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value)}
              className={`${inputCls} text-center tracking-[0.35em]`}
              style={{ fontSize: "1.25rem", fontWeight: 700 }}
              maxLength={6}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-xl text-white flex items-center justify-center gap-2 transition-all disabled:opacity-60 hover:shadow-lg"
          style={{
            fontSize: "0.875rem",
            fontWeight: 600,
            background: loading ? "#93c5fd" : "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
            boxShadow: "0 2px 8px rgba(29,78,216,0.35)",
          }}
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Connexion en cours…</>
          ) : (
            <><span>Se connecter</span><ArrowRight className="w-4 h-4" /></>
          )}
        </button>
      </form>

      <div className="mt-8 pt-6 border-t border-[#f1f5f9] text-center">
        <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>Pas encore de compte ? </span>
        <Link to="/app/register" className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
          Créer un espace
        </Link>
      </div>
    </AuthLayout>
  );
}
