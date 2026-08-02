"""Add invoice immutability snapshots and issued files

Revision ID: 20250205_02
Revises: 20251213_01
Create Date: 2025-02-05
"""

from alembic import op
import sqlalchemy as sa


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}

# revision identifiers, used by Alembic.
revision = "20250205_02"
down_revision = "20251213_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "seller_snapshot"):
        op.add_column("invoices", sa.Column("seller_snapshot", sa.JSON(), nullable=True))
    if not _column_exists(conn, "invoices", "buyer_snapshot"):
        op.add_column("invoices", sa.Column("buyer_snapshot", sa.JSON(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_pdf"):
        op.add_column("invoices", sa.Column("issued_pdf", sa.LargeBinary(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_facturx_xml"):
        op.add_column("invoices", sa.Column("issued_facturx_xml", sa.LargeBinary(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "invoices", "issued_facturx_xml"):
        op.drop_column("invoices", "issued_facturx_xml")
    if _column_exists(conn, "invoices", "issued_pdf"):
        op.drop_column("invoices", "issued_pdf")
    if _column_exists(conn, "invoices", "buyer_snapshot"):
        op.drop_column("invoices", "buyer_snapshot")
    if _column_exists(conn, "invoices", "seller_snapshot"):
        op.drop_column("invoices", "seller_snapshot")
