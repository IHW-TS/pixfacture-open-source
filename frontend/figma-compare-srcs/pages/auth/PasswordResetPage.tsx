import { useState } from "react";
import { Link } from "react-router";
import { AuthLayout } from "../../components/app/AuthLayout";
import { CheckCircle, Eye, EyeOff } from "lucide-react";

export function PasswordResetPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSent(true);
  };

  return (
    <AuthLayout pill="Sécurité">
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Mot de passe oublié</h1>
      <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>Entrez votre email pour recevoir un lien de réinitialisation</p>

      {sent && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0] flex items-start gap-2.5" style={{ fontSize: "0.8125rem" }}>
          <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Si un compte existe pour cette adresse, vous recevrez un email.</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Email</label>
          <input type="email" placeholder="vous@entreprise.fr" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required autoFocus />
        </div>
        <button type="submit"
          className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
          style={{ fontSize: "0.875rem", fontWeight: 600 }}>
          Envoyer le lien
        </button>
      </form>

      <div className="mt-8 pt-6 border-t border-[#f3f4f6] text-center">
        <Link to="/app/login" className="text-[#1d4ed8] hover:text-[#1e40af] transition-colors" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
          Retour à la connexion
        </Link>
      </div>
    </AuthLayout>
  );
}

export function PasswordResetConfirmPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setDone(true);
  };

  return (
    <AuthLayout pill="Sécurité">
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Nouveau mot de passe</h1>
      <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>Choisissez un nouveau mot de passe sécurisé</p>

      {done ? (
        <div className="space-y-5">
          <div className="px-4 py-3 rounded-lg bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0] flex items-start gap-2.5" style={{ fontSize: "0.8125rem" }}>
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Mot de passe réinitialisé avec succès.</span>
          </div>
          <Link to="/app/login" className="block w-full text-center py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Se connecter
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Nouveau mot de passe</label>
            <div className="relative">
              <input type={showPassword ? "text" : "password"} placeholder="Min. 8 caractères" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 pr-10 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-[#6b7280] transition-colors">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <button type="submit"
            className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Réinitialiser
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
