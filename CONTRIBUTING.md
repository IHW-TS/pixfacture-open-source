# Contribuer à PixFacture

Merci de votre intérêt pour PixFacture. Les corrections ciblées, améliorations
de documentation, tests et propositions liées à la facturation électronique
sont les bienvenues.

## Avant de commencer

1. Recherchez une issue ou ouvrez-en une pour décrire le besoin.
2. Gardez les changements limités à un objectif clair.
3. Ne joignez jamais de données clients, factures réelles, secrets, captures
   privées ou identifiants de production.
4. Pour une vulnérabilité, suivez [SECURITY.md](SECURITY.md) au lieu d'ouvrir
   une issue publique.

## Installation locale

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Les fichiers `.env*.example` contiennent uniquement des modèles. Placez les
valeurs réelles dans un fichier local ignoré par Git.

## Vérifications

Choisissez les contrôles correspondant à votre modification :

```bash
make check-backend
make check-frontend
make e2e-frontend
```

Les commandes détaillées sont documentées dans [README.md](README.md).

## Pull requests

- expliquez le problème, la solution et l'impact utilisateur ;
- indiquez les vérifications exécutées ;
- ajoutez ou mettez à jour les tests lorsque le comportement change ;
- conservez la compatibilité de licence des dépendances et assets ajoutés ;
- ne modifiez pas les mentions de marque pour faire croire qu'un fork est une
  version officielle.

## Licence des contributions

En proposant une contribution, vous confirmez avoir le droit de la soumettre et
acceptez qu'elle soit distribuée sous la même licence que le projet,
GNU AGPL version 3. Les droits de marque restent régis par
[TRADEMARKS.md](TRADEMARKS.md).
