from __future__ import annotations

import argparse
import json
import os
import sys

from ..config import settings
from ..db import SessionLocal
from ..services.demo_seed import ensure_demo_tenant_and_owner, list_demo_presets, seed_tenant_demo_data

DEFAULT_DEMO_PASSWORD = "ChangeMeDemoPassword123!"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed_demo",
        description="Crée (ou réinitialise) un tenant Démo + injecte des données factices (devis/factures) pour des démos.",
    )
    parser.add_argument("--reset", action="store_true", help="Réinitialise l'identité (tenant slug + email) avant de recréer.")
    parser.add_argument("--force-seed", action="store_true", help="Force le seed même si des données de démo existent déjà.")
    parser.add_argument("--no-artifacts", action="store_true", help="N'essaie pas de générer PDF/Factur-X pendant le seed.")
    parser.add_argument("--tenant-slug", default=getattr(settings, "DEMO_MODE_TENANT_SLUG", "demo"), help="Slug du tenant démo.")
    parser.add_argument("--tenant-name", default=getattr(settings, "DEMO_MODE_TENANT_NAME", "Entreprise Démo"), help="Nom du tenant démo.")
    parser.add_argument("--email", default=getattr(settings, "DEMO_MODE_ADMIN_EMAIL", "demo@example.com"), help="Email admin démo.")
    parser.add_argument(
        "--password",
        default=getattr(settings, "DEMO_MODE_ADMIN_PASSWORD", ""),
        help="Mot de passe admin démo (si vide, génération aléatoire lors de la création).",
    )
    parser.add_argument("--json", action="store_true", help="Sortie JSON (utile CI/CD).")
    parser.add_argument(
        "--show-password",
        action="store_true",
        help="Affiche le mot de passe en clair. À réserver à un terminal local sécurisé.",
    )
    parser.add_argument(
        "--preset",
        default="services",
        choices=[item["slug"] for item in list_demo_presets()],
        help="Scenario de demo sectoriel a injecter.",
    )

    args = parser.parse_args(argv)
    env = (
        getattr(settings, "APP_ENV", "")
        or os.getenv("APP_ENV")
        or os.getenv("ENV")
        or os.getenv("ENVIRONMENT")
        or "dev"
    ).strip().lower()
    if env in {"prod", "production", "staging"} and os.getenv("ALLOW_DEMO_SEED_IN_PROD") != "true":
        parser.error(
            "seed_demo refusé en prod/staging. "
            "Définir ALLOW_DEMO_SEED_IN_PROD=true uniquement pour une opération contrôlée."
        )
    if env in {"prod", "production", "staging"} and (args.password or "").strip() == DEFAULT_DEMO_PASSWORD:
        parser.error("Mot de passe démo par défaut interdit en prod/staging.")
    if args.show_password and env in {"prod", "production", "staging"} and os.getenv("ALLOW_SHOW_DEMO_PASSWORD") != "true":
        parser.error(
            "--show-password est interdit en prod/staging sans ALLOW_SHOW_DEMO_PASSWORD=true."
        )

    db = SessionLocal()
    try:
        tenant, user = ensure_demo_tenant_and_owner(
            db,
            tenant_slug=args.tenant_slug,
            tenant_name=args.tenant_name,
            admin_email=args.email,
            admin_password=args.password,
            reset=bool(args.reset),
        )
        result = seed_tenant_demo_data(
            db,
            tenant=tenant,
            user=user,
            force=bool(args.force_seed),
            generate_artifacts=not bool(args.no_artifacts),
            preset=args.preset,
        )

        password = getattr(user, "_demo_password", None) or (args.password or None)
        user_payload = {
            "email": user.email,
        }
        if args.show_password and password:
            user_payload["password"] = password
        elif password:
            user_payload["password_redacted"] = True

        payload = {
            "ok": True,
            "tenant": {
                "id": tenant.id,
                "slug": tenant.tenant_slug,
                "name": tenant.name,
            },
            "user": user_payload,
            "seed": {
                "seeded": result.seeded,
                "message": result.message,
                "counts": result.counts.__dict__,
                "warnings": result.warnings,
                "issued_invoice_ids": result.issued_invoice_ids,
                "preset": args.preset,
            },
        }
        tenant_slug = tenant.tenant_slug
        tenant_name = tenant.name
        user_email = user.email
        seed_message = result.message
        seed_warnings = result.warnings

        if args.json:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        else:
            print("✅ Demo ready")
            print(f"Tenant: {tenant_name} ({tenant_slug})")
            print(f"Login: {user_email}")
            if args.show_password and password:
                print(f"Password: {password}")
            elif password:
                print("Password: (masqué ; utilisez --show-password uniquement en local sécurisé)")
            else:
                print("Password: (inchangé / non renseigné)")
            print("")
            print(f"Preset: {args.preset}")
            print(f"Seed: {seed_message}")
            if seed_warnings:
                print("Warnings:")
                for w in seed_warnings:
                    print(f" - {w}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
