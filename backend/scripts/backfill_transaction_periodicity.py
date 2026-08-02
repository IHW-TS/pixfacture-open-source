"""
Backfill tenant.transaction_periodicity when missing, based on vat_regime defaults.

Usage:
    python -m scripts.backfill_transaction_periodicity
"""

from app.db import get_db
from app.models import Tenant
from app.services.ereporting_builder import _default_periodicities_from_regime


def run() -> None:
    updated = 0
    with next(get_db()) as db:
        tenants = db.query(Tenant).all()
        for tenant in tenants:
            current = (tenant.transaction_periodicity or "").strip()
            if current:
                continue
            default_tx, _ = _default_periodicities_from_regime(getattr(tenant, "vat_regime", None))
            tenant.transaction_periodicity = default_tx
            db.add(tenant)
            updated += 1
        if updated:
            db.commit()
    print(f"Backfill termine. Tenants mis a jour: {updated}")


if __name__ == "__main__":
    run()
