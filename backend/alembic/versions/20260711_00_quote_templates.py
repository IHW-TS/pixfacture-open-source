"""Add quote template fields

Revision ID: 20260711_quote_templates
Revises: 20260710_bank_accounts
Create Date: 2026-05-01
"""

from alembic import op
import sqlalchemy as sa


revision = "20260711_quote_templates"
down_revision = "20260710_bank_accounts"
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
    if not _column_exists(conn, "quotes", "template_key"):
        op.add_column("quotes", sa.Column("template_key", sa.String(), nullable=True))
    if not _column_exists(conn, "quotes", "template_options"):
        op.add_column("quotes", sa.Column("template_options", sa.JSON(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "quotes", "template_options"):
        op.drop_column("quotes", "template_options")
    if _column_exists(conn, "quotes", "template_key"):
        op.drop_column("quotes", "template_key")
