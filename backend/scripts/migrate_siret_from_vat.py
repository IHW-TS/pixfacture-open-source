"""
Migration légère : déplace les valeurs de TVA à 14 chiffres vers le champ SIRET.

Usage :
    python -m scripts.migrate_siret_from_vat
"""

import re
from app.db import get_db
from app.models import Customer

SIRET_RE = re.compile(r"^\d{14}$")


def run():
    updated = 0
    with next(get_db()) as db:
        customers = db.query(Customer).all()
        for c in customers:
            vat = (c.vat_number or "").strip()
            if c.siret:
                continue
            if vat and SIRET_RE.fullmatch(vat):
                c.siret = vat
                c.vat_number = None
                db.add(c)
                updated += 1
        if updated:
            db.commit()
    print(f"Migration terminée. Clients mis à jour: {updated}")


if __name__ == "__main__":
    run()
