"""Add tenant e-reporting periodicity fields

Revision ID: 20260513_00
Revises: 20260512_05
Create Date: 2026-05-13
"""

from alembic import op
import sqlalchemy as sa

revision = "20260513_00"
down_revision = "20260512_05"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "vat_regime"):
        op.add_column("tenants", sa.Column("vat_regime", sa.String(), nullable=False, server_default="reel_normal"))
    if not _column_exists(conn, "tenants", "transaction_periodicity"):
        op.add_column("tenants", sa.Column("transaction_periodicity", sa.String(), nullable=True))
    if not _column_exists(conn, "tenants", "payment_periodicity"):
        op.add_column("tenants", sa.Column("payment_periodicity", sa.String(), nullable=True))
    if not _column_exists(conn, "tenants", "payments_reporting_enabled"):
        op.add_column(
            "tenants",
            sa.Column("payments_reporting_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade() -> None:
    conn = op.get_bind()
    for column in [
        "payments_reporting_enabled",
        "payment_periodicity",
        "transaction_periodicity",
        "vat_regime",
    ]:
        if _column_exists(conn, "tenants", column):
            op.drop_column("tenants", column)
