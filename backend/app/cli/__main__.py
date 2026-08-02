import argparse
import getpass
import json
import os
import secrets
import sys
from pathlib import Path

from app.db import get_db
from app.services.demo_invitations import DemoInvitationError, create_demo_invitation
from app.services.platform_admin import promote_platform_admin


def _require_bootstrap_token(provided: str | None) -> bool:
    expected = (os.environ.get("PLATFORM_ADMIN_BOOTSTRAP_TOKEN") or "").strip()
    expected_key = "PLATFORM_ADMIN_BOOTSTRAP_TOKEN"
    if not expected:
        expected = (os.environ.get("PLATFORM_BOOTSTRAP_TOKEN") or "").strip()
        expected_key = "PLATFORM_BOOTSTRAP_TOKEN"
    if not expected:
        print("PLATFORM_ADMIN_BOOTSTRAP_TOKEN/PLATFORM_BOOTSTRAP_TOKEN manquant.", file=sys.stderr)
        return False
    provided_value = (provided or "").strip()
    if not provided_value:
        print(f"Token bootstrap manquant: ajoutez --token (attendu via {expected_key}).", file=sys.stderr)
        return False
    if not secrets.compare_digest(provided_value, expected):
        print(f"Token bootstrap invalide: verifiez --token (attendu via {expected_key}).", file=sys.stderr)
        return False
    return True


def _resolve_bootstrap_token(provided: str | None) -> str | None:
    provided_value = (provided or "").strip()
    if provided_value:
        return provided_value
    if sys.stdin.isatty():
        return getpass.getpass("Token bootstrap : ").strip() or None
    return None


def _promote_platform_admin(email: str, token: str | None) -> int:
    if not _require_bootstrap_token(token):
        return 2
    normalized = (email or "").strip().lower()
    if not normalized:
        print("Email manquant.", file=sys.stderr)
        return 2
    db = next(get_db())
    try:
        user = promote_platform_admin(db, normalized)
    finally:
        db.close()
    if not user:
        print("Utilisateur introuvable.", file=sys.stderr)
        return 3
    print(f"OK: {user.email} est admin plateforme.")
    return 0


def _write_private_invitation_file(path_value: str, payload: dict[str, object]) -> None:
    path = Path(path_value).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _create_demo_invitation(
    *,
    email: str,
    preset: str,
    expires_in_hours: int,
    output_file: str,
    token: str | None,
) -> int:
    if not _require_bootstrap_token(token):
        return 2
    output_path = Path(output_file).expanduser()
    file_written = False
    db = next(get_db())
    try:
        issued = create_demo_invitation(
            db,
            email=email,
            preset=preset,
            ttl_hours=expires_in_hours,
        )
        payload = {
            "id": issued.invitation.id,
            "email": issued.invitation.email,
            "preset": issued.invitation.preset,
            "expires_at": issued.invitation.expires_at.isoformat(),
            "registration_url": issued.registration_url,
        }
        _write_private_invitation_file(output_file, payload)
        file_written = True
        db.commit()
    except (DemoInvitationError, FileExistsError, OSError) as exc:
        db.rollback()
        if file_written:
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass
        print(f"Invitation non créée : {exc}", file=sys.stderr)
        return 3
    finally:
        db.close()
    print(f"OK: invitation créée pour {payload['email']} jusqu'au {payload['expires_at']}.")
    print(f"Lien écrit dans un fichier privé (0600) : {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    promote_parser = subparsers.add_parser("promote_platform_admin", help="Promouvoir un admin plateforme.")
    promote_parser.add_argument("--email", required=True, help="Email de l'utilisateur a promouvoir.")
    promote_parser.add_argument(
        "--token",
        help="Token bootstrap. S'il est omis dans un terminal interactif, il est demandé sans écho.",
    )

    invitation_parser = subparsers.add_parser(
        "create_demo_invitation",
        help="Créer un lien de démo individuel à usage unique.",
    )
    invitation_parser.add_argument("--email", required=True, help="Email professionnel du prospect.")
    invitation_parser.add_argument(
        "--preset",
        default="services",
        choices=["services", "retail", "construction", "public_sector", "health"],
        help="Scénario de données fictives.",
    )
    invitation_parser.add_argument(
        "--expires-in-hours",
        type=int,
        default=72,
        help="Durée de validité du lien (1 à 720 heures).",
    )
    invitation_parser.add_argument(
        "--output-file",
        required=True,
        help="Nouveau fichier privé dans lequel écrire le lien (refus si le fichier existe).",
    )
    invitation_parser.add_argument(
        "--token",
        help="Token bootstrap. S'il est omis dans un terminal interactif, il est demandé sans écho.",
    )

    args = parser.parse_args(argv)
    if args.command == "promote_platform_admin":
        return _promote_platform_admin(args.email, _resolve_bootstrap_token(args.token))
    if args.command == "create_demo_invitation":
        if args.expires_in_hours < 1 or args.expires_in_hours > 24 * 30:
            parser.error("--expires-in-hours doit être compris entre 1 et 720.")
        return _create_demo_invitation(
            email=args.email,
            preset=args.preset,
            expires_in_hours=args.expires_in_hours,
            output_file=args.output_file,
            token=_resolve_bootstrap_token(args.token),
        )
    parser.error("Commande inconnue.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
