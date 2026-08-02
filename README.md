# PixFacture

[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/backend-Python%203.12-3776AB.svg)](backend/)
[![Next.js](https://img.shields.io/badge/frontend-Next.js%2015-black.svg)](frontend/)

PixFacture est une application open source et auto-hébergeable de facturation
pour les TPE et PME. Elle réunit la gestion des clients, devis, factures,
avoirs et paiements, ainsi que la génération de documents Factur-X.

## Contenu de l'édition publique

Ce dépôt est un instantané public nettoyé du projet. Il contient le code de
l'application, les migrations, des tests frontend, les modèles de configuration
et les fichiers nécessaires au développement local.

Les documents juridiques adoptés ou signés, registres RGPD, contrats, audits
internes, données clients, preuves d'exploitation, configurations de production
et anciennes pull requests restent exclusivement dans le dépôt privé. Les pages
légales présentes dans le code sont des modèles génériques à configurer par
l'exploitant ; elles ne constituent pas les documents juridiques internes.

## Fonctionnalités principales

- clients, devis, factures et avoirs ;
- génération PDF et Factur-X ;
- suivi des statuts, relances et envois d'e-mails ;
- rôles, journal d'audit et isolation des espaces ;
- paiements et abonnements configurables ;
- connecteurs de facturation électronique activables selon l'environnement ;
- déploiement local avec Docker Compose.

## Architecture

```text
Navigateur
   └── frontend/   Next.js 15 et TypeScript
           └── API HTTP /api
                   └── backend/   FastAPI et Python 3.12
                           ├── PostgreSQL / Alembic
                           ├── Redis
                           └── stockage local ou S3 compatible
```

## Installation locale

Prérequis : Docker et Docker Compose.

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Les fichiers `.env*.example` sont des modèles. Ne commitez jamais vos vraies
clés, mots de passe, factures ou données clients.

Pour une distribution modifiée, configurez l'adresse du code source
correspondant à la version déployée :

```env
NEXT_PUBLIC_SOURCE_CODE_URL=https://github.com/votre-organisation/votre-fork
```

## Démonstration

La démonstration locale doit utiliser uniquement des données synthétiques. Un
jeu de données de développement peut être généré depuis le backend :

```bash
cd backend
python -m scripts.seed_demo_data
```

Ne publiez aucune capture provenant d'un environnement client ou de production.

## Vérifications frontend

Le frontend exige Node.js 24.

```bash
cd frontend
npm ci
npm run check:active-sources
npm run lint
npm run typecheck
npm run test:unit
```

## Roadmap et contributions

Les corrections, tests, améliorations d'accessibilité et propositions liées à
la facturation sont les bienvenus. Utilisez les issues GitHub pour discuter des
évolutions et consultez [CONTRIBUTING.md](CONTRIBUTING.md) avant une pull request.
Ne publiez jamais d'information contractuelle ou juridique interne dans une
issue ou une contribution.

Les vulnérabilités doivent être signalées selon [SECURITY.md](SECURITY.md).

## Licence et marque

Le code est distribué sous [GNU AGPL version 3](LICENSE). Toute version modifiée
utilisée pour fournir un service via un réseau doit proposer son code source
correspondant selon les conditions de cette licence.

La licence du code n'accorde aucun droit sur le nom, le logo ou l'identité
visuelle PixFacture. Voir [TRADEMARKS.md](TRADEMARKS.md).
