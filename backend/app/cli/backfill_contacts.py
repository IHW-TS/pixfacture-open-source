from __future__ import annotations

import argparse

from sqlalchemy import func

from app.db import SessionLocal
from app.models import Customer, CustomerContact, Tenant


def _backfill_one_tenant(tenant_id: str, dry_run: bool = False, limit: int = 0) -> dict:
    created = 0
    skipped = 0
    processed = 0
    with SessionLocal() as db:
        q = db.query(Customer).filter(Customer.tenant_id == tenant_id).order_by(Customer.created_at.asc())
        if limit and limit > 0:
            q = q.limit(limit)
        customers = q.all()
        for c in customers:
            processed += 1
            email = (c.email or "").strip().lower()
            if not email:
                skipped += 1
                continue
            existing_same = (
                db.query(CustomerContact)
                .filter(
                    CustomerContact.tenant_id == tenant_id,
                    CustomerContact.customer_id == c.id,
                    func.lower(CustomerContact.email) == email,
                )
                .first()
            )
            if existing_same:
                skipped += 1
                continue

            has_any = (
                db.query(CustomerContact)
                .filter(CustomerContact.tenant_id == tenant_id, CustomerContact.customer_id == c.id)
                .first()
            )
            contact = CustomerContact(
                tenant_id=tenant_id,
                customer_id=c.id,
                email=email,
                role="billing",
                send_invoices=True,
                send_quotes=True,
                is_primary=(has_any is None),
            )
            if not dry_run:
                db.add(contact)
            created += 1
        if not dry_run:
            db.commit()
    return {"tenant_id": tenant_id, "processed": processed, "created": created, "skipped": skipped, "dry_run": dry_run}


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill CustomerContact depuis Customer.email")
    parser.add_argument("--tenant-id", default="", help="ID du tenant (sinon tous les tenants)")
    parser.add_argument("--dry-run", action="store_true", help="Simulation (ne crée rien)")
    parser.add_argument("--limit", type=int, default=0, help="Limite de clients à traiter (0 = tous)")
    args = parser.parse_args()

    tenant_id = (args.tenant_id or "").strip()
    dry_run = bool(args.dry_run)
    limit = int(args.limit or 0)

    results = []
    with SessionLocal() as db:
        tenants = [db.get(Tenant, tenant_id)] if tenant_id else db.query(Tenant).all()
        tenants = [t for t in tenants if t is not None]
        for t in tenants:
            if not t.id:
                continue
            r = _backfill_one_tenant(t.id, dry_run=dry_run, limit=limit)
            results.append(r)
            print(f"tenant={t.id} name={t.name!r} created={r['created']} skipped={r['skipped']} dry_run={dry_run}")
    if not results:
        print("Aucun tenant trouvé.")


if __name__ == "__main__":
    main()
