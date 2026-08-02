"""Add tenant bank accounts and line accounting accounts

Revision ID: 20260710_bank_accounts
Revises: 20260709_00_document_line_types
Create Date: 2026-04-26
"""

from alembic import op
import sqlalchemy as sa


revision = "20260710_bank_accounts"
down_revision = "20260709_00_document_line_types"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(column["name"] == column_name for column in sa.inspect(conn).get_columns(table_name))


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(index["name"] == index_name for index in sa.inspect(conn).get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "tenant_bank_accounts"):
        op.create_table(
            "tenant_bank_accounts",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("label", sa.String(), nullable=False, server_default="RIB principal"),
            sa.Column("iban", sa.String(), nullable=True),
            sa.Column("bic", sa.String(), nullable=True),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _index_exists(conn, "tenant_bank_accounts", "ix_tenant_bank_accounts_tenant_id"):
        op.create_index("ix_tenant_bank_accounts_tenant_id", "tenant_bank_accounts", ["tenant_id"])
    if not _index_exists(conn, "tenant_bank_accounts", "ix_tenant_bank_accounts_tenant_default"):
        op.create_index(
            "ix_tenant_bank_accounts_tenant_default",
            "tenant_bank_accounts",
            ["tenant_id", "is_default"],
        )

    for table_name in ("invoice_lines", "quote_lines"):
        if not _column_exists(conn, table_name, "accounting_account"):
            op.add_column(table_name, sa.Column("accounting_account", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    for table_name in ("quote_lines", "invoice_lines"):
        if _column_exists(conn, table_name, "accounting_account"):
            op.drop_column(table_name, "accounting_account")
    if _table_exists(conn, "tenant_bank_accounts"):
        if _index_exists(conn, "tenant_bank_accounts", "ix_tenant_bank_accounts_tenant_default"):
            op.drop_index("ix_tenant_bank_accounts_tenant_default", table_name="tenant_bank_accounts")
        if _index_exists(conn, "tenant_bank_accounts", "ix_tenant_bank_accounts_tenant_id"):
            op.drop_index("ix_tenant_bank_accounts_tenant_id", table_name="tenant_bank_accounts")
        op.drop_table("tenant_bank_accounts")
