"use client";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";

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

const formatLegalDate = (value: string) => {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

export function PrivacyPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const company = legal.company;
  const version = legal.docVersions.privacy;
  const lastUpdated = formatLegalDate(company.legalLastUpdatedISO);
  const retentionLabel = legal.dataRetention || "durées précisées dans le tableau ci-dessous";
  const providers = [
    { name: legal.hosting.provider, role: `Hébergement — ${legal.hosting.location}` },
    { name: legal.providers.email, role: "Emails transactionnels" },
    { name: legal.providers.payment, role: "Paiement en ligne" },
    { name: legal.providers.monitoring, role: "Monitoring applicatif" },
    { name: legal.providers.pdp, role: "Transmission e‑invoicing (si activé)" },
  ].filter((provider) => provider.name);

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Politique de confidentialité"
        subtitle="Cette politique décrit comment nous collectons, utilisons et protégeons vos données personnelles dans le cadre de la fourniture de nos services de facturation B2B."
        version={version}
        lastUpdated={lastUpdated}
        sections={sections}
      >
        <LegalSection id="responsable" title="Responsable du traitement">
          <p>
            Le Responsable du traitement est {company.companyName}, {company.legalForm}, dont le siège social est situé{" "}
            {company.address}, immatriculée au RCS de {company.rcsCity} sous le numéro {company.rcsNumber}, TVA
            intracommunautaire {company.vatNumber}.
          </p>
          <p>
            <strong>Contact</strong> : {company.email}.
          </p>
          <p>
            <strong>{legal.rgpdContact.label}</strong> : {legal.rgpdContact.email}.
          </p>
          <LegalCallout type="info">
            Pour les traitements effectués pour le compte de nos clients (sous-traitance), voir la{" "}
            <a href="/legal/dpa" className="underline underline-offset-2">
              DPA
            </a>
            .
          </LegalCallout>
        </LegalSection>

        <LegalSection id="donnees" title="Données collectées">
          <LegalTable
            headers={["Catégorie", "Types de données", "Contexte"]}
            rows={[
              [
                "Visiteurs du site",
                "Cookies essentiels, journaux techniques (IP, user-agent, pages visitées)",
                "Navigation sur le site marketing",
              ],
              [
                "Clients / prospects",
                "Identités, coordonnées, demandes de contact ou d’information, échanges commerciaux",
                "Prospect ou client en cours d'onboarding",
              ],
              [
                "Facturation",
                "Informations de facturation, transactions, historique d'abonnement",
                "Gestion de l'abonnement (Stripe)",
              ],
              [
                "Application (admin)",
                "Comptes, droits, usage, configuration et logs",
                "Utilisation de l'espace facturation",
              ],
              [
                "Documents",
                "Données de facturation (clients, fournisseurs, montants, références, XML Factur‑X)",
                "Création et gestion des factures B2B",
              ],
            ]}
          />
        </LegalSection>

        <LegalSection id="finalites" title="Finalités & bases légales">
          <LegalTable
            headers={["Finalité", "Base légale", "Notes"]}
            rows={[
              [
                "Fourniture du Service (facturation, exports, connecteurs)",
                "Exécution du contrat",
                "Obligatoire pour utiliser le Service",
              ],
              [
                "Sécurité, prévention des abus, journalisation",
                "Intérêt légitime",
                "Minimisation des données appliquée",
              ],
              ["Facturation abonnements", "Obligation légale", "Conservation fiscale/comptable applicable"],
              [
                "Cookies optionnels d'audience ou marketing",
                "Non applicable actuellement",
                "Fonctionnalités désactivées",
              ],
              ["Prospection commerciale", "Intérêt légitime (B2B)", "Opt-out disponible"],
            ]}
          />
        </LegalSection>

        <LegalSection id="cookies" title="Cookies & analytics">
          <LegalSubSection title="Cookies strictement nécessaires">
            <p>
              Authentification et sécurité : <code>access_token</code> (1 heure), <code>refresh_token</code>,{" "}
              <code>csrf_token</code> et <code>auth_session</code> (30 jours maximum). Le cookie{" "}
              <code>sidebar_state</code> conserve la préférence d’affichage pendant 7 jours. Ces cookies sont
              indispensables au fonctionnement ou à l’ergonomie du Service et sont supprimés plus tôt en cas de
              déconnexion ou de révocation lorsque cela s’applique.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Cookies de mesure d'audience">
            <p>
              Désactivée sur cette instance. Aucun service de mesure d'audience n'est chargé et aucun cookie de mesure
              d'audience n'est déposé.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Cookies marketing">
            <p>
              Désactivés sur cette instance. Aucun cookie de remarketing, de retargeting ou de publicité personnalisée
              n'est déposé. Toute activation future sera préalablement décrite dans la{" "}
              <a href="/legal/cookies" className="text-blue-700 underline underline-offset-2">
                politique cookies
              </a>
              .
            </p>
          </LegalSubSection>
          <LegalSubSection title="Gestion du consentement">
            <p>
              Aucun cookie optionnel n'étant actuellement activé, aucun bandeau ni centre de préférences n'est affiché.
              Toute activation future nécessitant un consentement sera préalablement décrite dans la{" "}
              <a href="/legal/cookies" className="text-blue-700 underline underline-offset-2">
                politique cookies
              </a>{" "}
              et accompagnée d'une interface permettant de l'accepter, de le refuser et de le retirer.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="conservation" title="Durées de conservation">
          <p>
            Données conservées pendant la relation contractuelle et la durée nécessaire aux finalités, avec des
            extensions possibles pour respecter les obligations légales applicables. Référentiel courant :{" "}
            {retentionLabel}.
          </p>
          <LegalTable
            headers={["Type de donnée", "Durée", "Obligation"]}
            rows={[
              ["Données de compte actif", "Durée du contrat", "Contractuelle"],
              [
                "Inscription d'essai non vérifiée et inutilisée",
                "7 jours après l'inscription",
                "Anonymisation automatique, hors exclusion ou obligation de conservation",
              ],
              [
                "Essai expiré et inutilisé",
                "30 jours après la fin de l'essai",
                "Anonymisation si aucune donnée métier, pièce comptable, activité récente ou obligation de conservation",
              ],
              [
                "Données métier confiées par le Client",
                "Durée du contrat, puis restitution ou suppression selon le DPA",
                "Sauf obligation légale imposant spécifiquement une conservation à l’Éditeur",
              ],
              [
                "Pièces fiscales propres à l’abonnement PixFacture",
                "6 ans minimum",
                "Obligation propre à l’Éditeur — art. L.102 B LPF",
              ],
              [
                "Documents comptables propres à l’Éditeur",
                "10 ans minimum",
                "Obligation propre à l’Éditeur — art. L.123-22 C. com.",
              ],
              ["Logs techniques", "Limités dans le temps", "Données personnelles masquées"],
              ["Données prospects", "3 ans après dernier contact actif", "Référentiel interne de prospection B2B"],
            ]}
          />
        </LegalSection>

        <LegalSection id="destinataires" title="Destinataires & sous-traitants">
          <p>
            Équipes habilitées et prestataires techniques (hébergement, email, analytics, paiement selon activation).
            Registre des sous-traitants :{" "}
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              Annexe 3 de la DPA
            </a>
            .
          </p>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {providers.map((sp, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px] bg-slate-50 rounded-lg px-3 py-2">
                <CheckCircle2 size={13} className="text-blue-600 shrink-0" />
                <span className="font-medium text-slate-700">{sp.name}</span>
                <span className="text-slate-600">— {sp.role}</span>
              </div>
            ))}
          </div>
          <LegalCallout type="info">
            Lorsque le Client active le mode connecté, les données strictement nécessaires aux flux peuvent être
            transmises à Seqino pour le B2B. Pour un dépôt B2G configuré, elles peuvent être transmises à l’AIFE via
            PISTE/Chorus Pro. Ces transmissions restent conditionnées au plan, au mandat ou à l’habilitation, au contrat
            et à la configuration applicables. La qualification juridique de l’organisme public peut différer de celle
            d’un sous-traitant ultérieur.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="transferts" title="Transferts hors UE/EEE">
          <p>
            Par défaut, les données sont hébergées via <strong>{legal.hosting.label}</strong>. Avant tout transfert hors
            UE/EEE, le pays, le destinataire et le mécanisme applicable sont vérifiés et documentés dans le contrat
            concerné. Selon le cas, ce mécanisme peut être une décision d’adéquation, le cadre UE–États-Unis ou des
            clauses contractuelles types (SCC) assorties de mesures complémentaires. La liste d’un fournisseur ne vaut
            pas preuve que ce mécanisme est déjà en vigueur.
          </p>
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
          <p className="mt-4">
            Pour exercer vos droits, contactez-nous à l'adresse {legal.rgpdContact.email}. Nous répondrons dans un délai
            d'un mois.
          </p>
        </LegalSection>

        <LegalSection id="reclamation" title="Réclamation">
          <p>
            Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la{" "}
            <strong>Commission Nationale de l'Informatique et des Libertés (CNIL)</strong> :
          </p>
          <a
            href="https://www.cnil.fr"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[14px] text-blue-700 underline underline-offset-2 mt-2"
          >
            cnil.fr <ExternalLink size={12} />
          </a>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap gap-4">
          <a
            href="/legal/dpa"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            DPA <ExternalLink size={11} />
          </a>
          <a
            href="/legal/cookies"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Politique cookies <ExternalLink size={11} />
          </a>
          <a
            href="/legal/terms"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            CGU/CGV <ExternalLink size={11} />
          </a>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
