"""Add tenant NAF/APE code

Revision ID: 20260714_tenant_naf_code
Revises: 20260713_document_line_refs
Create Date: 2026-05-05
"""

from alembic import op
import sqlalchemy as sa


revision = "20260714_tenant_naf_code"
down_revision = "20260713_document_line_refs"
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
    if not _column_exists(conn, "tenants", "naf_code"):
        op.add_column("tenants", sa.Column("naf_code", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "naf_code"):
        op.drop_column("tenants", "naf_code")
