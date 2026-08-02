"use client";
import { type ReactNode } from "react";
import { useParams, Link } from "@/figma/react-router-compat";
import { Shield, FileText, Download, Check, X, Clock, ArrowLeft } from "lucide-react";

/* ── Portal Layout ── */
function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <header className="bg-white border-b border-[#e2e8f0] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#1d4ed8] flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="text-[#0f1e36]" style={{ fontWeight: 700, fontSize: "1rem" }}>
            PixFacture
          </span>
          <span className="text-[#0f1e36]/40 ml-2" style={{ fontSize: "0.75rem" }}>
            Portail client
          </span>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

/* ── Client Portal (token) ── */
export function ClientPortalPage() {
  const { token } = useParams();

  const documents = [
    { type: "invoice", id: "inv1", number: "FAC-2026-012", date: "01/03/2026", total: "2 400,00 €", status: "sent" },
    { type: "invoice", id: "inv2", number: "FAC-2026-011", date: "28/02/2026", total: "5 800,00 €", status: "paid" },
    { type: "quote", id: "q1", number: "DEV-2026-001", date: "28/02/2026", total: "2 400,00 €", status: "sent" },
  ];

  const statusLabels: Record<string, { label: string; class: string }> = {
    sent: { label: "Envoyée", class: "bg-[#d97706]/10 text-[#d97706]" },
    paid: { label: "Payée", class: "bg-[#059669]/10 text-[#059669]" },
    draft: { label: "Brouillon", class: "bg-gray-100 text-gray-500" },
    accepted: { label: "Accepté", class: "bg-[#059669]/10 text-[#059669]" },
    rejected: { label: "Refusé", class: "bg-red-100 text-red-600" },
  };

  return (
    <PortalLayout>
      <h1 className="text-[#0f1e36] mb-1" style={{ fontSize: "1.375rem", fontWeight: 700 }}>
        Vos documents
      </h1>
      <p className="text-[#0f1e36]/60 mb-6" style={{ fontSize: "0.875rem" }}>
        Retrouvez vos factures, avoirs et devis.
      </p>

      <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#e2e8f0]">
              {["Type", "Numéro", "Date", "Statut", "Total TTC", ""].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-[#0f1e36]/50"
                  style={{ fontSize: "0.6875rem", fontWeight: 600 }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => {
              const st = statusLabels[doc.status] || { label: doc.status, class: "bg-gray-100 text-gray-500" };
              const href = doc.type === "invoice" ? `/c/${token}/invoices/${doc.id}` : `/c/${token}/quotes/${doc.id}`;
              return (
                <tr key={doc.id} className="border-b border-[#e2e8f0] last:border-0 hover:bg-[#f8fafc]">
                  <td className="px-4 py-3">
                    <FileText className="w-4 h-4 text-[#0f1e36]/40" />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={href}
                      className="text-[#1d4ed8] hover:underline"
                      style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                    >
                      {doc.number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-[#0f1e36]" style={{ fontSize: "0.8125rem" }}>
                    {doc.date}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full ${st.class}`}
                      style={{ fontSize: "0.6875rem", fontWeight: 600 }}
                    >
                      {st.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#0f1e36]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                    {doc.total}
                  </td>
                  <td className="px-4 py-3">
                    <button className="text-[#1d4ed8] hover:underline" style={{ fontSize: "0.75rem" }}>
                      <Download className="w-3.5 h-3.5 inline mr-1" />
                      PDF
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[#0f1e36]/30 mt-6 text-center" style={{ fontSize: "0.6875rem" }}>
        Ce portail est généré automatiquement par PixFacture. Lien sécurisé — ne le partagez pas.
      </p>
    </PortalLayout>
  );
}

/* ── Portal: Invoice Detail ── */
export function PortalInvoiceDetailPage() {
  const { token, invoiceId } = useParams();

  return (
    <PortalLayout>
      <Link
        to={`/c/${token}`}
        className="inline-flex items-center gap-1 text-[#0f1e36]/60 hover:text-[#1d4ed8] mb-4"
        style={{ fontSize: "0.8125rem" }}
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Retour aux documents
      </Link>
      <div className="bg-white border border-[#e2e8f0] rounded-xl p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[#0f1e36]" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              FAC-2026-012
            </h1>
            <p className="text-[#0f1e36]/50 mt-0.5" style={{ fontSize: "0.8125rem" }}>
              Émise le 01/03/2026 · Échéance : 31/03/2026
            </p>
          </div>
          <span
            className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#d97706]/10 text-[#d97706]"
            style={{ fontSize: "0.75rem", fontWeight: 600 }}
          >
            Envoyée
          </span>
        </div>
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div className="space-y-2" style={{ fontSize: "0.8125rem" }}>
            <div className="flex justify-between">
              <span className="text-[#0f1e36]/50">Total HT</span>
              <span className="text-[#0f1e36]">2 000,00 €</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#0f1e36]/50">TVA (20%)</span>
              <span className="text-[#0f1e36]">400,00 €</span>
            </div>
            <div className="flex justify-between border-t border-[#e2e8f0] pt-2 mt-2">
              <span className="text-[#0f1e36]" style={{ fontWeight: 600 }}>
                Total TTC
              </span>
              <span className="text-[#0f1e36]" style={{ fontWeight: 700 }}>
                2 400,00 €
              </span>
            </div>
          </div>
          <div className="space-y-2" style={{ fontSize: "0.8125rem" }}>
            <div className="flex justify-between">
              <span className="text-[#0f1e36]/50">Conditions</span>
              <span className="text-[#0f1e36]">30 jours fin de mois</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#0f1e36]/50">Mode de paiement</span>
              <span className="text-[#0f1e36]">Virement</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1d4ed8]/90"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            <Download className="w-4 h-4" /> Télécharger PDF
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f1e36]/70 hover:bg-[#0f1e36]/5"
            style={{ fontSize: "0.875rem" }}
          >
            <Download className="w-4 h-4" /> Factur-X
          </button>
        </div>
      </div>
    </PortalLayout>
  );
}

/* ── Portal: Quote Detail ── */
export function PortalQuoteDetailPage() {
  const { token, quoteId } = useParams();

  return (
    <PortalLayout>
      <Link
        to={`/c/${token}`}
        className="inline-flex items-center gap-1 text-[#0f1e36]/60 hover:text-[#1d4ed8] mb-4"
        style={{ fontSize: "0.8125rem" }}
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Retour aux documents
      </Link>
      <div className="bg-white border border-[#e2e8f0] rounded-xl p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[#0f1e36]" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              DEV-2026-001
            </h1>
            <p className="text-[#0f1e36]/50 mt-0.5" style={{ fontSize: "0.8125rem" }}>
              Émis le 28/02/2026 · Valable jusqu'au 30/03/2026
            </p>
          </div>
          <span
            className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#d97706]/10 text-[#d97706]"
            style={{ fontSize: "0.75rem", fontWeight: 600 }}
          >
            En attente
          </span>
        </div>
        <div className="space-y-2 mb-6" style={{ fontSize: "0.8125rem" }}>
          <div className="flex justify-between">
            <span className="text-[#0f1e36]/50">Total HT</span>
            <span className="text-[#0f1e36]">2 000,00 €</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#0f1e36]/50">TVA (20%)</span>
            <span className="text-[#0f1e36]">400,00 €</span>
          </div>
          <div className="flex justify-between border-t border-[#e2e8f0] pt-2 mt-2">
            <span className="text-[#0f1e36]" style={{ fontWeight: 600 }}>
              Total TTC
            </span>
            <span className="text-[#0f1e36]" style={{ fontWeight: 700 }}>
              2 400,00 €
            </span>
          </div>
        </div>
        <div className="p-4 bg-[#1d4ed8]/5 border border-[#1d4ed8]/10 rounded-lg mb-6">
          <p className="text-[#0f1e36]/70" style={{ fontSize: "0.8125rem" }}>
            En acceptant ce devis, vous confirmez votre accord sur les conditions et les tarifs proposés.
          </p>
          <label className="flex items-center gap-2 mt-3" style={{ fontSize: "0.8125rem" }}>
            <input type="checkbox" className="rounded border-[#e2e8f0]" />
            <span className="text-[#0f1e36]">J'accepte les conditions générales de vente</span>
          </label>
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#059669] text-white rounded-lg hover:bg-[#059669]/90"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            <Check className="w-4 h-4" /> Accepter le devis
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
            style={{ fontSize: "0.875rem" }}
          >
            <X className="w-4 h-4" /> Refuser
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f1e36]/70 hover:bg-[#0f1e36]/5"
            style={{ fontSize: "0.875rem" }}
          >
            <Download className="w-4 h-4" /> PDF
          </button>
        </div>
      </div>
    </PortalLayout>
  );
}

/* ── Invite Portal (token) — /i/:token ── */
export function InvitePortalPage() {
  const { token } = useParams();
  return (
    <PortalLayout>
      <div className="max-w-md mx-auto text-center py-8">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-[#1d4ed8]/10 flex items-center justify-center">
          <Shield className="w-8 h-8 text-[#1d4ed8]" />
        </div>
        <h1 className="text-[#0f1e36] mb-3" style={{ fontSize: "1.375rem", fontWeight: 700 }}>
          Invitation
        </h1>
        <p className="text-[#0f1e36]/60 mb-6" style={{ fontSize: "0.875rem" }}>
          Vous avez été invité(e) à rejoindre un espace de facturation PixFacture.
        </p>
        <Link
          to="/app/register"
          className="inline-block px-6 py-3 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1d4ed8]/90"
          style={{ fontSize: "0.875rem", fontWeight: 600 }}
        >
          Créer mon compte
        </Link>
        <p className="text-[#0f1e36]/40 mt-4" style={{ fontSize: "0.75rem" }}>
          Déjà un compte ?{" "}
          <Link to="/app/login" className="text-[#1d4ed8] hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </PortalLayout>
  );
}

/* ── Quote Portal (token) — /q/:token ── */
export function QuotePortalPage() {
  const { token } = useParams();
  return (
    <PortalLayout>
      <div className="bg-white border border-[#e2e8f0] rounded-xl p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[#0f1e36]" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              Devis DEV-2026-001
            </h1>
            <p className="text-[#0f1e36]/50 mt-0.5" style={{ fontSize: "0.8125rem" }}>
              Valable jusqu'au 30/03/2026
            </p>
          </div>
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#d97706]/10 text-[#d97706]"
            style={{ fontSize: "0.75rem", fontWeight: 600 }}
          >
            <Clock className="w-3 h-3" /> En attente
          </span>
        </div>
        <div className="border border-[#e2e8f0] rounded-lg p-4 mb-6 space-y-2" style={{ fontSize: "0.8125rem" }}>
          <div className="flex justify-between">
            <span className="text-[#0f1e36]/50">Total TTC</span>
            <span className="text-[#0f1e36]" style={{ fontWeight: 700 }}>
              2 400,00 €
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#059669] text-white rounded-lg hover:bg-[#059669]/90"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            <Check className="w-4 h-4" /> Accepter
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
            style={{ fontSize: "0.875rem" }}
          >
            <X className="w-4 h-4" /> Refuser
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2.5 border border-[#e2e8f0] rounded-lg text-[#0f1e36]/70"
            style={{ fontSize: "0.875rem" }}
          >
            <Download className="w-4 h-4" /> PDF
          </button>
        </div>
      </div>
    </PortalLayout>
  );
}
