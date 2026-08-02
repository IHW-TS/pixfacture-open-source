"""Add tenant phone profile field

Revision ID: 20260720_tenant_phone
Revises: 20260719_invoice_deposits
Create Date: 2026-07-20 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260720_tenant_phone"
down_revision = "20260719_invoice_deposits"
branch_labels = None
depends_on = None


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "phone"):
        op.add_column("tenants", sa.Column("phone", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "phone"):
        op.drop_column("tenants", "phone")
