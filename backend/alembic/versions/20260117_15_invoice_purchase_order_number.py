"""Add invoice purchase order number

Revision ID: 20260117_15
Revises: 20260116_14
Create Date: 2026-01-17
"""

from alembic import op
import sqlalchemy as sa

revision = "20260117_15"
down_revision = "20260116_14"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "purchase_order_number" not in existing_columns:
        op.add_column("invoices", sa.Column("purchase_order_number", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "purchase_order_number" in existing_columns:
        op.drop_column("invoices", "purchase_order_number")
