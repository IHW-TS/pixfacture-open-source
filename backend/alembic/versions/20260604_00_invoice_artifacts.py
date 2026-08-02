"""Add invoice snapshot columns and artifacts table

Revision ID: 20260604_00
Revises: 20260603_00
Create Date: 2026-06-04
"""

from alembic import op
import sqlalchemy as sa


revision = "20260604_00"
down_revision = "20260603_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "supplier_snapshot"):
        op.add_column("invoices", sa.Column("supplier_snapshot", sa.JSON(), nullable=True))
    if not _column_exists(conn, "invoices", "lines_snapshot"):
        op.add_column("invoices", sa.Column("lines_snapshot", sa.JSON(), nullable=True))
    if not _column_exists(conn, "invoices", "totals_snapshot"):
        op.add_column("invoices", sa.Column("totals_snapshot", sa.JSON(), nullable=True))
    try:
        op.create_table(
            "invoice_artifacts",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("sha256", sa.String(), nullable=False),
            sa.Column("content_type", sa.String(), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("data", sa.LargeBinary(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint("invoice_id", "kind", name="uniq_invoice_artifact_invoice_kind"),
            sa.CheckConstraint(
                "kind in ('PDF', 'FACTURX', 'UBL', 'CII')",
                name="ck_invoice_artifact_kind",
            ),
        )
        op.create_index("ix_invoice_artifacts_tenant_id", "invoice_artifacts", ["tenant_id"])
        op.create_index("ix_invoice_artifacts_invoice_id", "invoice_artifacts", ["invoice_id"])
        op.create_index("ix_invoice_artifacts_kind", "invoice_artifacts", ["kind"])
    except Exception:
        pass
    try:
        if _column_exists(conn, "invoices", "seller_snapshot") and _column_exists(conn, "invoices", "supplier_snapshot"):
            op.execute(
                "UPDATE invoices SET supplier_snapshot = seller_snapshot "
                "WHERE supplier_snapshot IS NULL AND seller_snapshot IS NOT NULL"
            )
    except Exception:
        pass


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "invoice_artifacts"):
        try:
            op.drop_index("ix_invoice_artifacts_kind", table_name="invoice_artifacts")
        except Exception:
            pass
        try:
            op.drop_index("ix_invoice_artifacts_invoice_id", table_name="invoice_artifacts")
        except Exception:
            pass
        try:
            op.drop_index("ix_invoice_artifacts_tenant_id", table_name="invoice_artifacts")
        except Exception:
            pass
        try:
            op.drop_table("invoice_artifacts")
        except Exception:
            pass
    if _column_exists(conn, "invoices", "totals_snapshot"):
        op.drop_column("invoices", "totals_snapshot")
    if _column_exists(conn, "invoices", "lines_snapshot"):
        op.drop_column("invoices", "lines_snapshot")
    if _column_exists(conn, "invoices", "supplier_snapshot"):
        op.drop_column("invoices", "supplier_snapshot")
