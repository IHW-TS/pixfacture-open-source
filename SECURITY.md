# Security Policy

## Portee
- Ce depot contient un backend FastAPI, un frontend Next.js et des assets Docker.
- Les secrets ne doivent jamais etre commits. Utiliser un gestionnaire de secrets ou des variables CI, et un .env local uniquement.

## Versions prises en charge

Les correctifs de sécurité sont appliqués sur la branche `main` et, lorsqu'une
release stable est publiée, sur la dernière version stable. Les versions plus
anciennes peuvent ne plus recevoir de correctif.

## Signaler une vulnérabilité

N'ouvrez pas d'issue publique et ne publiez pas de preuve d'exploitation.
Utilisez en priorité le formulaire privé GitHub :

https://github.com/IHW-TS/pixfacture-open-source/security/advisories/new

Incluez, sans donnée client réelle :

- la version ou le commit concerné ;
- les conditions de reproduction ;
- l'impact estimé ;
- une preuve de concept minimale et expurgée lorsque c'est possible ;
- toute mesure temporaire déjà appliquée.

Le mainteneur accusera réception et coordonnera la correction et la divulgation.
Les secrets ou données personnelles ne doivent jamais être placés dans une
issue, une pull request ou un commentaire public.

## Rotation des secrets

### Stripe
1. Creer de nouvelles cles API (test/prod) dans le dashboard Stripe.
2. Creer les prices mensuels/annuels (Starter/Pro) et renseigner STRIPE_PRICE_*_MONTHLY/YEARLY.
3. Mettre a jour les variables d'environnement (CI/infra/hosts).
4. Mettre a jour le secret de webhook si applicable.
5. Revoquer les anciennes cles.

### SMTP
1. Generer un nouveau mot de passe applicatif/compte.
2. Mettre a jour SMTP_* dans le gestionnaire de secrets et redeployer.
3. Desactiver les anciennes informations d'acces.

### PISTE
1. Generer un nouveau token/cle sur le portail PISTE.
2. Mettre a jour PISTE_* dans le gestionnaire de secrets et redeployer.
3. Revoquer l'ancien token.

### SECRET_KEY
1. Generer une valeur aleatoire longue (32+ octets).
2. Mettre a jour SECRET_KEY partout et redeployer.
3. Invalider les sessions ou tokens signes si applicable.

## Checklist incident fuite de secrets
- Isoler la fuite: retirer le fichier/secret du repo et empecher la republication.
- Rotation immediate des secrets exposes (voir section ci-dessus).
- Revoquer les cles/tokens compromis au fournisseur.
- Revue de logs et audit des acces.
- Mettre a jour les protections: pre-commit gitleaks et workflow CI secret-scan.
- Si un secret a ete commite, re-ecrire l'historique git et coordonner un force push.

## Observabilite & PII
- Le frontend desactive l'envoi automatique de PII a Sentry (sendDefaultPii=false).
- Un masqueur nettoie les URLs (emails, noms, identifiants facture) avant envoi.
- Ne pas ajouter d'emails/noms dans les tags Sentry ou les breadcrumbs.
- Utiliser des identifiants internes non sensibles si un contexte utilisateur est necessaire.

## CSP (Content Security Policy)
- CSP enforcee en production via `frontend/middleware.ts`, avec nonce par requete.
- Le nonce est insere dans l'en-tete CSP et propage a Next (header de requete) pour signer les scripts inline internes; le layout reutilise `x-nonce` pour les scripts tiers.
- CSP appliquee aux pages publiques + `/app` + `/admin`; policy plus permissive pour les styles sur `/app` et `/admin`.
- Endpoint de rapport conserve: `/api/security/csp-report` via `report-uri` (logs sanitises, sans PII).
- Verif prebuild: `frontend/scripts/check-csp.mjs` echoue si `unsafe-inline` reapparait dans les directives scripts.

## IP fixe sortante (PDP)
- Les PDP exigent souvent une IP fixe pour autoriser les appels sortants.
- Declarer l'IP egress/NAT (ou le range public) a la PDP via le canal support/contractuel.
- En cas de rotation d'IP, prevenir la PDP avant le changement pour eviter un blocage.

## Journalisation des appels PDP (audit)
- Les appels sortants vers les PDP sont journalises via le logger `pdp.outbound` (event `pdp_outbound_call`).
- Champs attendus: timestamp, endpoint, tenant_id, correlation_id, status_code, latency_ms, provider, error.
- correlation_id: UUID genere par appel pour Seqino (sans PII). Le lien avec une transmission est conserve dans `transmission_events`.

## Retention 90 jours (logs)
- Les logs applicatifs doivent etre exportes vers un stockage centralise avec retention >= 90 jours.
- Loki/ELK: retention period de 90 jours (ex: 2160h) et rotation/compaction activees.
- S3/MinIO: lifecycle rule avec expiration a 90 jours pour le bucket de logs.
- La retention locale Docker ne suffit pas pour l'audit: activer un pipeline d'export (agent/sidecar).

## Extraction des logs en cas d'incident
- Filtrer par event `pdp_outbound_call`, tenant_id et correlation_id (UUID associe a la transmission Seqino).
- Exporter la fenetre temporelle impactee (JSON/CSV) depuis la stack logs.
- Conserver les exports 90 jours et les partager a la PDP si requis par le contrat.
