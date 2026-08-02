import { useState } from "react";
import { Link } from "react-router";
import { AppPageHeader, StatusPill, PrimaryButton, SecondaryButton, Card } from "../../components/app/AppPageHeader";
import { Check, Shield, Sparkles, Zap, Star, Lock } from "lucide-react";

const plans = [
  {
    id: "starter",
    name: "Starter",
    desc: "Pour les TPE qui veulent facturer proprement.",
    priceMonthly: "29",
    priceYearly: "290",
    color: "from-[#64748b] to-[#475569]",
    features: [
      "Factures & avoirs illimitées",
      "PDF + CII (EN16931)",
      "1 utilisateur",
      "Exports CSV",
      "Support par email",
    ],
    popular: false,
  },
  {
    id: "pro",
    name: "Pro",
    desc: "Pour les PME qui collaborent et exportent.",
    popular: true,
    priceMonthly: "59",
    priceYearly: "590",
    color: "from-[#1d4ed8] to-[#4f46e5]",
    features: [
      "Tout Starter",
      "3 utilisateurs dont 1 comptable",
      "Factur-X (PDF + XML EN16931)",
      "Export ou connecteur PA selon configuration",
      "E-reporting selon configuration",
    ],
  },
  {
    id: "enterprise",
    name: "Volume",
    desc: "Pour les grandes structures et groupes.",
    priceMonthly: "Sur devis",
    priceYearly: "Sur devis",
    color: "from-[#7c3aed] to-[#6d28d9]",
    features: [],
    popular: false,
  },
];

export function BillingPage() {
  const [period, setPeriod] = useState<"monthly" | "yearly">("yearly");

  return (
    <div>
      <AppPageHeader
        title="Abonnement"
        breadcrumb="Paramètres · Abonnement"
        description="Gérez votre plan PixFacture, vos paiements et vos factures d’abonnement."
        actions={
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#ecfdf5] border border-[#bbf7d0]">
            <Lock className="w-3.5 h-3.5 text-[#059669]" />
            <span className="text-[#059669]" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
              Paiement sécurisé
            </span>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-6">
        {/* Current plan banner */}
        <div
          className="relative overflow-hidden rounded-2xl p-5 border border-[#1d4ed8]/20"
          style={{ background: "linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)" }}
        >
          <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-[#1d4ed8]/10 blur-[80px] pointer-events-none" />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                  Abonnement synchronisé
                </h3>
                <StatusPill status="muted" label="À vérifier" />
              </div>
              <p className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                Consultez la page d’abonnement active pour voir le plan, la période et les actions disponibles.
              </p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <SecondaryButton>Gérer / Annuler</SecondaryButton>
              <Link
                to="/contact"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white transition-all shadow-[0_2px_8px_rgba(29,78,216,0.3)]"
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  background: "linear-gradient(135deg, #1d4ed8, #4f46e5)",
                }}
              >
                Parler à un expert
              </Link>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-[#0f172a]" style={{ fontSize: "1.125rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
            Choisissez votre plan
          </h2>
          {/* Period toggle */}
          <div className="inline-flex items-center bg-[#f1f5f9] rounded-xl p-1">
            {(["monthly", "yearly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-1.5 rounded-lg transition-all ${period === p ? "bg-white text-[#0f172a] shadow-sm" : "text-[#64748b] hover:text-[#374151]"}`}
                style={{ fontSize: "0.8125rem", fontWeight: 500 }}
              >
                {p === "monthly" ? (
                  "Mensuel"
                ) : (
                  <span className="flex items-center gap-1.5">
                    Annuel{" "}
                    <span className="text-[#059669]" style={{ fontSize: "0.6875rem", fontWeight: 700 }}>
                      -17%
                    </span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Plans */}
        <div className="grid md:grid-cols-3 gap-5">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={`bg-white border rounded-2xl p-6 relative transition-all hover:-translate-y-1 hover:shadow-xl ${
                plan.popular
                  ? "border-[#1d4ed8] shadow-[0_0_0_2px_#1d4ed8,0_8px_32px_rgba(29,78,216,0.15)]"
                  : "border-[#e2e8f0] shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              }`}
            >
              {plan.popular && (
                <div
                  className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-3 py-1 text-white rounded-full flex items-center gap-1.5 shadow-lg"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    background: "linear-gradient(135deg, #1d4ed8, #4f46e5)",
                  }}
                >
                  <Star className="w-3 h-3" /> Le plus populaire
                </div>
              )}

              <div
                className={`w-10 h-10 rounded-xl bg-gradient-to-br ${plan.color} flex items-center justify-center mb-4 shadow-lg`}
              >
                {plan.popular ? (
                  <Sparkles className="w-5 h-5 text-white" />
                ) : plan.id === "enterprise" ? (
                  <Zap className="w-5 h-5 text-white" />
                ) : (
                  <Shield className="w-5 h-5 text-white" />
                )}
              </div>

              <h3 className="text-[#0f172a] mb-1" style={{ fontSize: "1.125rem", fontWeight: 700 }}>
                {plan.name}
              </h3>
              <p className="text-[#64748b] mb-5" style={{ fontSize: "0.8125rem" }}>
                {plan.desc}
              </p>

              <div className="mb-5">
                {plan.id === "enterprise" ? (
                  <span className="text-[#0f172a]" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
                    Sur devis
                  </span>
                ) : (
                  <>
                    <span
                      className="text-[#0f172a]"
                      style={{ fontSize: "2.25rem", fontWeight: 800, letterSpacing: "-0.03em" }}
                    >
                      {period === "yearly" ? plan.priceYearly : plan.priceMonthly} €
                    </span>
                    <span className="text-[#94a3b8] ml-1" style={{ fontSize: "0.875rem" }}>
                      / {period === "yearly" ? "an" : "mois"}
                    </span>
                  </>
                )}
              </div>

              {plan.id !== "enterprise" && (
                <ul className="space-y-2.5 mb-6">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2.5" style={{ fontSize: "0.8125rem" }}>
                      <div className="w-4 h-4 rounded-full bg-[#ecfdf5] border border-[#bbf7d0] flex items-center justify-center flex-shrink-0">
                        <Check className="w-2.5 h-2.5 text-[#059669]" style={{ strokeWidth: 2.5 }} />
                      </div>
                      <span className="text-[#374151]">{f}</span>
                    </li>
                  ))}
                </ul>
              )}

              {plan.popular ? (
                <PrimaryButton className="w-full justify-center py-2.5">Choisir {plan.name}</PrimaryButton>
              ) : plan.id === "enterprise" ? (
                <button
                  className="w-full py-2.5 rounded-lg border-2 border-[#7c3aed]/30 text-[#7c3aed] hover:bg-[#f5f3ff] transition-all"
                  style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  Nous contacter
                </button>
              ) : (
                <SecondaryButton className="w-full justify-center py-2.5">Choisir {plan.name}</SecondaryButton>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-start gap-3 p-4 bg-[#fffbeb] border border-[#fde68a] rounded-xl max-w-4xl">
          <Shield className="w-4 h-4 text-[#d97706] flex-shrink-0 mt-0.5" />
          <p className="text-[#92400e]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
            <strong>Important :</strong> PixFacture n'est pas une plateforme agréée (PA). La transmission réglementaire
            passe par une PA choisie et contractualisée par le client. Nos connecteurs facilitent l'intégration.
          </p>
        </div>
      </div>
    </div>
  );
}
