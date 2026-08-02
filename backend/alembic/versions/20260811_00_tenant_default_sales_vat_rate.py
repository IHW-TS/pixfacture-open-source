"""Add tenant default sales VAT rate.

Revision ID: 20260811_default_sales_vat_rate
Revises: 20260810_followup_subject
Create Date: 2026-07-04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260811_default_sales_vat_rate"
down_revision = "20260810_followup_subject"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    conn = op.get_bind()
    return any(column.get("name") == column_name for column in sa.inspect(conn).get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("tenants", "default_sales_vat_rate"):
        with op.batch_alter_table("tenants") as batch:
            batch.add_column(sa.Column("default_sales_vat_rate", sa.Numeric(5, 2), nullable=True))


def downgrade() -> None:
    if _column_exists("tenants", "default_sales_vat_rate"):
        with op.batch_alter_table("tenants") as batch:
            batch.drop_column("default_sales_vat_rate")
