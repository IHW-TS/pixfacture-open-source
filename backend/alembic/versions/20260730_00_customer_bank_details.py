"""Add customer bank details

Revision ID: 20260730_customer_bank_details
Revises: 20260729_email_provider_events
Create Date: 2026-05-20 19:35:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260730_customer_bank_details"
down_revision = "20260729_email_provider_events"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "customers"):
        return
    if not _column_exists(conn, "customers", "iban"):
        op.add_column("customers", sa.Column("iban", sa.String(), nullable=True))
    if not _column_exists(conn, "customers", "bic"):
        op.add_column("customers", sa.Column("bic", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "customers"):
        return
    if _column_exists(conn, "customers", "bic"):
        op.drop_column("customers", "bic")
    if _column_exists(conn, "customers", "iban"):
        op.drop_column("customers", "iban")
