"use client";
import { CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection, LegalSubSection, LegalCallout } from "../components/landing/LegalPageShell";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";
import { TRIAL_DAYS } from "@/lib/billingConstants";

export const PRO_TRIAL_TERMS_VERSION = "2026-07-14";
export const HISTORICAL_STARTER_TRIAL_TERMS_VERSION = "2026-07-11";

const sections = [
  { title: "Résumé & périmètre", anchor: "resume" },
  { title: "Définitions", anchor: "definitions" },
  { title: "Objet et périmètre", anchor: "objet" },
  { title: "Accès, comptes & rôles", anchor: "acces" },
  { title: "E‑facturation (clause critique)", anchor: "efacturation" },
  { title: "Fonctionnalités", anchor: "fonctionnalites" },
  { title: "Conditions financières", anchor: "financier" },
  { title: "Durée & résiliation", anchor: "resiliation" },
  { title: "Support & maintenance", anchor: "support" },
  { title: "Réversibilité & export", anchor: "reversibilite" },
  { title: "Responsabilité", anchor: "responsabilite" },
  { title: "Propriété intellectuelle", anchor: "pi" },
  { title: "Données personnelles", anchor: "donnees" },
  { title: "Droit applicable", anchor: "droit" },
];

const definitions = [
  { term: "Service", def: "Solution SaaS de facturation, d'exports et de suivi." },
  { term: "Client", def: "Entité professionnelle (B2B) souscrivant au Service." },
  {
    term: "Utilisateur",
    def: "Personne autorisée par le Client (propriétaire, administrateur, comptable, commercial ou lecteur).",
  },
  { term: "Données Client", def: "Informations et documents saisis/importés (factures, PDF, XML, journaux)." },
  { term: "Données Personnelles", def: "Données à caractère personnel traitées via le Service." },
  { term: "Facture", def: "Document de facturation émis par le Client via le Service." },
  { term: "Factur‑X", def: "Format hybride PDF + XML conforme aux spécifications DGFiP." },
  {
    term: "Plateforme Agréée (PA)",
    def: "Tiers immatriculé par l'État pour les flux réglementaires (e‑invoicing, e‑reporting).",
  },
  {
    term: "Solution Compatible",
    def: "Logiciel pouvant être connecté à une PA selon le plan, le mandat, le contrat et la configuration technique applicables.",
  },
  {
    term: "Seqino",
    def: "Plateforme agréée partenaire pouvant traiter les flux B2B lorsque le connecteur, le contrat, le mandat et la vérification d’entreprise sont actifs.",
  },
  {
    term: "Chorus Pro / PISTE",
    def: "Canal public opéré par l’AIFE pour certains flux B2G ; il ne remplace pas une plateforme agréée pour les flux B2B.",
  },
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

export function TermsPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const company = legal.company;
  const supportEmail = company.supportEmail;
  const supportHours = legal.support.hours;
  const supportTimezone = legal.support.timezone;
  const rgpdEmail = legal.rgpdContact.email;
  const version = legal.docVersions.terms;
  const proTrialTermsActive = version === PRO_TRIAL_TERMS_VERSION;
  const historicalStarterTrialTermsActive = version === HISTORICAL_STARTER_TRIAL_TERMS_VERSION;
  // The terms version is date-based and owns its publication date. Keeping
  // this separate from the global legal date prevents a terms-only release
  // from silently changing the already-adopted DPA hash.
  const lastUpdated = formatLegalDate(version || company.legalLastUpdatedISO);
  const pdfLinks = [
    { href: legal.pdfLinks.cgu, label: "Ouvrir les CGU" },
    { href: legal.pdfLinks.cgv, label: "Ouvrir les CGV" },
  ].filter((link) => link.href);

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Document contractuel"
        title="CGV/CGU — Conditions Générales d'Utilisation et de Vente"
        subtitle="Les présentes conditions encadrent l'accès et l'usage du Service, ses fonctionnalités, ainsi que les obligations de l'Éditeur et du Client."
        version={version}
        lastUpdated={lastUpdated}
        sections={sections}
      >
        <LegalSection id="resume" title="Résumé des conditions">
          <LegalCallout type="important">
            Ce document ne constitue pas un conseil juridique, comptable ou fiscal. La conformité dépend de votre
            situation (TVA, opérations, secteurs) et des textes applicables. Les spécifications techniques évoluent (se
            référer à impots.gouv.fr).
          </LegalCallout>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-2">Éditeur</p>
            <div className="space-y-1 text-[13px] text-slate-600">
              <p>
                <strong className="text-slate-800">{company.companyName}</strong>
                {company.legalForm ? ` — ${company.legalForm}` : ""}
              </p>
              <p>
                RCS {company.rcsCity} {company.rcsNumber}
                {company.vatNumber ? ` · TVA ${company.vatNumber}` : ""}
              </p>
              <p>{company.address}</p>
              <p>
                <a href={`mailto:${company.email}`} className="text-blue-700 underline underline-offset-2">
                  {company.email}
                </a>
              </p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50">
              <p className="text-[12px] uppercase tracking-widest text-emerald-700 mb-3">Ce que nous faisons</p>
              <ul className="space-y-1.5">
                {[
                  "Facturation B2B classique (clients, devis, factures PDF) avec Starter",
                  "Exports structurés Factur‑X/CII/UBL avec Pro, selon artefact et configuration disponibles",
                  "Connecteurs Pro vers plateformes agréées selon activation, contrat, mandat et statut opérationnel",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-emerald-800">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border border-rose-200 rounded-xl p-4 bg-rose-50">
              <p className="text-[12px] uppercase tracking-widest text-rose-700 mb-3">Ce que nous ne faisons pas</p>
              <ul className="space-y-1.5">
                {[
                  "Nous ne sommes pas une PA immatriculée par l'État",
                  "Nous ne gérons pas l'immatriculation de plateforme agréée",
                  "Pas de promesse de certification/immatriculation PA",
                  "La transmission réglementaire passe par la PA choisie par le Client",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-rose-800">
                    <XCircle size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {pdfLinks.length > 0 && (
            <div className="mt-4 flex gap-3">
              {pdfLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
                >
                  {link.label} <ExternalLink size={11} />
                </a>
              ))}
            </div>
          )}
        </LegalSection>

        <LegalSection id="definitions" title="Définitions">
          <div className="space-y-3">
            {definitions.map((d, i) => (
              <div key={i} className="flex gap-3 text-[14px]">
                <span className="font-semibold text-slate-800 shrink-0 w-40">{d.term}</span>
                <span className="text-slate-600">{d.def}</span>
              </div>
            ))}
          </div>
        </LegalSection>

        <LegalSection id="objet" title="Objet et périmètre">
          <p>
            Le Service est destiné aux <strong>professionnels (B2B)</strong> souhaitant créer et gérer leurs devis et
            factures. Les fonctions d'e-facturation structurée relèvent du plan Pro et de leur configuration effective.
          </p>
          <ul className="space-y-2 pl-2 mt-3">
            <li>
              <strong>Objet</strong> : logiciel SaaS de facturation B2B ; PDF en Starter et exports Factur‑X/CII/UBL en
              Pro lorsqu'un artefact compatible et la configuration requise sont disponibles.
            </li>
            <li>
              <strong>E‑invoicing</strong> : le Service n'est pas une PA ; la transmission réglementaire passe via une
              plateforme agréée (PA) choisie par le Client, ou via un connecteur partenaire activé par l'Éditeur (mode
              sponsor, sans identifiant technique côté client).
            </li>
            <li>
              <strong>Archivage</strong> : export possible ; stockage et rétention selon configuration. La conformité
              complète dépend de votre configuration (rétention, sauvegardes, procédures) et des exigences applicables.
            </li>
          </ul>
        </LegalSection>

        <LegalSection id="acces" title="Accès au Service, compte, rôles et sécurité">
          <p>
            Le Client crée et gère ses comptes utilisateurs. Les rôles conditionnent les permissions (administration,
            comptabilité, lecture).
          </p>
          <ul className="space-y-1.5 pl-2 mt-2">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Le Client demeure responsable de la sécurité des accès, des mots de passe, et de l'activation de la double
              authentification si disponible.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Toute action réalisée via un compte autorisé est réputée réalisée par le Client.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Le Client doit notifier immédiatement l'Éditeur en cas de compromission de compte.
            </li>
          </ul>
        </LegalSection>

        <LegalSection id="efacturation" title="E‑facturation (clause critique)">
          <LegalCallout type="warning">
            Nous ne sommes pas une plateforme agréée (PA). Le Service est un logiciel de facturation et ne constitue pas
            une PA immatriculée par l'État.
          </LegalCallout>
          <div className="mt-4 space-y-3">
            <p>
              La transmission réglementaire (e‑invoicing/e‑reporting) s'effectue via une{" "}
              <strong>Plateforme Agréée</strong> choisie et contractualisée par le Client.
            </p>
            <p>
              L'Éditeur peut fournir un connecteur vers une PA activé en mode sponsor (sans identifiant technique côté
              client) et accompagner la mise en place du mandat lorsque requis.
            </p>
            <p>
              La souscription au plan Pro donne accès aux fonctionnalités et à la préparation du connecteur partenaire.
              Elle ne vaut pas acceptation automatique d'un mandat PA. La création ou le suivi d'un mandat nécessite une
              action séparée et explicite dans l'espace e-facturation. Le Client reste responsable de l'exactitude de
              ses informations d'entreprise.
            </p>
            <p>
              Pour Seqino, le Client habilité accepte séparément le mandat et poursuit la vérification d’entreprise
              (KYB) sur le service externe de la plateforme. Les échanges ne sont présentés comme actifs qu’après retour
              d’un statut opérationnel et d’un mandat actif.
            </p>
            <p>
              Le canal Chorus Pro est limité aux usages B2G éligibles. Son activation suppose notamment une
              configuration PISTE/Chorus valide et l’acceptation des conditions applicables de l’AIFE. Une disponibilité
              technique côté serveur ne constitue pas la preuve d’un dépôt réussi pour le Client.
            </p>
            <p>
              Sans connecteur disponible ou validé, le Service reste utilisable en <strong>mode export only</strong> :
              le Client transmet via sa PA ou le canal de son choix.
            </p>
            <div className="flex flex-col gap-1.5 mt-3">
              <p className="text-[12px] text-slate-600">Références officielles :</p>
              <a
                href="https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
              >
                Liste des plateformes agréées <ExternalLink size={11} />
              </a>
              <a
                href="https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
              >
                Facturation électronique et plateformes agréées <ExternalLink size={11} />
              </a>
              <a
                href="https://communaute.chorus-pro.gouv.fr/documentation/presentation-de-piste/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
              >
                Présentation officielle de PISTE / Chorus Pro <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </LegalSection>

        <LegalSection id="fonctionnalites" title="Fonctionnalités">
          <p>
            Le plan Starter permet la gestion des clients, devis et factures classiques avec export PDF, CSV et journal
            des ventes. Le plan Pro ajoute les achats, le suivi des paiements et les exports Factur‑X/CII/UBL lorsque
            l'artefact et la configuration correspondants sont disponibles.
          </p>
          <p>
            Des fonctionnalités de réception, statuts et e‑reporting peuvent être proposées selon la configuration et
            l'activation d'un connecteur PA.
          </p>
          <LegalSubSection title="Fonctionnalités beta / feature flags">
            <p>
              Certaines fonctionnalités peuvent être en version beta ou activées par des feature flags. Ces
              fonctionnalités peuvent évoluer, être limitées ou retirées. Leur usage reste optionnel et sans promesse de
              disponibilité permanente.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="financier" title="Conditions financières">
          <LegalSubSection
            title={proTrialTermsActive ? "Essai Pro" : historicalStarterTrialTermsActive ? "Essai Starter" : "Essai"}
          >
            {proTrialTermsActive ? (
              <p>
                L’inscription en libre-service ouvre un essai Pro gratuit de <strong>{TRIAL_DAYS} jours</strong>, limité
                aux brouillons et prévisualisations. Aucune émission définitive, aucun email client et aucune
                transmission réelle ne sont autorisés pendant l’essai. Celui-ci n’est soumis à aucun prélèvement et ne
                se convertit pas automatiquement en abonnement payant. Toute activation payante exige une souscription
                distincte et explicite du Client.
              </p>
            ) : historicalStarterTrialTermsActive ? (
              <p>
                L’inscription en libre-service ouvre un essai Starter gratuit de <strong>{TRIAL_DAYS} jours</strong>.
                Cet essai n’est soumis à aucun prélèvement et ne se convertit pas automatiquement en abonnement payant.
                Toute activation payante exige une souscription distincte et explicite du Client.
              </p>
            ) : (
              <LegalCallout type="warning">
                Cette version documentaire n’est pas disponible pour une nouvelle inscription.
              </LegalCallout>
            )}
            <p>
              Sans souscription à l’échéance, le compte d’essai devient inactif et les fonctions d’écriture ou
              d’émission sont verrouillées. Une inscription non vérifiée et inutilisée peut être anonymisée à J+7. Un
              essai expiré et inutilisé peut être anonymisé au plus tôt 30 jours après sa fin, uniquement en l’absence
              de donnée métier, de pièce comptable, d’activité récente, de mesure de conservation ou d’obligation
              légale.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Offre & prix">
            <p>
              Plans <strong>Starter / Pro / Volume</strong>, facturation mensuelle ou annuelle selon la grille tarifaire
              en vigueur. Les prix sont <strong>HT</strong>, taxes applicables en sus.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Facturation annuelle">
            <p>
              Lorsque le Client choisit une facturation annuelle, l'abonnement est payable d'avance pour 12 mois. Sauf
              résiliation avant l'échéance, l'abonnement se renouvelle automatiquement à la date anniversaire aux
              conditions tarifaires en vigueur.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Jetons de transmission et recharges">
            <p>
              Le plan Pro attribue 50 jetons une seule fois lors de sa première activation effective. Leur utilisation
              et l'achat ponctuel de packs ne deviennent possibles qu'avec un connecteur opérationnel, un contrat et,
              lorsque requis, un mandat actifs. Il n'existe pas de recharge mensuelle automatique.{" "}
              <strong>Aucune facturation variable automatique n'est appliquée sans accord exprès du Client.</strong>
            </p>
          </LegalSubSection>
          <LegalSubSection title="Retards de paiement">
            <p>
              Pour toute somme due à l’Éditeur par un Client professionnel et non payée à son échéance, des pénalités
              sont exigibles dès le lendemain de la date de règlement figurant sur la facture, sans rappel préalable. Le
              taux appliqué est le taux directeur de la Banque centrale européenne en vigueur au 1er janvier pour le
              premier semestre ou au 1er juillet pour le second semestre, majoré de 10 points de pourcentage, sans
              pouvoir être inférieur à trois fois le taux d’intérêt légal.
            </p>
            <p>
              Une indemnité forfaitaire de <strong>40 € par facture</strong> est également due pour frais de
              recouvrement. Lorsque les frais de recouvrement exposés sont supérieurs à ce montant, l’Éditeur peut
              demander une indemnisation complémentaire sur justification. Aucun escompte n’est accordé pour paiement
              anticipé, sauf accord écrit contraire. En cas de défaut persistant, l’accès peut être suspendu après
              notification.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="resiliation" title="Durée, renouvellement et résiliation">
          <p>
            L’essai prend effet à l’activation du compte et s’achève au terme de la période annoncée. L’abonnement
            payant prend effet à la souscription et se renouvelle tacitement par période identique. Le Client peut
            résilier avant la prochaine échéance depuis l'espace client.
          </p>
          <p>
            Les sommes dues restent exigibles pour la période en cours. En cas d'impayé ou de violation grave, l'Éditeur
            peut suspendre ou résilier l'accès.
          </p>
        </LegalSection>

        <LegalSection id="support" title="Support & maintenance">
          <p>
            Support par email (délais de traitement selon plan souscrit — aucun délai garanti en l'absence d'accord
            contractuel spécifique). Des maintenances planifiées peuvent être annoncées ; les correctifs urgents peuvent
            entraîner des interruptions limitées.
          </p>
          <p>
            <strong>Disponibilité</strong> : le Service est fourni en <strong>obligation de moyens</strong>, sans
            engagement de disponibilité ferme en l'absence de SLA spécifique. SLA éventuel selon contrat (offre Volume).
          </p>
          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-2">Support public</p>
              <div className="space-y-1.5 text-[13px] text-slate-600">
                <p>
                  <strong className="text-slate-800">Email :</strong>{" "}
                  <a href={`mailto:${supportEmail}`} className="text-blue-700 underline underline-offset-2">
                    {supportEmail}
                  </a>
                </p>
                {supportHours && (
                  <p>
                    <strong className="text-slate-800">Disponibilité indicative :</strong> {supportHours}
                    {supportTimezone ? ` (${supportTimezone})` : ""}
                  </p>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
              <p className="text-[12px] uppercase tracking-widest text-blue-700 mb-2">Cadre des engagements</p>
              <p className="text-[13px] text-slate-700">
                Le support public couvre les demandes commerciales, produit, incidents et questions de données
                personnelles. Un SLA ferme n’existe que s’il est contractualisé séparément.
              </p>
              {rgpdEmail && (
                <p className="text-[13px] text-slate-700 mt-2">
                  <strong className="text-slate-800">RGPD :</strong>{" "}
                  <a href={`mailto:${rgpdEmail}`} className="text-blue-700 underline underline-offset-2">
                    {rgpdEmail}
                  </a>
                </p>
              )}
            </div>
          </div>
        </LegalSection>

        <LegalSection id="reversibilite" title="Réversibilité & export des données">
          <p>
            Le Client peut exporter ses données (PDF, CSV, journaux et, lorsqu'ils existent, artefacts Factur‑X) pendant
            la durée du contrat. L'export complet de réversibilité peut inclure les données conservées de modules
            utilisés antérieurement, même si le plan actif n'en affiche plus les écrans. Après résiliation, une
            restitution supplémentaire peut être fournie sur demande dans un délai raisonnable (par exemple 30 jours).
          </p>
          <p>
            La conservation des données s'effectue selon les obligations légales applicables et les paramètres
            contractuels.
          </p>
        </LegalSection>

        <LegalSection id="responsabilite" title="Responsabilité & limitation">
          <p>
            Le Client demeure responsable de la qualité des données saisies, de ses paramètres (TVA, mentions, routage)
            et du choix de la plateforme agréée (PA) immatriculée par l'État.
          </p>
          <p>
            L'Éditeur ne peut être tenu responsable des indisponibilités, retards, rejets ou erreurs imputables à la PA
            tierce, au PPF ou à tout prestataire externe utilisé par le Client.
          </p>
          <p>
            Sauf dispositions d'ordre public, la responsabilité de l'Éditeur est{" "}
            <strong>limitée aux montants payés par le Client au cours des 12 derniers mois</strong>.
          </p>
        </LegalSection>

        <LegalSection id="pi" title="Propriété intellectuelle">
          <p>
            Le Service et sa documentation restent la propriété de l'Éditeur. Une licence d'utilisation{" "}
            <strong>non exclusive</strong> est accordée pendant la durée du contrat.
          </p>
          <p>
            Il est interdit de copier, modifier, rétro-concevoir ou exploiter le Service hors du cadre contractuel.
            Chaque partie s'engage à conserver confidentielles les informations non publiques reçues de l'autre partie.
          </p>
        </LegalSection>

        <LegalSection id="donnees" title="Données personnelles">
          <p>
            Le traitement des données personnelles est encadré par l'
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              accord de traitement des données (DPA)
            </a>{" "}
            et la{" "}
            <a href="/legal/privacy" className="text-blue-700 underline underline-offset-2">
              politique de confidentialité
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection id="droit" title="Droit applicable et juridiction">
          <p>
            <strong>Droit applicable</strong> : {legal.governingLaw}. <strong>Juridiction compétente</strong> :{" "}
            {legal.jurisdiction}.
          </p>
          <LegalCallout type="info">
            Les informations d'identification complètes de l'Éditeur figurent dans les{" "}
            <a href="/legal/mentions" className="underline underline-offset-2">
              mentions légales
            </a>
            .
          </LegalCallout>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap gap-4">
          <a
            href="/legal/dpa"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            DPA <ExternalLink size={11} />
          </a>
          <a
            href="/legal/privacy"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Confidentialité <ExternalLink size={11} />
          </a>
          <a
            href="/security"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Sécurité <ExternalLink size={11} />
          </a>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
