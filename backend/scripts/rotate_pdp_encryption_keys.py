"""
Rotation des credentials plateformes (PDP) vers la cle active.

Execution (depuis backend/):
    python -m scripts.rotate_pdp_encryption_keys
    python -m scripts.rotate_pdp_encryption_keys --dry-run
"""
import argparse

from app.db import SessionLocal
from app.models import PdpConnection
from app.utils.crypto import decrypt_payload, encrypt_payload


def _rotate(dry_run: bool) -> None:
    session = SessionLocal()
    updated = 0
    try:
        connections = (
            session.query(PdpConnection)
            .filter(PdpConnection.encrypted_credentials.isnot(None))
            .all()
        )
        for conn in connections:
            if not conn.encrypted_credentials:
                continue
            creds = decrypt_payload(conn.encrypted_credentials)
            encrypted = encrypt_payload(creds)
            updated += 1
            if not dry_run:
                conn.encrypted_credentials = encrypted
        if not dry_run:
            session.commit()
        print(f"Rotation terminee: {updated} connection(s) traitees.")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-chiffre les credentials PDP avec la cle active.")
    parser.add_argument("--dry-run", action="store_true", help="Affiche le total sans ecrire en base.")
    args = parser.parse_args()
    _rotate(args.dry_run)


if __name__ == "__main__":
    main()
