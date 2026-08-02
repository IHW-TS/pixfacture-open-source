import { Link } from "react-router";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection, LegalCallout } from "../components/landing/LegalPageShell";
import {
  Shield,
  Mail,
  MapPin,
  CheckCircle,
  ArrowRight,
  Server,
  FileCheck,
  Globe,
  Clock,
  Zap,
  Users,
  Lock,
  Building2,
} from "lucide-react";

/* ── Contact ── */
export function ContactPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Contact"
        title="Nous contacter"
        subtitle="Une question sur la facturation B2B, la conformité Factur-X ou la réforme 2026-2027 ? Notre équipe est à votre écoute."
      >
        <div className="grid md:grid-cols-2 gap-8 mb-12">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <h3 className="text-[18px] font-bold text-slate-900">Envoyez-nous un message</h3>
            <div>
              <label className="block text-slate-700 mb-1.5 text-[13px] font-medium">Nom</label>
              <input
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[14px]"
                placeholder="Votre nom"
              />
            </div>
            <div>
              <label className="block text-slate-700 mb-1.5 text-[13px] font-medium">Email professionnel</label>
              <input
                type="email"
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[14px]"
                placeholder="email@entreprise.com"
              />
            </div>
            <div>
              <label className="block text-slate-700 mb-1.5 text-[13px] font-medium">Sujet</label>
              <select className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[14px] bg-white">
                <option>Question commerciale</option>
                <option>Support technique</option>
                <option>Conformité / Factur-X</option>
                <option>Demande de démo</option>
                <option>Partenariat</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-700 mb-1.5 text-[13px] font-medium">Message</label>
              <textarea
                rows={4}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[14px]"
                placeholder="Décrivez votre besoin..."
              />
            </div>
            <button className="w-full py-2.5 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1d4ed8]/90 text-[14px] font-semibold transition-colors">
              Envoyer
            </button>
          </div>
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h3 className="text-[16px] font-bold text-slate-900 mb-4">Coordonnées</h3>
              <div className="space-y-3 text-[14px] text-slate-600">
                <div className="flex items-center gap-3">
                  <Mail className="w-4 h-4 text-[#1d4ed8]" />
                  <span>contact@facturxpro.fr</span>
                </div>
                <div className="flex items-center gap-3">
                  <MapPin className="w-4 h-4 text-[#1d4ed8]" />
                  <span>Paris, France</span>
                </div>
              </div>
            </div>
            <div className="bg-[#1d4ed8]/5 border border-[#1d4ed8]/10 rounded-xl p-6">
              <h3 className="text-[16px] font-bold text-slate-900 mb-2">Demande de démo</h3>
              <p className="text-[14px] text-slate-600 mb-4">
                Planifiez une démo personnalisée de 30 minutes avec un expert conformité.
              </p>
              <Link
                to="/pricing"
                className="inline-flex items-center gap-1.5 text-[#1d4ed8] text-[14px] font-medium hover:underline"
              >
                Voir les tarifs <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Conformité (marketing) ── */
export function ConformiteMarketingPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Conformité"
        title="Conformité facturation B2B"
        subtitle="PixFacture vous accompagne dans la mise en conformité avec les obligations de facturation électronique en France."
      >
        <div className="space-y-8">
          <LegalSection id="facturx" title="Factur-X (EN 16931)">
            <p>
              Toutes les factures émises via PixFacture embarquent un fichier XML conforme à la norme EN 16931
              (Cross-Industry Invoice — CII), directement intégré dans le PDF/A-3b.
            </p>
            <LegalCallout type="info">
              Le profil Factur-X utilisé est le profil EN16931 (extended), compatible avec les exigences de la réforme
              française 2026-2027.
            </LegalCallout>
          </LegalSection>
          <LegalSection id="controles" title="Contrôles internes">
            <p>Avant chaque émission, PixFacture exécute des contrôles de conformité :</p>
            <ul className="list-disc ml-5 space-y-1">
              <li>Validité structurelle du XML CII</li>
              <li>Cohérence des montants (HT, TVA, TTC)</li>
              <li>Présence des mentions obligatoires FR (SIRET, TVA, pénalités de retard, indemnité 40 €)</li>
              <li>Conformité PDF/A-3b</li>
              <li>Checksums et horodatage</li>
            </ul>
          </LegalSection>
          <LegalSection id="transmission" title="Transmission réglementaire">
            <p>
              PixFacture n'est pas une plateforme agréée (PA). La transmission réglementaire passe par une plateforme
              agréée choisie et contractualisée par le client.
            </p>
            <p>
              Nous proposons un connecteur vers la plateforme partenaire Seqino pour simplifier l'envoi et le suivi des
              statuts.
            </p>
          </LegalSection>
          <LegalSection id="ereporting" title="E-reporting">
            <p>
              Le module e-reporting permet de consolider les opérations B2C, internationales et les paiements selon les
              périodicités définies par l'administration fiscale.
            </p>
          </LegalSection>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Conformité 2026 ── */
