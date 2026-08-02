"""
Seed relançable pour smoke tests manuels.

Exemples :
    cd backend
    python3 -m scripts.seed_smoke_data --reset --with-demo-data --password 'CHANGE_ME'
    python3 -m scripts.seed_smoke_data --reset --with-demo-data --with-connectors --password 'CHANGE_ME' --json
"""

from __future__ import annotations

import argparse
import json
import sys

from app.db import SessionLocal
from app.services.smoke_seed import seed_smoke_tenants


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed_smoke_data",
        description="Crée les tenants smoke Starter/Pro + wallets jetons pour les tests manuels.",
    )
    parser.add_argument("--reset", action="store_true", help="Réinitialise les wallets/connecteurs des tenants smoke avant de reseeder.")
    parser.add_argument("--with-demo-data", action="store_true", help="Ajoute des clients/devis/factures de démonstration aux tenants smoke.")
    parser.add_argument("--with-connectors", action="store_true", help="Crée aussi un tenant Pro avec connexions Chorus/Seqino marquées configurées si l'environnement le permet.")
    parser.add_argument(
        "--email-domain",
        default="example.com",
        help="Domaine email de test (par défaut: example.com).",
    )
    parser.add_argument("--password", default="", help="Mot de passe partagé pour tous les comptes smoke. Si vide, un mot de passe aléatoire est généré et affiché.")
    parser.add_argument("--json", action="store_true", help="Sortie JSON.")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        result = seed_smoke_tenants(
            db,
            reset=bool(args.reset),
            include_demo_data=bool(args.with_demo_data),
            with_connectors=bool(args.with_connectors),
            email_domain=args.email_domain,
            password=args.password,
        )
        payload = result.to_dict()
        if args.json:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            return 0

        print("✅ Smoke seed prêt")
        print(f"Mot de passe partagé: {payload['password']}")
        print("")
        for tenant in payload["tenants"]:
            print(f"- {tenant['key']}: {tenant['name']} ({tenant['slug']})")
            print(f"  login: {tenant['email']}")
            print(f"  plan: {tenant['plan']} | wallet={tenant['wallet_balance']} | bonus={tenant['welcome_bonus_granted']}")
            if tenant.get("connectors", {}).get("seqino") or tenant.get("connectors", {}).get("chorus"):
                print(
                    "  connecteurs: "
                    f"seqino={tenant['connectors'].get('seqino', False)} "
                    f"chorus={tenant['connectors'].get('chorus', False)}"
                )
            if tenant.get("demo_counts"):
                print(f"  démo: {tenant['demo_counts']}")
        if payload.get("connectors_skip_reason"):
            print("")
            print(f"Connecteurs configurés ignorés: {payload['connectors_skip_reason']}")
        if payload.get("warnings"):
            print("")
            print("Warnings:")
            for warning in payload["warnings"]:
                print(f" - {warning}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
