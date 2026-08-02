import { useState } from "react";
import { Link } from "react-router";
import { AuthLayout } from "../../components/app/AuthLayout";
import { Loader2, CheckCircle, Eye, EyeOff } from "lucide-react";

export function RegisterPage() {
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setVerificationPending(true);
      setMessage("Compte créé. Vérifiez votre email pour activer votre espace.");
    }, 800);
  };

  return (
    <AuthLayout pill="Onboarding">
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Créer mon compte</h1>
      <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>Commencez à facturer en quelques minutes</p>

      {message && (
        <div className={`mb-5 px-4 py-3 rounded-lg border flex items-start gap-2.5 ${verificationPending ? "bg-[#ecfdf5] text-[#059669] border-[#a7f3d0]" : "bg-[#fef2f2] text-[#dc2626] border-[#fecaca]"}`} style={{ fontSize: "0.8125rem" }}>
          {verificationPending && <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <span>{message}</span>
        </div>
      )}

      {!verificationPending ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Raison sociale</label>
            <input type="text" placeholder="Nom de votre entreprise" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required autoFocus />
          </div>
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Email professionnel</label>
            <input type="email" placeholder="vous@entreprise.fr" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required />
          </div>
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Mot de passe</label>
            <div className="relative">
              <input type={showPassword ? "text" : "password"} placeholder="Min. 8 caractères" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 pr-10 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-[#6b7280] transition-colors">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <p className="text-[#9ca3af]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
            En créant un compte, vous acceptez nos conditions d'utilisation. Votre compte vous attribue le rôle propriétaire.
          </p>
          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all disabled:opacity-60 shadow-[0_1px_3px_rgba(29,78,216,0.3)] flex items-center justify-center gap-2"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Création…</> : "Créer le compte"}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <button className="w-full py-2.5 border border-[#d1d5db] rounded-lg text-[#374151] hover:bg-[#f9fafb] transition-colors" style={{ fontSize: "0.875rem" }}>
            Renvoyer l'email
          </button>
          <Link to="/app/login" className="block text-center text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
            Se connecter
          </Link>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-[#f3f4f6] text-center">
        <span className="text-[#9ca3af]" style={{ fontSize: "0.8125rem" }}>Déjà un compte ? </span>
        <Link to="/app/login" className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Se connecter</Link>
      </div>
    </AuthLayout>
  );
}