export function Conformite2026Page() {
  const milestones = [
    {
      date: "1er sept. 2026",
      title: "Réception obligatoire",
      desc: "Toutes les entreprises assujetties à la TVA doivent pouvoir recevoir des factures électroniques.",
    },
    {
      date: "1er sept. 2026",
      title: "Émission — Grandes entreprises",
      desc: "Obligation d'émettre pour les grandes entreprises et ETI.",
    },
    {
      date: "1er sept. 2027",
      title: "Émission — PME & TPE",
      desc: "Obligation d'émettre étendue aux PME et micro-entreprises.",
    },
  ];
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Réforme 2026"
        title="Réforme de la facturation électronique 2026-2027"
        subtitle="Calendrier, obligations et préparation : tout ce que les TPE/PME doivent savoir."
        lastUpdated="Mars 2026"
      >
        <div className="space-y-8">
          <LegalSection id="calendrier" title="Calendrier officiel">
            <div className="space-y-4">
              {milestones.map((m, i) => (
                <div key={i} className="flex gap-4 p-4 bg-white border border-slate-200 rounded-xl">
                  <div className="flex-shrink-0 w-24 text-center">
                    <div className="text-[#1d4ed8] text-[13px] font-bold">{m.date}</div>
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-slate-900">{m.title}</div>
                    <p className="text-[14px] text-slate-600 mt-0.5">{m.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </LegalSection>
          <LegalSection id="obligations" title="Ce qui change pour votre entreprise">
            <ul className="list-disc ml-5 space-y-2">
              <li>
                Toutes les factures B2B domestiques (France) doivent être transmises sous forme électronique structurée.
              </li>
              <li>Le format Factur-X (PDF + XML CII) est l'un des trois formats acceptés (avec UBL et CII pur).</li>
              <li>Les opérations B2C, internationales et les paiements sont soumises à l'e-reporting.</li>
              <li>
                La transmission passe obligatoirement par une plateforme agréée (PA) ou le portail public de facturation
                (PPF).
              </li>
            </ul>
          </LegalSection>
          <LegalSection id="preparation" title="Comment se préparer avec PixFacture">
            <div className="grid md:grid-cols-3 gap-4">
              {[
                { icon: Building2, title: "Profil entreprise", desc: "SIRET, TVA, adresse, mentions légales" },
                { icon: Server, title: "Plateforme partenaire", desc: "Connecteur Seqino intégré" },
                { icon: FileCheck, title: "Conformité automatique", desc: "Contrôles CII + PDF/A-3b" },
              ].map((c, i) => (
                <div key={i} className="p-4 bg-white border border-slate-200 rounded-xl">
                  <c.icon className="w-5 h-5 text-[#1d4ed8] mb-2" />
                  <div className="text-[14px] font-semibold text-slate-900">{c.title}</div>
                  <p className="text-[13px] text-slate-500 mt-0.5">{c.desc}</p>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Link
                to="/app/setup/einvoicing"
                className="inline-flex items-center gap-1.5 text-[#1d4ed8] text-[14px] font-medium hover:underline"
              >
                Ouvrir la checklist e-invoicing <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </LegalSection>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Compatibilité e-invoicing ── */
export function CompatibiliteEinvoicingPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Compatibilité"
        title="Compatibilité e-invoicing"
        subtitle="Mode export disponible selon le plan. Seqino et Chorus Pro restent non activés tant que leur raccordement n’est pas contractualisé, configuré et validé."
      >
        <div className="space-y-8">
          <LegalSection id="formats" title="Formats supportés">
            <div className="grid md:grid-cols-3 gap-4">
              {[
                {
                  title: "Factur-X / ZUGFeRD",
                  desc: "PDF/A-3b + XML CII (EN 16931). Format mixte lisible et structuré.",
                },
                { title: "CII (Cross-Industry Invoice)", desc: "XML pur conforme EN 16931 selon configuration." },
                {
                  title: "UBL (Universal Business Language)",
                  desc: "Support en option pour les échanges internationaux.",
                },
              ].map((f, i) => (
                <div key={i} className="p-4 bg-white border border-slate-200 rounded-xl">
                  <div className="text-[14px] font-semibold text-slate-900 mb-1">{f.title}</div>
                  <p className="text-[13px] text-slate-500">{f.desc}</p>
                </div>
              ))}
            </div>
          </LegalSection>
          <LegalSection id="plateformes" title="Plateformes partenaires">
            <p>
              PixFacture prépare les formats en mode export. Cette page ne signifie pas qu’un raccordement Seqino ou
              Chorus Pro est actif pour votre compte.
            </p>
            <ul className="list-disc ml-5 space-y-1">
              <li>Seqino : non activé par défaut ; contrat, mandat, configuration et validation requis</li>
              <li>Chorus Pro B2G : non activé par défaut ; raccordement et qualification requis</li>
              <li>Sans activation confirmée, les documents sont préparés et exportés sans transmission distante</li>
            </ul>
          </LegalSection>
          <LegalSection id="normes" title="Normes et références">
            <ul className="list-disc ml-5 space-y-1">
              <li>EN 16931 — European standard for electronic invoicing</li>
              <li>Factur-X 1.08 / ZUGFeRD 2.3</li>
              <li>PDF/A-3b (ISO 19005-3)</li>
              <li>UN/CEFACT CII D16B</li>
              <li>OASIS UBL 2.1</li>
            </ul>
          </LegalSection>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Plateformes ── */
export function PlateformesPage() {
  const platforms: {
    name: string;
    type: string;
    status: string;
    desc: string;
    color: "ok" | "warn" | "muted";
  }[] = [
    {
      name: "Plateforme partenaire",
      type: "PA",
      status: "Selon configuration",
      desc: "Transmission, réception et statuts disponibles selon plan, mandat, contrat PA et configuration.",
      color: "muted" as const,
    },
    {
      name: "Chorus Pro",
      type: "B2G",
      status: "Connectable",
      desc: "Factures vers le secteur public français si le canal est configuré.",
      color: "warn" as const,
    },
    {
      name: "Connecteur HTTP",
      type: "Générique",
      status: "Configurable",
      desc: "Connecteur activable selon contrat et faisabilité technique.",
      color: "muted" as const,
    },
  ];
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Écosystème"
        title="Plateformes et connecteurs"
        subtitle="PixFacture s'intègre aux plateformes agréées (PA) pour la transmission réglementaire."
      >
        <div className="space-y-8">
          <LegalSection id="partenaires" title="Plateformes supportées">
            <div className="space-y-4">
              {platforms.map((p, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-3 p-5 bg-white border border-slate-200 rounded-xl sm:flex-row sm:items-start sm:gap-4"
                >
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${p.color === "ok" ? "bg-[#059669]/10" : p.color === "warn" ? "bg-[#d97706]/10" : "bg-gray-100"}`}
                  >
                    <Globe
                      className={`w-5 h-5 ${p.color === "ok" ? "text-[#059669]" : p.color === "warn" ? "text-[#d97706]" : "text-gray-500"}`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-semibold text-slate-900">{p.name}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium">
                        {p.type}
                      </span>
                    </div>
                    <p className="text-[13px] text-slate-600 mt-0.5">{p.desc}</p>
                  </div>
                  <span
                    className={`max-w-full self-start whitespace-normal text-[11px] font-semibold px-2 py-0.5 rounded-full sm:whitespace-nowrap ${p.color === "ok" ? "bg-[#059669]/10 text-[#059669]" : p.color === "warn" ? "bg-[#d97706]/10 text-[#d97706]" : "bg-gray-100 text-gray-500"}`}
                  >
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
          </LegalSection>
          <LegalCallout type="info">
            PixFacture n'est pas une plateforme agréée (PA). La transmission réglementaire passe par une plateforme
            agréée choisie et contractualisée par le client.
          </LegalCallout>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Trust ── */
export function TrustPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Confiance"
        title="Confiance et transparence"
        subtitle="Mesures documentées en matière de sécurité et de protection des données, selon la configuration et les engagements contractuels applicables."
      >
        <div className="space-y-8">
          <LegalSection id="securite" title="Sécurité">
            <div className="grid md:grid-cols-2 gap-4">
              {[
                {
                  icon: Lock,
                  title: "Chiffrement",
                  desc: "TLS en transit et chiffrement au repos selon l’instance configurée",
                },
                {
                  icon: Shield,
                  title: "Authentification",
                  desc: "Double authentification, sessions sécurisées, protection anti-falsification",
                },
                {
                  icon: Server,
                  title: "Hébergement",
                  desc: "Localisation et mesures d’exploitation selon l’instance configurée",
                },
                {
                  icon: FileCheck,
                  title: "Audit",
                  desc: "Journal d’actions horodaté ; immutabilité selon la configuration vérifiée",
                },
              ].map((c, i) => (
                <div key={i} className="p-4 bg-white border border-slate-200 rounded-xl flex items-start gap-3">
                  <c.icon className="w-5 h-5 text-[#1d4ed8] flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[14px] font-semibold text-slate-900">{c.title}</div>
                    <p className="text-[13px] text-slate-500">{c.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </LegalSection>
          <LegalSection id="rgpd" title="RGPD et données personnelles">
            <p>
              PixFacture met à disposition un DPA (Data Processing Agreement) qui décrit les rôles et les mesures
              techniques et organisationnelles prévues. La conformité RGPD effective dépend aussi de vos usages, de
              votre paramétrage, de vos obligations de responsable de traitement et des contrats applicables ; cette
              page ne constitue ni un audit ni une certification de conformité.
            </p>
            <div className="flex gap-3 mt-3">
              <Link to="/legal/dpa" className="text-[#1d4ed8] text-[14px] hover:underline">
                Consulter le DPA
              </Link>
              <Link to="/legal/privacy" className="text-[#1d4ed8] text-[14px] hover:underline">
                Politique de confidentialité
              </Link>
            </div>
          </LegalSection>
          <LegalSection id="sla" title="Disponibilité (SLA)">
            <p>Nous nous engageons sur un taux de disponibilité de 99,9 % pour l'infrastructure de production.</p>
            <Link to="/legal/sla" className="text-[#1d4ed8] text-[14px] hover:underline">
              Consulter le SLA
            </Link>
          </LegalSection>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Billing Success / Cancel ── */
export function BillingSuccessPage() {
  return (
    <LegalLayout>
      <div className="max-w-lg mx-auto px-6 py-20 text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-[#059669]/10 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-[#059669]" />
        </div>
        <h1 className="text-[28px] font-bold text-slate-900 mb-3">Paiement confirmé</h1>
        <p className="text-[16px] text-slate-500 mb-8">
          Votre abonnement est maintenant actif. Vous pouvez commencer à utiliser toutes les fonctionnalités de votre
          plan.
        </p>
        <Link
          to="/app/dashboard"
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1d4ed8]/90 text-[14px] font-semibold transition-colors"
        >
          Accéder à mon espace <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </LegalLayout>
  );
}

export function BillingCancelPage() {
  return (
    <LegalLayout>
      <div className="max-w-lg mx-auto px-6 py-20 text-center">
        <h1 className="text-[28px] font-bold text-slate-900 mb-3">Paiement annulé</h1>
        <p className="text-[16px] text-slate-500 mb-8">
          Le paiement n'a pas été finalisé. Vous pouvez réessayer à tout moment depuis votre espace.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            to="/app/billing"
            className="px-6 py-3 bg-[#1d4ed8] text-white rounded-lg hover:bg-[#1d4ed8]/90 text-[14px] font-semibold transition-colors"
          >
            Réessayer
          </Link>
          <Link
            to="/app/dashboard"
            className="px-6 py-3 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 text-[14px] font-medium transition-colors"
          >
            Tableau de bord
          </Link>
        </div>
      </div>
    </LegalLayout>
  );
}

/* ── Legal: Einvoicing Scope ── */
export function EinvoicingScopePage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Périmètre"
        title="Périmètre e-invoicing"
        subtitle="Ce que couvre — et ne couvre pas — PixFacture en matière de facturation électronique réglementaire."
        version="1.0"
        lastUpdated="Mars 2026"
        sections={[
          { title: "Ce que nous faisons", anchor: "inclus" },
          { title: "Ce que nous ne faisons pas", anchor: "exclus" },
          { title: "Responsabilités", anchor: "responsabilites" },
        ]}
      >
        <LegalSection id="inclus" title="Ce que nous faisons">
          <ul className="list-disc ml-5 space-y-2">
            <li>Génération de factures conformes Factur-X 1.08 (PDF/A-3b + XML CII EN 16931)</li>
            <li>Contrôles internes de conformité (structure XML, montants, mentions FR)</li>
            <li>Connecteur vers plateforme partenaire Seqino (envoi + réception + statuts)</li>
            <li>Module e-reporting (B2C, international, paiements)</li>
            <li>Archivage et horodatage des factures</li>
            <li>Export FEC, CSV, EDI (UBL/CII)</li>
          </ul>
        </LegalSection>
        <LegalSection id="exclus" title="Ce que nous ne faisons pas">
          <LegalCallout type="important">
            PixFacture n'est pas une plateforme agréée (PA) au sens de l'article 290 B du CGI. Nous ne transmettons pas
            directement les factures à l'administration fiscale.
          </LegalCallout>
          <ul className="list-disc ml-5 space-y-2 mt-4">
            <li>Nous ne sommes pas responsables de la transmission réglementaire</li>
            <li>Nous ne certifions pas les factures au sens fiscal</li>
            <li>Nous ne garantissons pas l'acceptation par le destinataire</li>
          </ul>
        </LegalSection>
        <LegalSection id="responsabilites" title="Partage des responsabilités">
          <p>
            L'entreprise utilisatrice reste responsable de la véracité des informations saisies, du choix et de la
            contractualisation avec une plateforme agréée, et du respect des délais de transmission.
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}

/* ── Legal: SLA ── */
export function SlaPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="SLA"
        title="Accord de niveau de service (SLA)"
        subtitle="Engagements de disponibilité, performance et support pour les utilisateurs de PixFacture."
        version="1.0"
        lastUpdated="Mars 2026"
        sections={[
          { title: "Disponibilité", anchor: "disponibilite" },
          { title: "Temps de réponse", anchor: "temps-reponse" },
          { title: "Maintenance", anchor: "maintenance" },
          { title: "Exclusions", anchor: "exclusions" },
        ]}
      >
        <LegalSection id="disponibilite" title="Disponibilité">
          <p>
            PixFacture s'engage sur un taux de disponibilité mensuel de 99,9 % pour l'infrastructure de production, hors
            maintenance planifiée.
          </p>
          <div className="grid grid-cols-3 gap-4 mt-4">
            {[
              { label: "Disponibilité cible", value: "99,9 %" },
              { label: "Temps d'arrêt max / mois", value: "43 min" },
              { label: "Monitoring", value: "24/7" },
            ].map((s, i) => (
              <div key={i} className="p-3 bg-white border border-slate-200 rounded-lg text-center">
                <div className="text-[20px] font-bold text-slate-900">{s.value}</div>
                <div className="text-[12px] text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </LegalSection>
        <LegalSection id="temps-reponse" title="Temps de réponse support">
          <div className="grid md:grid-cols-3 gap-4">
            {[
              {
                severity: "Critique (P1)",
                response: "< 1h",
                resolution: "< 4h",
                desc: "Service totalement indisponible",
              },
              { severity: "Majeur (P2)", response: "< 4h", resolution: "< 24h", desc: "Fonctionnalité clé dégradée" },
              { severity: "Mineur (P3)", response: "< 24h", resolution: "< 5 jours", desc: "Impact limité" },
            ].map((s, i) => (
              <div key={i} className="p-4 bg-white border border-slate-200 rounded-xl">
                <div className="text-[14px] font-semibold text-slate-900 mb-2">{s.severity}</div>
                <div className="text-[13px] text-slate-500 mb-2">{s.desc}</div>
                <div className="text-[12px] space-y-1">
                  <div>
                    <span className="text-slate-400">Réponse :</span>{" "}
                    <span className="text-slate-700 font-medium">{s.response}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Résolution :</span>{" "}
                    <span className="text-slate-700 font-medium">{s.resolution}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </LegalSection>
        <LegalSection id="maintenance" title="Maintenance planifiée">
          <p>
            Les maintenances planifiées sont annoncées au moins 48 heures à l'avance par email et via le tableau de
            bord. Elles sont programmées en dehors des heures ouvrées (22h–6h, heure de Paris).
          </p>
        </LegalSection>
        <LegalSection id="exclusions" title="Exclusions">
          <ul className="list-disc ml-5 space-y-1">
            <li>Indisponibilité liée à un prestataire tiers (Stripe, plateforme agréée, hébergeur)</li>
            <li>Force majeure</li>
            <li>Mauvaise utilisation ou configuration par le client</li>
            <li>Maintenance planifiée notifiée à l'avance</li>
          </ul>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}
