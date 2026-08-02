#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import get_db
from app.models import User


def _parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError("make-admin doit être un booléen (true/false).")


def main() -> int:
    parser = argparse.ArgumentParser(description="Activer ou désactiver un admin plateforme.")
    parser.add_argument("--email", required=True, help="Email de l'utilisateur à modifier.")
    parser.add_argument("--make-admin", required=True, type=_parse_bool, help="true/false")
    args = parser.parse_args()

    with next(get_db()) as db:
        user = db.query(User).filter(User.email == args.email).first()
        if not user:
            print("Utilisateur introuvable.")
            return 1
        user.is_platform_admin = args.make_admin
        db.add(user)
        db.commit()

    state = "admin" if args.make_admin else "non-admin"
    print(f"OK: {args.email} => {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
