"""Add durable invoice deposit applications

Revision ID: 20260719_invoice_deposits
Revises: 20260718_purchase_employee_opts
Create Date: 2026-07-19 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260719_invoice_deposits"
down_revision = "20260718_purchase_employee_opts"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "invoice_kind"):
        op.add_column(
            "invoices",
            sa.Column("invoice_kind", sa.String(), nullable=False, server_default="standard"),
        )
        op.alter_column("invoices", "invoice_kind", server_default=None)
    if not _column_exists(conn, "invoices", "quote_id"):
        op.add_column("invoices", sa.Column("quote_id", sa.String(), nullable=True))
        op.create_foreign_key(
            "fk_invoices_quote_id_quotes",
            "invoices",
            "quotes",
            ["quote_id"],
            ["id"],
        )
    if not _index_exists(conn, "invoices", "ix_invoices_invoice_kind"):
        op.create_index("ix_invoices_invoice_kind", "invoices", ["invoice_kind"])
    if not _index_exists(conn, "invoices", "ix_invoices_quote_id"):
        op.create_index("ix_invoices_quote_id", "invoices", ["quote_id"])
    if not _index_exists(conn, "invoices", "ix_invoices_tenant_quote_kind"):
        op.create_index("ix_invoices_tenant_quote_kind", "invoices", ["tenant_id", "quote_id", "invoice_kind"])

    if not _table_exists(conn, "invoice_deposit_applications"):
        op.create_table(
            "invoice_deposit_applications",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("tenant_id", sa.String(), nullable=False),
            sa.Column("quote_id", sa.String(), nullable=False),
            sa.Column("final_invoice_id", sa.String(), nullable=False),
            sa.Column("deposit_invoice_id", sa.String(), nullable=False),
            sa.Column("amount_ht", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("amount_vat", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("amount_ttc", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("vat_rate", sa.Numeric(5, 2), nullable=True),
            sa.Column("deposit_number", sa.String(), nullable=True),
            sa.Column("deposit_issue_date", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["deposit_invoice_id"], ["invoices.id"]),
            sa.ForeignKeyConstraint(["final_invoice_id"], ["invoices.id"]),
            sa.ForeignKeyConstraint(["quote_id"], ["quotes.id"]),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("deposit_invoice_id", name="uq_invoice_deposit_application_deposit"),
        )
        op.create_index("ix_invoice_deposit_applications_tenant_id", "invoice_deposit_applications", ["tenant_id"])
        op.create_index("ix_invoice_deposit_applications_quote_id", "invoice_deposit_applications", ["quote_id"])
        op.create_index("ix_invoice_deposit_applications_final_invoice_id", "invoice_deposit_applications", ["final_invoice_id"])
        op.create_index("ix_invoice_deposit_applications_deposit_invoice_id", "invoice_deposit_applications", ["deposit_invoice_id"])
        op.create_index(
            "ix_invoice_deposit_applications_tenant_final",
            "invoice_deposit_applications",
            ["tenant_id", "final_invoice_id"],
        )
        op.create_index(
            "ix_invoice_deposit_applications_tenant_quote",
            "invoice_deposit_applications",
            ["tenant_id", "quote_id"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "invoice_deposit_applications"):
        op.drop_table("invoice_deposit_applications")
    if _index_exists(conn, "invoices", "ix_invoices_tenant_quote_kind"):
        op.drop_index("ix_invoices_tenant_quote_kind", table_name="invoices")
    if _index_exists(conn, "invoices", "ix_invoices_quote_id"):
        op.drop_index("ix_invoices_quote_id", table_name="invoices")
    if _index_exists(conn, "invoices", "ix_invoices_invoice_kind"):
        op.drop_index("ix_invoices_invoice_kind", table_name="invoices")
    if _column_exists(conn, "invoices", "quote_id"):
        try:
            op.drop_constraint("fk_invoices_quote_id_quotes", "invoices", type_="foreignkey")
        except Exception:
            pass
        op.drop_column("invoices", "quote_id")
    if _column_exists(conn, "invoices", "invoice_kind"):
        op.drop_column("invoices", "invoice_kind")
