"use client";

import { useEffect, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { AuthLayout } from "../../components/app/AuthLayout";
import { CheckCircle, Eye, EyeOff } from "lucide-react";
import { api, formatApiError } from "@/lib/api";

export function InvitePage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    setToken((query.get("token") || hash.get("token") || "").trim());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("Lien d'invitation invalide.");
      return;
    }
    if (!password) {
      setError("Mot de passe obligatoire.");
      return;
    }
    if (password !== confirm) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api("/api/users/invite/accept", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err: any) {
      setError(formatApiError(err, "Activation impossible"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout pill="Invitation">
      <h1 className="text-[#111827] mb-1" style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
        Créer votre accès
      </h1>
      <p className="text-[#6b7280] mb-7" style={{ fontSize: "0.875rem" }}>
        Vous avez été invité à rejoindre un espace de facturation
      </p>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-5 px-4 py-3 rounded-lg bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]"
          style={{ fontSize: "0.8125rem" }}
        >
          {error}
        </div>
      )}

      {done ? (
        <div className="space-y-5">
          <div
            role="status"
            aria-live="polite"
            className="px-4 py-3 rounded-lg bg-[#ecfdf5] text-[#047857] border border-[#a7f3d0] flex items-start gap-2.5"
            style={{ fontSize: "0.8125rem" }}
          >
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Compte créé avec succès. Vous pouvez vous connecter.</span>
          </div>
          <Link
            to="/app/login"
            className="block w-full text-center py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            Se connecter
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="invite-password"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Mot de passe
            </label>
            <div className="relative">
              <input
                id="invite-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="Choisir un mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 pr-10 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
                style={{ fontSize: "0.875rem" }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748b] hover:text-[#475569] transition-colors"
                aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                aria-pressed={showPassword}
                title={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Eye className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          <div>
            <label
              htmlFor="invite-password-confirm"
              className="block text-[#374151] mb-1.5"
              style={{ fontSize: "0.8125rem", fontWeight: 500 }}
            >
              Confirmer le mot de passe
            </label>
            <input
              id="invite-password-confirm"
              name="password-confirmation"
              type="password"
              autoComplete="new-password"
              placeholder="Confirmer le mot de passe"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-[#d1d5db] rounded-lg bg-white text-[#111827] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all"
              style={{ fontSize: "0.875rem" }}
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1e40af] active:bg-[#1e3a8a] transition-all shadow-[0_1px_3px_rgba(29,78,216,0.3)]"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            {loading ? "Validation..." : "Valider"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
