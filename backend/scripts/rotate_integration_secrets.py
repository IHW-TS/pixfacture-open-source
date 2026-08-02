"""
Rotation des secrets d'integration vers la cle active.

Execution (depuis backend/):
    python -m scripts.rotate_integration_secrets
    python -m scripts.rotate_integration_secrets --dry-run
"""
import argparse

from app.db import SessionLocal
from app.services.integration_secrets import rotate_integration_secrets


def _rotate(dry_run: bool) -> None:
    session = SessionLocal()
    try:
        updated = rotate_integration_secrets(session, dry_run=dry_run)
        if not dry_run:
            session.commit()
        print(f"Rotation terminee: {updated} secret(s) traite(s).")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-chiffre les secrets d'integration avec la cle active.")
    parser.add_argument("--dry-run", action="store_true", help="Affiche le total sans ecrire en base.")
    args = parser.parse_args()
    _rotate(args.dry_run)


if __name__ == "__main__":
    main()
