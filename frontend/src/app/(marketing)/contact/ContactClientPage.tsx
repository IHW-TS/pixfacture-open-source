"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Mail, MapPin } from "lucide-react";
import { apiFetch, formatApiError } from "@/lib/api";
import { getLegalConfig, isLegalValueMissing } from "@/lib/legalConfig";
import { complianceTimeline, formatYearRange } from "@/lib/complianceTimeline";
import { pdpIntegrationEnabled, pdpPartnerLabelMarketing } from "@/lib/featureFlags";
import { EXPLANATION } from "@/lib/terminology";
import { LegalLayout } from "@/figma/app/components/landing/LegalLayout";
import { LegalPageShell } from "@/figma/app/components/landing/LegalPageShell";

const MESSAGE_TEMPLATES = [
  {
    id: "migration",
    label: "Projet migration",
    value:
      "Bonjour, nous avons un projet de migration depuis un outil existant. Pouvez-vous nous proposer un plan de reprise des données et de déploiement ?",
  },
  {
    id: "pricing",
    label: "Question tarif",
    value:
      "Bonjour, j'aimerais un accompagnement pour choisir le bon plan selon notre volumétrie, le nombre d'utilisateurs et nos besoins d'intégration.",
  },
  {
    id: "compliance",
    label: "Conformité 2026-2027",
    value:
      "Bonjour, nous souhaitons valider notre trajectoire de préparation à la réforme 2026-2027 (formats, transmission, e-reporting, rôles internes).",
  },
];

