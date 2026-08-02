"""Add quotes (devis)

Revision ID: 20260704_00
Revises: 20260703_00
Create Date: 2026-02-04
"""

from alembic import op
import sqlalchemy as sa


revision = "20260704_00"
down_revision = "20260703_00"
branch_labels = None
depends_on = None


def _table_exists(conn, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in inspector.get_table_names()


def _index_exists(conn, table: str, index: str) -> bool:
    inspector = sa.inspect(conn)
    try:
        indexes = inspector.get_indexes(table)
    except Exception:
        return False
    return any(i.get("name") == index for i in indexes)


def _create_index(conn, name: str, table: str, columns: list[str], *, unique: bool = False) -> None:
    if _index_exists(conn, table, name):
        return
    op.create_index(name, table, columns, unique=unique)


def upgrade() -> None:
    conn = op.get_bind()

    if not _table_exists(conn, "quote_numbering"):
        op.create_table(
            "quote_numbering",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("prefix", sa.String(), nullable=True),
            sa.Column("last_index", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("year", sa.Integer(), nullable=True),
            sa.UniqueConstraint("tenant_id", name="uniq_quote_numbering_per_tenant"),
        )
        _create_index(conn, "ix_quote_numbering_tenant_id", "quote_numbering", ["tenant_id"])

    if not _table_exists(conn, "quotes"):
        op.create_table(
            "quotes",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("customer_id", sa.String(), sa.ForeignKey("customers.id"), nullable=False),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=True),
            sa.Column("number", sa.String(), nullable=True),
            sa.Column("currency", sa.String(), nullable=False, server_default="EUR"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("payment_terms", sa.Text(), nullable=True),
            sa.Column("purchase_order_number", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="draft"),
            sa.Column("issue_date", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("service_date", sa.Date(), nullable=True),
            sa.Column("valid_until", sa.Date(), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("accepted_at", sa.DateTime(), nullable=True),
            sa.Column("rejected_at", sa.DateTime(), nullable=True),
            sa.Column("total_ex_vat", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("total_vat", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("total_inc_vat", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("updated_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.UniqueConstraint("tenant_id", "number", name="uq_quotes_tenant_number"),
        )

        _create_index(conn, "ix_quotes_tenant_id", "quotes", ["tenant_id"])
        _create_index(conn, "ix_quotes_customer_id", "quotes", ["customer_id"])
        _create_index(conn, "ix_quotes_invoice_id", "quotes", ["invoice_id"])
        _create_index(conn, "ix_quotes_number", "quotes", ["number"])
        _create_index(conn, "ix_quotes_status", "quotes", ["status"])
        _create_index(conn, "ix_quotes_issue_date", "quotes", ["issue_date"])
        _create_index(conn, "ix_quotes_valid_until", "quotes", ["valid_until"])
        _create_index(conn, "ix_quotes_tenant_number", "quotes", ["tenant_id", "number"])

    if not _table_exists(conn, "quote_lines"):
        op.create_table(
            "quote_lines",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("quote_id", sa.String(), sa.ForeignKey("quotes.id"), nullable=False),
            sa.Column("product_name", sa.String(), nullable=False),
            sa.Column("quantity", sa.Numeric(10, 2), nullable=False, server_default="1"),
            sa.Column("unit_price", sa.Numeric(10, 2), nullable=False, server_default="0"),
            sa.Column("vat_rate", sa.Numeric(5, 2), nullable=False, server_default="20.0"),
            sa.Column("vat_category", sa.String(), nullable=False, server_default="S"),
            sa.Column("exemption_reason_code", sa.String(), nullable=True),
            sa.Column("unit_code", sa.String(), nullable=False, server_default="C62"),
            sa.Column("item_id", sa.String(), nullable=True),
            sa.Column("line_total", sa.Numeric(12, 2), nullable=False, server_default="0"),
        )
        _create_index(conn, "ix_quote_lines_quote_id", "quote_lines", ["quote_id"])


def downgrade() -> None:
    conn = op.get_bind()

    if _table_exists(conn, "quote_lines"):
        if _index_exists(conn, "quote_lines", "ix_quote_lines_quote_id"):
            op.drop_index("ix_quote_lines_quote_id", table_name="quote_lines")
        op.drop_table("quote_lines")

    if _table_exists(conn, "quotes"):
        # drop custom indexes if present
        for idx in [
            "ix_quotes_tenant_number",
            "ix_quotes_valid_until",
            "ix_quotes_issue_date",
            "ix_quotes_status",
            "ix_quotes_number",
            "ix_quotes_invoice_id",
            "ix_quotes_customer_id",
            "ix_quotes_tenant_id",
        ]:
            if _index_exists(conn, "quotes", idx):
                op.drop_index(idx, table_name="quotes")
        op.drop_table("quotes")

    if _table_exists(conn, "quote_numbering"):
        if _index_exists(conn, "quote_numbering", "ix_quote_numbering_tenant_id"):
            op.drop_index("ix_quote_numbering_tenant_id", table_name="quote_numbering")
        op.drop_table("quote_numbering")
