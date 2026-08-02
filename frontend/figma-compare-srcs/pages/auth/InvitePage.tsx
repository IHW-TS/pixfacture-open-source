import { useState } from "react";
import { Link } from "react-router";
import { AuthLayout } from "../../components/app/AuthLayout";
import { CheckCircle, Eye, EyeOff } from "lucide-react";

export function InvitePage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) { setError("Mot de passe obligatoire."); return; }
    if (password !== confirm) { setError("Les mots de passe ne correspondent pas."); return; }
    setError("");
    setDone(true);
  };

  return (
    <AuthLayout pill="Invitation">
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Créer votre accès</h1>
      <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>Vous avez été invité à rejoindre un espace de facturation</p>

      {error && <div className="mb-5 px-4 py-3 rounded-lg bg-[#fef2f2] text-[#dc2626] border border-[#fecaca]" style={{ fontSize: "0.8125rem" }}>{error}</div>}

      {done ? (
        <div className="space-y-5">
          <div className="px-4 py-3 rounded-lg bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0] flex items-start gap-2.5" style={{ fontSize: "0.8125rem" }}>
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Compte créé avec succès. Vous pouvez vous connecter.</span>
          </div>
          <Link to="/app/login" className="block w-full text-center py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Se connecter
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Mot de passe</label>
            <div className="relative">
              <input type={showPassword ? "text" : "password"} placeholder="Choisir un mot de passe" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 pr-10 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-[#6b7280] transition-colors">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Confirmer le mot de passe</label>
            <input type="password" placeholder="Confirmer le mot de passe" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all" style={{ fontSize: "0.875rem" }} required />
          </div>
          <button type="submit"
            className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Valider
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