export default function ContactPage() {
  const {
    companyName: legalCompanyName,
    supportEmail,
    email,
    address,
    dpoEmail,
    privacyContactEmail,
  } = getLegalConfig();
  const contactEmail = supportEmail || email;
  const privacyEmail = dpoEmail || privacyContactEmail || contactEmail;
  const hasContactEmail = !isLegalValueMissing(contactEmail);
  const supportEmailLabel = hasContactEmail ? contactEmail : "À compléter";
  const hasAddress = !isLegalValueMissing(address || "");
  const timelineRange = formatYearRange(
    complianceTimeline.einvoicing.reception,
    complianceTimeline.einvoicing.emission_pme_micro,
    "-",
  );
  const [company, setCompany] = useState("");
  const [emailValue, setEmailValue] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slaDays = useMemo(() => {
    const raw = (process.env.NEXT_PUBLIC_SALES_SLA_DAYS || "").trim();
    const parsed = Number.parseInt(raw || "2", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }, []);

  const slaLabel = slaDays > 1 ? `${slaDays} jours ouvrés` : `${slaDays} jour ouvré`;
  const supportHours = useMemo(() => (process.env.NEXT_PUBLIC_LEGAL_SUPPORT_HOURS || "").trim(), []);
  const supportTimezone = useMemo(() => (process.env.NEXT_PUBLIC_LEGAL_SUPPORT_TZ || "Europe/Paris").trim(), []);

  const utmParams = useMemo(() => {
    if (typeof window === "undefined") return {};
    const search = new URLSearchParams(window.location.search);
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
    const entries = keys.map((key) => [key, (search?.get(key) || "").trim()] as const).filter(([, value]) => value);
    return Object.fromEntries(entries) as Record<string, string>;
  }, []);

  const messageLength = message.trim().length;
  const remainingChars = Math.max(0, 2000 - messageLength);
  const integrationLabel = pdpIntegrationEnabled ? pdpPartnerLabelMarketing : EXPLANATION;

  const applyTemplate = (template: string) => {
    setMessage(template);
    setSuccess(false);
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setError(null);

    const formData = new FormData(event.currentTarget);
    const honeypotValue = String(formData.get("website") || "").trim();

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Merci de préciser votre besoin.");
      return;
    }
    if (trimmedMessage.length > 2000) {
      setError("Message trop long (2000 caractères max).");
      return;
    }

    const payload: Record<string, string> = {
      message: trimmedMessage,
      source: "contact_page",
      ...utmParams,
    };

    const trimmedEmail = emailValue.trim().toLowerCase();
    const trimmedCompany = company.trim();
    if (trimmedEmail) payload.email = trimmedEmail;
    if (trimmedCompany) payload.company = trimmedCompany;
    if (honeypotValue) payload.website = honeypotValue;

    setLoading(true);
    try {
      await apiFetch("/api/leads", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSuccess(true);
      setMessage("");
      setWebsite("");
    } catch (err: any) {
      setError(formatApiError(err, "Impossible d’envoyer votre message."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Contact"
        title="Nous contacter"
        subtitle={`Une question sur la facturation B2B, l’intégration ${integrationLabel} ou la conformité ${
          timelineRange || "2026-2027"
        } ? Notre équipe est à votre écoute.`}
      >
        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] mb-12">
          <div className="bg-white border border-slate-200 rounded-[24px] p-6 md:p-8 shadow-[0_18px_60px_rgba(15,23,42,0.08)] space-y-6">
            <div className="space-y-2">
              <h2 className="text-[22px] font-bold text-slate-900">Envoyez-nous un message</h2>
              <p className="text-[14px] text-slate-500">Partez d’un modèle puis adaptez-le à votre contexte.</p>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {MESSAGE_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="inline-flex min-h-[44px] items-center justify-center px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/70 text-[12px] font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  onClick={() => applyTemplate(template.value)}
                >
                  {template.label}
                </button>
              ))}
            </div>

            {error && (
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-red-700 text-[13px]">
                {error}
              </div>
            )}
            {success && (
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-[13px]">
                Merci, votre message est enregistré. Nous visons une première réponse sous {slaLabel}, sans engagement
                contractuel de délai.
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="contact-email" className="block text-slate-700 mb-1.5 text-[13px] font-medium">
                    Email professionnel
                  </label>
                  <input
                    id="contact-email"
                    name="email"
                    type="email"
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    placeholder="email@entreprise.com"
                    autoComplete="email"
                    value={emailValue}
                    onChange={(e) => setEmailValue(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="contact-company" className="block text-slate-700 mb-1.5 text-[13px] font-medium">
                    Société
                  </label>
                  <input
                    id="contact-company"
                    name="company"
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    placeholder="Raison sociale"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="contact-message" className="block text-slate-700 mb-1.5 text-[13px] font-medium">
                  Message
                </label>
                <textarea
                  id="contact-message"
                  name="message"
                  className="w-full min-h-[180px] px-4 py-3 border border-slate-200 rounded-[20px] text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  placeholder="Décrivez votre besoin (volumétrie, planning, contraintes)."
                  rows={8}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                />
                <p className="mt-1.5 text-[12px] text-slate-600">{remainingChars} caractères restants</p>
              </div>

              <div className="sr-only" aria-hidden="true">
                <label htmlFor="contact-website">Site web</label>
                <input
                  id="contact-website"
                  name="website"
                  type="text"
                  autoComplete="off"
                  tabIndex={-1}
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <p className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-[12px] leading-relaxed text-slate-600">
                {legalCompanyName} traite votre email, votre société et votre message pour répondre à votre demande, sur
                la base de mesures précontractuelles et de son intérêt légitime à gérer les demandes professionnelles.
                L’email et le message sont obligatoires ; la société est facultative. Durée de référence : jusqu’à 3 ans
                après le dernier contact actif. Vos droits : {privacyEmail}. Consultez la{" "}
                <Link href="/legal/privacy" className="font-semibold text-[#1d4ed8] underline underline-offset-2">
                  politique de confidentialité
                </Link>
                .
              </p>

              <button
                className="w-full md:w-auto md:min-w-[180px] py-3 px-5 bg-[#1d4ed8] text-white rounded-xl hover:bg-[#1d4ed8]/90 text-[14px] font-semibold transition-colors disabled:opacity-60"
                type="submit"
                disabled={loading}
              >
                {loading ? "Envoi..." : "Envoyer"}
              </button>
            </form>
          </div>

          <div className="space-y-5">
            <div className="bg-white border border-slate-200 rounded-[24px] p-6 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
              <h2 className="text-[16px] font-bold text-slate-900 mb-6">Coordonnées</h2>
              <div className="space-y-4 text-[14px] text-slate-600">
                {hasContactEmail && (
                  <div className="flex items-center gap-3.5">
                    <Mail className="w-4 h-4 text-[#1d4ed8]" />
                    <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
                  </div>
                )}
                {hasAddress && (
                  <div className="flex items-start gap-3.5">
                    <MapPin className="mt-0.5 w-4 h-4 text-[#1d4ed8]" />
                    <span>{address}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#1d4ed8]/5 border border-[#1d4ed8]/10 rounded-[24px] p-6 shadow-[0_12px_40px_rgba(29,78,216,0.08)]">
              <h2 className="text-[16px] font-bold text-slate-900 mb-2">Support & réponse</h2>
              <p className="text-[14px] text-slate-600 mb-4">
                Réponse initiale cible sous {slaLabel}. Fenêtre conformité couverte: {timelineRange || "2026-2027"}.
              </p>
              <div className="space-y-2 text-[13px] text-slate-600 mb-4">
                <div>
                  <span className="font-medium text-slate-800">Email support:</span>{" "}
                  {hasContactEmail ? (
                    <a href={`mailto:${contactEmail}`} className="text-[#1d4ed8] hover:underline">
                      {contactEmail}
                    </a>
                  ) : (
                    <span>{supportEmailLabel}</span>
                  )}
                </div>
                {supportHours && (
                  <div>
                    <span className="font-medium text-slate-800">Disponibilité indicative:</span> {supportHours} (
                    {supportTimezone})
                  </div>
                )}
                {privacyEmail && (
                  <div>
                    <span className="font-medium text-slate-800">RGPD / données:</span>{" "}
                    <a href={`mailto:${privacyEmail}`} className="text-[#1d4ed8] hover:underline">
                      {privacyEmail}
                    </a>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-1.5 text-[#1d4ed8] text-[14px] font-medium hover:underline"
                >
                  Voir les tarifs <ArrowRight className="w-3.5 h-3.5" />
                </Link>
                <Link
                  href="/legal/terms"
                  className="inline-flex items-center gap-1.5 text-[#1d4ed8] text-[14px] font-medium hover:underline"
                >
                  Lire les CGV/CGU <ArrowRight className="w-3.5 h-3.5" />
                </Link>
                <Link
                  href="/security"
                  className="inline-flex items-center gap-1.5 text-[#1d4ed8] text-[14px] font-medium hover:underline"
                >
                  Voir la sécurité <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
