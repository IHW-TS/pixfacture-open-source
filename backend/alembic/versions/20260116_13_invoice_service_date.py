"""Add invoice service date

Revision ID: 20260116_13
Revises: 20260115_12
Create Date: 2026-01-16
"""

from alembic import op
import sqlalchemy as sa

revision = "20260116_13"
down_revision = "20260115_12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "service_date" not in existing_columns:
        op.add_column("invoices", sa.Column("service_date", sa.Date(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "service_date" in existing_columns:
        op.drop_column("invoices", "service_date")
