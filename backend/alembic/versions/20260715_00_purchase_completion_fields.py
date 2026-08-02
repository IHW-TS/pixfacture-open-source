"""Add purchase completion fields

Revision ID: 20260715_purchase_completion
Revises: 20260714_tenant_naf_code
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa


revision = "20260715_purchase_completion"
down_revision = "20260714_tenant_naf_code"
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
    columns = {
        "purchase_nature": sa.Column("purchase_nature", sa.String(), nullable=True),
        "accounting_account": sa.Column("accounting_account", sa.String(), nullable=True),
        "accountant_note": sa.Column("accountant_note", sa.Text(), nullable=True),
        "planned_payment_date": sa.Column("planned_payment_date", sa.Date(), nullable=True),
        "paid_by_employee": sa.Column("paid_by_employee", sa.Boolean(), nullable=False, server_default=sa.false()),
        "purchase_tags": sa.Column("purchase_tags", sa.JSON(), nullable=True),
        "completion_status": sa.Column("completion_status", sa.String(), nullable=False, server_default="draft"),
        "completion_validated_at": sa.Column("completion_validated_at", sa.DateTime(), nullable=True),
        "duplicate_of_id": sa.Column("duplicate_of_id", sa.String(), nullable=True),
    }
    for name, column in columns.items():
        if not _column_exists(conn, "inbound_invoices", name):
            op.add_column("inbound_invoices", column)
    if _column_exists(conn, "inbound_invoices", "duplicate_of_id") and not _index_exists(
        conn,
        "inbound_invoices",
        "ix_inbound_invoices_duplicate_of_id",
    ):
        op.create_index(
            "ix_inbound_invoices_duplicate_of_id",
            "inbound_invoices",
            ["duplicate_of_id"],
            unique=False,
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _index_exists(conn, "inbound_invoices", "ix_inbound_invoices_duplicate_of_id"):
        op.drop_index("ix_inbound_invoices_duplicate_of_id", table_name="inbound_invoices")
    for name in (
        "duplicate_of_id",
        "completion_validated_at",
        "completion_status",
        "purchase_tags",
        "paid_by_employee",
        "planned_payment_date",
        "accountant_note",
        "accounting_account",
        "purchase_nature",
    ):
        if _column_exists(conn, "inbound_invoices", name):
            op.drop_column("inbound_invoices", name)
