"""customer_contacts

Ajout carnet de contacts par client (multi-destinataires) :
- customer_contacts (emails + flags send_invoices/send_quotes)

Objectif :
- permettre l'envoi "billing contacts" à plusieurs emails (factures/devis)
- éviter le modèle 1 email / customer
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20260706_00"
down_revision = "20260705_02"
branch_labels = None
depends_on = None


def _table_exists(name: str) -> bool:
    bind = op.get_bind()
    insp = inspect(bind)
    try:
        return name in insp.get_table_names()
    except Exception:
        return False


def _safe_create_index(name: str, table: str, columns: list[str], *, unique: bool = False) -> None:
    try:
        op.create_index(name, table, columns, unique=unique)
    except Exception:
        # Ne pas bloquer si l'index existe déjà
        pass


def upgrade() -> None:
    if not _table_exists("customer_contacts"):
        op.create_table(
            "customer_contacts",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("customer_id", sa.String(), sa.ForeignKey("customers.id"), nullable=False),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False, server_default="billing"),
            sa.Column("send_invoices", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("send_quotes", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.UniqueConstraint("customer_id", "email", name="uniq_customer_contact_email"),
        )

    _safe_create_index("ix_customer_contacts_tenant_email", "customer_contacts", ["tenant_id", "email"], unique=False)
    _safe_create_index("ix_customer_contacts_customer_role", "customer_contacts", ["customer_id", "role"], unique=False)


def downgrade() -> None:
    # volontairement non destructif
    pass
