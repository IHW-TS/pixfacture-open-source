import { CheckCircle2, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection, LegalSubSection, LegalCallout, LegalTable } from "../components/landing/LegalPageShell";

const sections = [
  { title: "Responsable du traitement", anchor: "responsable" },
  { title: "Données collectées", anchor: "donnees" },
  { title: "Finalités & bases légales", anchor: "finalites" },
  { title: "Cookies & analytics", anchor: "cookies" },
  { title: "Durées de conservation", anchor: "conservation" },
  { title: "Destinataires & sous-traitants", anchor: "destinataires" },
  { title: "Transferts hors UE/EEE", anchor: "transferts" },
  { title: "Vos droits", anchor: "droits" },
  { title: "Réclamation", anchor: "reclamation" },
];

export function PrivacyPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Politique de confidentialité"
        subtitle="Cette politique décrit comment nous collectons, utilisons et protégeons vos données personnelles dans le cadre de la fourniture de nos services de facturation B2B."
        version="À compléter"
        lastUpdated="À compléter"
        sections={sections}
      >
        <LegalSection id="responsable" title="Responsable du traitement">
          <p>Le Responsable du traitement est l'Éditeur du logiciel de facturation B2B (informations légales complètes à compléter — raison sociale, adresse, RCS, TVA).</p>
          <p><strong>Contact</strong> : adresse email légale à compléter.</p>
          <p><strong>DPO / Contact RGPD</strong> : non communiqué publiquement — contactez le support pour toute demande relative aux données personnelles.</p>
          <LegalCallout type="info">
            Pour les traitements effectués pour le compte de nos clients (sous-traitance), voir la <a href="/legal/dpa" className="underline underline-offset-2">DPA</a>.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="donnees" title="Données collectées">
          <LegalTable
            headers={["Catégorie", "Types de données", "Contexte"]}
            rows={[
              ["Visiteurs du site", "Cookies essentiels, journaux techniques (IP, user-agent, pages visitées)", "Navigation sur le site marketing"],
              ["Clients / prospects", "Identités, coordonnées, demandes de démo, échanges commerciaux", "Prospect ou client en cours d'onboarding"],
              ["Facturation", "Informations de facturation, transactions, historique d'abonnement", "Gestion de l'abonnement (Stripe)"],
              ["Application (admin)", "Comptes, droits, usage, configuration et logs", "Utilisation de l'espace facturation"],
              ["Documents", "Données de facturation (clients, fournisseurs, montants, références, XML Factur‑X)", "Création et gestion des factures B2B"],
            ]}
          />
        </LegalSection>

        <LegalSection id="finalites" title="Finalités & bases légales">
          <LegalTable
            headers={["Finalité", "Base légale", "Notes"]}
            rows={[
              ["Fourniture du Service (facturation, exports, connecteurs)", "Exécution du contrat", "Obligatoire pour utiliser le Service"],
              ["Sécurité, prévention des abus, journalisation", "Intérêt légitime", "Minimisation des données appliquée"],
              ["Facturation abonnements", "Obligation légale", "Conservation fiscale/comptable applicable"],
              ["Cookies/analytics", "Consentement", "Soumis au bandeau de consentement si activé"],
              ["Prospection commerciale", "Intérêt légitime (B2B)", "Opt-out disponible"],
            ]}
          />
        </LegalSection>

        <LegalSection id="cookies" title="Cookies & analytics">
          <LegalSubSection title="Cookies strictement nécessaires">
            <p>Authentification et sécurité (session, access_token, refresh_token, csrf_token). Ces cookies sont indispensables au fonctionnement du Service. Durée : durée de la session.</p>
          </LegalSubSection>
          <LegalSubSection title="Cookies de mesure d'audience">
            <p>Non utilisée par défaut. Si une mesure d'audience est activée, elle est soumise au consentement lorsque requis. Durée : 13 mois maximum.</p>
          </LegalSubSection>
          <LegalSubSection title="Cookies marketing">
            <p>Non utilisés par défaut. Si des cookies marketing sont activés, ils seront listés dans la <a href="/legal/cookies" className="text-blue-700 underline underline-offset-2">politique cookies</a>.</p>
          </LegalSubSection>
          <LegalSubSection title="Gestion du consentement">
            <p>Si un bandeau de consentement est déployé sur cette instance, vous pouvez modifier vos choix à tout moment via la <a href="/legal/cookies" className="text-blue-700 underline underline-offset-2">politique cookies</a>.</p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="conservation" title="Durées de conservation">
          <p>Données conservées pendant la relation contractuelle et la durée nécessaire aux finalités, avec des extensions possibles pour respecter les obligations légales applicables.</p>
          <LegalTable
            headers={["Type de donnée", "Durée", "Obligation"]}
            rows={[
              ["Données de compte actif", "Durée du contrat", "Contractuelle"],
              ["Factures et documents", "6 ans min. (fiscal)", "Art. L.102 B LPF"],
              ["Documents comptables", "10 ans min.", "Art. L.123-22 C.com."],
              ["Logs techniques", "Limités dans le temps", "Données personnelles masquées"],
              ["Données analytics", "13 mois max.", "CNIL recommandation"],
              ["Données prospects", "3 ans après dernier contact", "Délai légal RGPD B2B"],
            ]}
          />
        </LegalSection>

        <LegalSection id="destinataires" title="Destinataires & sous-traitants">
          <p>Équipes habilitées et prestataires techniques (hébergement, email, analytics, paiement selon activation). Registre des sous-traitants : <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">Annexe 3 de la DPA</a>.</p>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {[
              { name: "Hébergeur de l'instance", role: "Hébergement — France (UE)" },
              { name: "Mailgun (Twilio)", role: "Emails transactionnels" },
              { name: "Stripe", role: "Paiement en ligne" },
              { name: "Sentry", role: "Monitoring applicatif" },
              { name: "Seqino", role: "Transmission e‑invoicing (si activé)" },
            ].map((sp, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px] bg-slate-50 rounded-lg px-3 py-2">
                <CheckCircle2 size={13} className="text-blue-600 shrink-0" />
                <span className="font-medium text-slate-700">{sp.name}</span>
                <span className="text-slate-400">— {sp.role}</span>
              </div>
            ))}
          </div>
        </LegalSection>

        <LegalSection id="transferts" title="Transferts hors UE/EEE">
          <p>Par défaut, les données sont hébergées via <strong>l'hébergeur UE/EEE configuré pour l'instance</strong>. En cas de transfert hors UE/EEE (ex. certains sous-traitants), des garanties appropriées sont mises en place (clauses contractuelles types — SCC).</p>
        </LegalSection>

        <LegalSection id="droits" title="Vos droits">
          <p>Conformément au RGPD, vous disposez des droits suivants sur vos données personnelles :</p>
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            {[
              { droit: "Accès", desc: "Obtenir une copie de vos données" },
              { droit: "Rectification", desc: "Corriger des données inexactes" },
              { droit: "Suppression", desc: "Effacer vos données (droit à l'oubli)" },
              { droit: "Opposition", desc: "Vous opposer à certains traitements" },
              { droit: "Limitation", desc: "Restreindre l'utilisation de vos données" },
              { droit: "Portabilité", desc: "Récupérer vos données dans un format structuré" },
            ].map((d, i) => (
              <div key={i} className="flex items-start gap-2 bg-blue-50 rounded-lg px-3 py-2.5">
                <CheckCircle2 size={13} className="text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-[13px] font-semibold text-blue-800">{d.droit}</p>
                  <p className="text-[12px] text-blue-600">{d.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4">Pour exercer vos droits, contactez-nous via le support (email légal à compléter). Nous répondrons dans un délai d'un mois.</p>
        </LegalSection>

        <LegalSection id="reclamation" title="Réclamation">
          <p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la <strong>Commission Nationale de l'Informatique et des Libertés (CNIL)</strong> :</p>
          <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[14px] text-blue-700 underline underline-offset-2 mt-2">
            cnil.fr <ExternalLink size={12} />
          </a>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap gap-4">
          <a href="/legal/dpa" className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2">DPA <ExternalLink size={11} /></a>
          <a href="/legal/cookies" className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2">Politique cookies <ExternalLink size={11} /></a>
          <a href="/legal/terms" className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2">CGU/CGV <ExternalLink size={11} /></a>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
