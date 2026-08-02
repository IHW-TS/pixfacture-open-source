#!/usr/bin/env python3
"""Fail closed unless Alembic is connected as the dedicated migration owner."""

from __future__ import annotations

import os
import re
import sys

from sqlalchemy import create_engine, text


ROLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def assert_expected_migration_role(database_url: str, expected_role: str) -> None:
    if not database_url:
        raise RuntimeError("DATABASE_URL absent du conteneur migrateur.")
    if not ROLE_RE.fullmatch(expected_role) or expected_role == "postgres":
        raise RuntimeError("MIGRATION_EXPECTED_DB_ROLE absent ou non sûr.")

    engine = create_engine(database_url, pool_pre_ping=True, future=True)
    try:
        with engine.connect() as connection:
            row = connection.execute(
                text(
                    """
                    SELECT current_user,
                           role.rolsuper,
                           role.rolcreatedb,
                           role.rolcreaterole,
                           role.rolreplication,
                           role.rolbypassrls,
                           pg_get_userbyid(database.datdba),
                           pg_get_userbyid(namespace.nspowner)
                      FROM pg_roles role
                      JOIN pg_database database ON database.datname = current_database()
                      JOIN pg_namespace namespace ON namespace.nspname = 'public'
                     WHERE role.rolname = current_user
                    """
                )
            ).one()
    finally:
        engine.dispose()

    current_role, *role_state = row
    privileged_flags = role_state[:5]
    database_owner, schema_owner = role_state[5:]
    if current_role != expected_role:
        raise RuntimeError("Le migrateur n'utilise pas le rôle PostgreSQL attendu.")
    if any(bool(flag) for flag in privileged_flags):
        raise RuntimeError("Le rôle de migration conserve un attribut privilégié.")
    if database_owner != expected_role or schema_owner != expected_role:
        raise RuntimeError("Le rôle de migration ne détient pas la base et le schéma public.")


def main() -> int:
    try:
        assert_expected_migration_role(
            os.environ.get("DATABASE_URL", ""),
            os.environ.get("MIGRATION_EXPECTED_DB_ROLE", ""),
        )
    except RuntimeError as exc:
        print(f"Migration refusée: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        # Never print DATABASE_URL or driver errors that may embed credentials.
        print(
            f"Migration refusée: vérification PostgreSQL impossible ({type(exc).__name__}).",
            file=sys.stderr,
        )
        return 2

    print("Rôle de migration PostgreSQL vérifié; lancement Alembic.")
    os.execvp("alembic", ["alembic", "-c", "/app/alembic.ini", "upgrade", "head"])
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
