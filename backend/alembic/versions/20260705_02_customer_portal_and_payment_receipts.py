"""customer_portal_and_payment_receipts

Ajouts "B2B premium" :
- Portail client unifié (token partageable sur Customer)
- Détails de paiement (Stripe) sur Payment pour afficher un reçu / preuve de paiement

Objectif : permettre un portail client /c/{token} avec historique devis/factures/avoirs,
et afficher un reçu Stripe sur le portail facture.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20260705_02"
down_revision = "20260705_01"
branch_labels = None
depends_on = None


def _col_exists(table: str, col: str) -> bool:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table)]
    return col in cols


def _safe_create_index(name: str, table: str, columns: list[str], *, unique: bool = False) -> None:
    try:
        op.create_index(name, table, columns, unique=unique)
    except Exception:
        # Ne pas bloquer si l'index existe déjà
        pass


def upgrade() -> None:
    # customers: customer portal token
    with op.batch_alter_table("customers") as batch:
        if not _col_exists("customers", "portal_token"):
            batch.add_column(sa.Column("portal_token", sa.String(), nullable=True))
        if not _col_exists("customers", "portal_enabled"):
            batch.add_column(sa.Column("portal_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        if not _col_exists("customers", "portal_created_at"):
            batch.add_column(sa.Column("portal_created_at", sa.DateTime(), nullable=True))

        if not _col_exists("customers", "portal_view_count"):
            batch.add_column(sa.Column("portal_view_count", sa.Integer(), nullable=False, server_default="0"))
        if not _col_exists("customers", "portal_first_viewed_at"):
            batch.add_column(sa.Column("portal_first_viewed_at", sa.DateTime(), nullable=True))
        if not _col_exists("customers", "portal_last_viewed_at"):
            batch.add_column(sa.Column("portal_last_viewed_at", sa.DateTime(), nullable=True))

    _safe_create_index("ix_customers_portal_token", "customers", ["portal_token"], unique=True)

    # payments: optional receipt / card details
    with op.batch_alter_table("payments") as batch:
        if not _col_exists("payments", "provider"):
            batch.add_column(sa.Column("provider", sa.String(), nullable=True))
        if not _col_exists("payments", "provider_id"):
            batch.add_column(sa.Column("provider_id", sa.String(), nullable=True))
        if not _col_exists("payments", "receipt_url"):
            batch.add_column(sa.Column("receipt_url", sa.String(), nullable=True))
        if not _col_exists("payments", "card_brand"):
            batch.add_column(sa.Column("card_brand", sa.String(), nullable=True))
        if not _col_exists("payments", "card_last4"):
            batch.add_column(sa.Column("card_last4", sa.String(), nullable=True))


def downgrade() -> None:
    # volontairement non destructif
    pass
