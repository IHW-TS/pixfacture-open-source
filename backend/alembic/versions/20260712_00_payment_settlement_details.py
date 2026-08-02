"""Add payment settlement details

Revision ID: 20260712_payment_settlement
Revises: 20260711_quote_templates
Create Date: 2026-05-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260712_payment_settlement"
down_revision = "20260711_quote_templates"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(column["name"] == column_name for column in sa.inspect(conn).get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "payments", "settlement_mode"):
        op.add_column("payments", sa.Column("settlement_mode", sa.String(), nullable=True))
    if not _column_exists(conn, "payments", "accounting_category"):
        op.add_column("payments", sa.Column("accounting_category", sa.String(), nullable=True))
    if not _column_exists(conn, "payments", "receipt_label"):
        op.add_column("payments", sa.Column("receipt_label", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "payments", "receipt_label"):
        op.drop_column("payments", "receipt_label")
    if _column_exists(conn, "payments", "accounting_category"):
        op.drop_column("payments", "accounting_category")
    if _column_exists(conn, "payments", "settlement_mode"):
        op.drop_column("payments", "settlement_mode")
