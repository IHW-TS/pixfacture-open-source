"""purchase supplier payments

Revision ID: 20260802_purchase_payments
Revises: 20260801_line_display_number
Create Date: 2026-05-31
"""

from alembic import op
import sqlalchemy as sa


revision = "20260802_purchase_payments"
down_revision = "20260801_line_display_number"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_payments"):
        op.create_table(
            "purchase_payments",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("inbound_invoice_id", sa.String(), nullable=False),
            sa.Column("date", sa.DateTime(), nullable=False),
            sa.Column("method", sa.String(), nullable=True),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("reference", sa.String(), nullable=True),
            sa.Column("settlement_mode", sa.String(), nullable=True),
            sa.Column("accounting_category", sa.String(), nullable=True),
            sa.Column("receipt_label", sa.String(), nullable=True),
            sa.Column("receipt_url", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["inbound_invoice_id"], ["inbound_invoices.id"]),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _index_exists(conn, "purchase_payments", "ix_purchase_payments_tenant_id"):
        op.create_index("ix_purchase_payments_tenant_id", "purchase_payments", ["tenant_id"])
    if not _index_exists(conn, "purchase_payments", "ix_purchase_payments_inbound_invoice_id"):
        op.create_index("ix_purchase_payments_inbound_invoice_id", "purchase_payments", ["inbound_invoice_id"])
    if not _index_exists(conn, "purchase_payments", "ix_purchase_payments_tenant_invoice"):
        op.create_index("ix_purchase_payments_tenant_invoice", "purchase_payments", ["tenant_id", "inbound_invoice_id"])
    if not _index_exists(conn, "purchase_payments", "ix_purchase_payments_tenant_date"):
        op.create_index("ix_purchase_payments_tenant_date", "purchase_payments", ["tenant_id", "date"])
    if not _index_exists(conn, "purchase_payments", "uniq_purchase_payment_invoice_reference"):
        op.create_index(
            "uniq_purchase_payment_invoice_reference",
            "purchase_payments",
            ["tenant_id", "inbound_invoice_id", "reference"],
            unique=True,
        )


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_payments"):
        return
    for index_name in (
        "uniq_purchase_payment_invoice_reference",
        "ix_purchase_payments_tenant_date",
        "ix_purchase_payments_tenant_invoice",
        "ix_purchase_payments_inbound_invoice_id",
        "ix_purchase_payments_tenant_id",
    ):
        if _index_exists(conn, "purchase_payments", index_name):
            op.drop_index(index_name, table_name="purchase_payments")
    op.drop_table("purchase_payments")
