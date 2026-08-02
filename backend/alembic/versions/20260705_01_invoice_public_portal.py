"""invoice_public_portal

Ajoute le portail public pour les factures :
- token partageable (public_token + enabled + created_at)
- tracking de vues (count + first/last)

Objectif : permettre d'envoyer un lien client type /i/{token} (comme les devis).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20260705_01"
down_revision = "20260705_00"
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
    with op.batch_alter_table("invoices") as batch:
        if not _col_exists("invoices", "public_token"):
            batch.add_column(sa.Column("public_token", sa.String(), nullable=True))
        if not _col_exists("invoices", "public_enabled"):
            batch.add_column(sa.Column("public_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        if not _col_exists("invoices", "public_created_at"):
            batch.add_column(sa.Column("public_created_at", sa.DateTime(), nullable=True))

        if not _col_exists("invoices", "public_view_count"):
            batch.add_column(sa.Column("public_view_count", sa.Integer(), nullable=False, server_default="0"))
        if not _col_exists("invoices", "public_first_viewed_at"):
            batch.add_column(sa.Column("public_first_viewed_at", sa.DateTime(), nullable=True))
        if not _col_exists("invoices", "public_last_viewed_at"):
            batch.add_column(sa.Column("public_last_viewed_at", sa.DateTime(), nullable=True))

    _safe_create_index("ix_invoices_public_token", "invoices", ["public_token"], unique=True)


def downgrade() -> None:
    # volontairement non destructif
    pass
