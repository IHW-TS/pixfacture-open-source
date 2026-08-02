"""Add credit note refunds table

B2B+++: permettre de marquer / tracer les remboursements d'avoirs.

- Table credit_note_refunds (mouvements de remboursement)
- Index sur invoice_id et date

Revision ID: 20260705_00
Revises: 20260704_02
Create Date: 2026-02-05
"""

from alembic import op
import sqlalchemy as sa


revision = "20260705_00"
down_revision = "20260704_02"
branch_labels = None
depends_on = None


def _table_exists(conn, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in inspector.get_table_names()


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx.get("name") == name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "credit_note_refunds"):
        op.create_table(
            "credit_note_refunds",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
            sa.Column("date", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("method", sa.String(), nullable=True),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("reference", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        )

    if _table_exists(conn, "credit_note_refunds"):
        if not _index_exists(conn, "credit_note_refunds", "ix_credit_note_refunds_invoice"):
            op.create_index(
                "ix_credit_note_refunds_invoice",
                "credit_note_refunds",
                ["invoice_id"],
            )
        if not _index_exists(conn, "credit_note_refunds", "ix_credit_note_refunds_invoice_date"):
            op.create_index(
                "ix_credit_note_refunds_invoice_date",
                "credit_note_refunds",
                ["invoice_id", "date"],
            )


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "credit_note_refunds"):
        if _index_exists(conn, "credit_note_refunds", "ix_credit_note_refunds_invoice_date"):
            op.drop_index("ix_credit_note_refunds_invoice_date", table_name="credit_note_refunds")
        if _index_exists(conn, "credit_note_refunds", "ix_credit_note_refunds_invoice"):
            op.drop_index("ix_credit_note_refunds_invoice", table_name="credit_note_refunds")
        op.drop_table("credit_note_refunds")
