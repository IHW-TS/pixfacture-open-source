from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys

from app.db import SessionLocal
from app.services.chorus_tenant_migration import (
    ChorusTenantMigrationError,
    migrate_global_chorus_account_to_tenant,
)


def _emit(payload: dict, *, error: bool = False) -> bool:
    try:
        print(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
            file=sys.stderr if error else sys.stdout,
        )
    except Exception:
        return False
    return True


def _safe_session_call(db, method_name: str) -> bool:
    try:
        getattr(db, method_name)()
    except Exception:
        return False
    return True


def _parse_expected_current_siret(value: str) -> str | None:
    normalized = (value or "").strip()
    if normalized.lower() == "none":
        return None
    if not re.fullmatch(r"[0-9]{14}", normalized):
        raise ValueError("expected_current_siret_invalid")
    return normalized


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Vérifie puis migre le CHORUS_CPRO_ACCOUNT global vers le coffre d'un "
            "tenant. Dry-run par défaut; aucune transmission n'est effectuée."
        )
    )
    parser.add_argument("--tenant-slug", required=True, help="Slug exact du tenant interne cible.")
    parser.add_argument(
        "--expected-tenant-id",
        required=True,
        help="Identifiant DB exact du même tenant (seconde confirmation indépendante).",
    )
    parser.add_argument(
        "--expected-current-siret",
        required=True,
        help="SIRET actuellement stocké, ou le mot exact 'none' s'il est absent.",
    )
    parser.add_argument("--siret", required=True, help="SIRET exact attendu (14 chiffres).")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Écrit le secret chiffré et le binding verified après vérification distante.",
    )
    parser.add_argument(
        "--confirm-rebind",
        default=None,
        help=(
            "Confirmation requise uniquement pour remplacer une identité/binding existant : "
            "<tenant-id>:<siret-courant-ou-none>:<nouveau-siret>."
        ),
    )
    args = parser.parse_args(argv)

    try:
        expected_current_siret = _parse_expected_current_siret(args.expected_current_siret)
    except ValueError:
        parser.error("--expected-current-siret doit valoir 'none' ou contenir exactement 14 chiffres.")

    db = None
    exit_code = 0
    error_output = False
    output: dict = {}
    try:
        db = SessionLocal()
        result = asyncio.run(
            migrate_global_chorus_account_to_tenant(
                db,
                tenant_slug=args.tenant_slug,
                expected_tenant_id=args.expected_tenant_id,
                expected_current_siret=expected_current_siret,
                siret=args.siret,
                apply=args.apply,
                rebind_confirmation=args.confirm_rebind,
            )
        )
        if args.apply:
            db.commit()
        else:
            db.rollback()
        output = result.to_public_dict()
    except ChorusTenantMigrationError as exc:
        if db is not None:
            _safe_session_call(db, "rollback")
        output = {"ok": False, "code": exc.code, "message": str(exc)}
        error_output = True
        exit_code = 2
    except Exception:
        # Never render a driver/provider exception: it may contain credentials,
        # request headers or a database URL. The detailed failure stays out of
        # stdout, stderr and traceback by design.
        if db is not None:
            _safe_session_call(db, "rollback")
        output = {
            "ok": False,
            "code": "chorus_migration_internal_error",
            "message": "Migration Chorus interrompue par une erreur interne.",
        }
        error_output = True
        exit_code = 3
    finally:
        if db is not None and not _safe_session_call(db, "close") and exit_code == 0:
            output = {
                "ok": False,
                "code": "chorus_migration_internal_error",
                "message": "Migration Chorus interrompue par une erreur interne.",
            }
            error_output = True
            exit_code = 3

    if not _emit(output, error=error_output):
        return 3
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
