"""
Seed de données de démonstration.
Exécution (depuis backend/) :
    python -m scripts.seed_demo_data
"""
import os
import random
from datetime import datetime, timedelta

from app.db import SessionLocal
from app.models import Tenant, User, Customer, Invoice, InvoiceLine, Submission, Numbering
from app.utils.passwords import pwd

DEMO_PASSWORD = os.getenv("DEMO_SEED_PASSWORD")


def _guard_demo_seed() -> None:
    env = (
        os.getenv("APP_ENV")
        or os.getenv("ENV")
        or os.getenv("ENVIRONMENT")
        or "dev"
    ).strip().lower()
    if env in {"prod", "production", "staging"} and os.getenv("ALLOW_DEMO_SEED_IN_PROD") != "true":
        raise SystemExit(
            "Seed de démo refusé en prod/staging. "
            "Définir ALLOW_DEMO_SEED_IN_PROD=true uniquement pour une opération contrôlée."
        )
    if not DEMO_PASSWORD:
        raise SystemExit("DEMO_SEED_PASSWORD est requis pour créer les comptes de démo.")


def _ensure_numbering(session, tenant_id: str) -> None:
    if not session.query(Numbering).filter_by(tenant_id=tenant_id).first():
        session.add(Numbering(tenant_id=tenant_id, prefix="F-", last_index=0))


def _create_tenant(session, name: str, plan: str) -> Tenant:
    existing = session.query(Tenant).filter_by(name=name).first()
    if existing:
        return existing
    t = Tenant(
        name=name,
        plan=plan,
        subscription_status="active",
        siret="99999999999999",
        vat_number="FR19999999999",
        iban="FR7630006000011234567890189",
        bic="AGRIFRPPXXX",
        address="1 rue de la Demo 75000 Paris",
    )
    session.add(t)
    session.flush()
    _ensure_numbering(session, t.id)
    return t


def _create_users(session, tenant: Tenant, emails: list[str]) -> None:
    for i, email in enumerate(emails):
        if session.query(User).filter_by(email=email).first():
            continue
        session.add(
            User(
                tenant_id=tenant.id,
                email=email,
                password_hash=pwd.hash(DEMO_PASSWORD),
                role="owner" if i == 0 else "accountant",
            )
        )


def _create_customers(session, tenant: Tenant, n: int = 3) -> list[Customer]:
    customers = []
    for i in range(n):
        c = Customer(
            tenant_id=tenant.id,
            name=f"Client {i+1} {tenant.name}",
            email=f"client{i+1}@{tenant.name.replace(' ','').lower()}.example.com",
            vat_number=f"FR00{random.randint(100000000, 999999999)}",
            address="10 avenue des Tests 75000 Paris",
            country="FR",
        )
        session.add(c)
        customers.append(c)
    session.flush()
    return customers


def _create_invoice(
    session,
    tenant: Tenant,
    customer: Customer,
    number: str,
    issue_offset_days: int,
    status: str,
) -> Invoice:
    inv = Invoice(
        tenant_id=tenant.id,
        customer_id=customer.id,
        number=number,
        currency="EUR",
        status=status,
        issue_date=datetime.utcnow() - timedelta(days=issue_offset_days),
        due_days=30,
        due_date=datetime.utcnow() - timedelta(days=max(issue_offset_days - 30, 0)),
        payment_terms="30 jours fin de mois",
        total_ex_vat=100,
        total_vat=20,
        total_inc_vat=120,
    )
    session.add(inv)
    session.flush()
    line = InvoiceLine(
        invoice_id=inv.id,
        product_name="Prestation",
        quantity=1,
        unit_price=100,
        vat_rate=20,
        vat_category="S",
        unit_code="C62",
        line_total=100,
    )
    session.add(line)
    return inv


def _seed_tenant(session, name: str, plan: str, users: list[str]) -> None:
    tenant = _create_tenant(session, name, plan)
    _create_users(session, tenant, users)
    customers = _create_customers(session, tenant, n=5)

    # Génère quelques factures avec statuts variés
    statuses = ["paid", "sent", "overdue", "draft"]
    for idx in range(1, 7):
        customer = random.choice(customers)
        status = random.choice(statuses)
        inv = _create_invoice(
            session,
            tenant,
            customer,
            number=f"{tenant.name[:3].upper()}-{idx:04d}",
            issue_offset_days=random.randint(5, 90),
            status=status,
        )
        if status == "paid":
            inv.paid_at = datetime.utcnow() - timedelta(days=2)
        session.add(inv)

        # Quelques submissions Chorus factices
        if status in {"sent", "overdue"}:
            session.add(
                Submission(
                    invoice_id=inv.id,
                    channel="chorus",
                    status=random.choice(["submitted", "processing", "rejected", "accepted"]),
                    external_id=f"CHORUS-{random.randint(1000,9999)}",
                    message="Démo",
                )
            )


def run():
    _guard_demo_seed()
    session = SessionLocal()
    try:
        _seed_tenant(session, "Demo Starter", "starter", ["starter@example.com"])
        _seed_tenant(session, "Demo Pro", "pro", ["pro@example.com", "pro2@example.com"])
        _seed_tenant(session, "Demo Enterprise", "enterprise", ["enterprise@example.com", "enterprise2@example.com"])
        session.commit()
        print("Seed de démo terminé.")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    run()
