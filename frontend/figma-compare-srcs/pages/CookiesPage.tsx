import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";

const sections = [
  { title: "Qu'est-ce qu'un cookie ?", anchor: "definition" },
  { title: "Cookies strictement nécessaires", anchor: "necessaires" },
  { title: "Cookies de mesure d'audience", anchor: "audience" },
  { title: "Cookies marketing", anchor: "marketing" },
  { title: "Durée de conservation", anchor: "duree" },
  { title: "Gestion du consentement", anchor: "consentement" },
];

export function CookiesPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Politique cookies"
        subtitle="Cette page décrit les cookies utilisés sur le site et l'application, leur finalité et la manière dont vous pouvez gérer vos préférences."
        version="À compléter"
        lastUpdated="À compléter"
        sections={sections}
      >
        <LegalSection id="definition" title="Qu'est-ce qu'un cookie ?">
          <p>
            Un cookie est un petit fichier texte déposé sur votre terminal (ordinateur, tablette, smartphone) lors de la
            consultation d'un service en ligne. Il permet d'assurer le fonctionnement et la sécurité du service et, le
            cas échéant, de mesurer l'audience ou proposer des contenus marketing.
          </p>
          <p>
            L'éditeur s'engage à mettre à jour cette page en cas de changement majeur dans l'utilisation des cookies.
          </p>
        </LegalSection>

        <LegalSection id="necessaires" title="Cookies strictement nécessaires">
          <p>
            Ces cookies sont indispensables au fonctionnement du service. Ils ne peuvent pas être désactivés sans
            affecter l'utilisation du site.
          </p>
          <LegalTable
            headers={["Cookie", "Finalité", "Durée"]}
            rows={[
              ["session", "Maintien de la session utilisateur authentifiée", "Durée de la session"],
              ["access_token", "Token d'accès à l'API (HttpOnly — non accessible depuis JS)", "Durée de la session"],
              ["refresh_token", "Renouvellement automatique de la session (HttpOnly)", "Selon configuration"],
              ["csrf_token", "Protection anti-falsification des requêtes", "Durée de la session"],
            ]}
          />
          <LegalCallout type="info">
            Ces cookies sont définis avec le flag <strong>HttpOnly</strong>, ce qui signifie qu'ils sont inaccessibles
            depuis JavaScript. Ils assurent l'authentification et la sécurité de votre session.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="audience" title="Cookies de mesure d'audience">
          <LegalSubSection title="Statut">
            <p>
              <strong>Non utilisée par défaut.</strong> Si une mesure d'audience est activée sur cette instance, elle
              sera soumise au consentement préalable de l'utilisateur lorsque requis par la réglementation applicable.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Si activée">
            <LegalTable
              headers={["Cookie", "Finalité", "Durée"]}
              rows={[
                ["_analytics", "Mesure de l'audience et du comportement de navigation (anonymisé)", "13 mois maximum"],
              ]}
            />
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="marketing" title="Cookies marketing">
          <p>
            <strong>Non utilisés par défaut.</strong> Si des cookies marketing sont activés dans le futur, ils seront
            listés ici et soumis au consentement préalable de l'utilisateur.
          </p>
          <LegalCallout type="info">
            Actuellement, aucun cookie de remarketing, de retargeting ou de publicité personnalisée n'est déposé sur ce
            site.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="duree" title="Durée de conservation">
          <LegalTable
            headers={["Type", "Durée maximale"]}
            rows={[
              ["Cookies de session (nécessaires)", "Fin de la session navigateur"],
              ["Cookies d'authentification (nécessaires)", "Selon paramétrage (ex. 7 jours avec refresh)"],
              ["Cookies d'audience (si activés)", "13 mois"],
              ["Cookies marketing (si activés)", "13 mois maximum (CNIL)"],
            ]}
          />
        </LegalSection>

        <LegalSection id="consentement" title="Gestion du consentement">
          <p>
            Si des cookies optionnels (audience/marketing) sont activés sur cette instance, un bandeau de consentement
            sera affiché. Vous pouvez modifier vos choix à tout moment.
          </p>
          <p>
            Pour les cookies strictement nécessaires, aucun consentement n'est requis car ils sont indispensables au
            fonctionnement du service.
          </p>
          <p className="mt-3">
            Pour toute question sur la gestion de vos données, consultez notre{" "}
            <a href="/legal/privacy" className="text-blue-700 underline underline-offset-2">
              Politique de confidentialité
            </a>{" "}
            ou{" "}
            <a href="/contact" className="text-blue-700 underline underline-offset-2">
              contactez-nous
            </a>
            .
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}
