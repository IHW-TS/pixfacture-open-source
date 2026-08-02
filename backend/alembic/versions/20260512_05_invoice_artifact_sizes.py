"""Add invoice artifact sizes

Revision ID: 20260512_05
Revises: 20260510_04
Create Date: 2026-05-12
"""

from alembic import op
import sqlalchemy as sa

revision = "20260512_05"
down_revision = "20260510_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "pdf_size" not in existing_columns:
        op.add_column("invoices", sa.Column("pdf_size", sa.Integer(), nullable=True))
    if "xml_size" not in existing_columns:
        op.add_column("invoices", sa.Column("xml_size", sa.Integer(), nullable=True))
    if "facturx_size" not in existing_columns:
        op.add_column("invoices", sa.Column("facturx_size", sa.Integer(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "facturx_size" in existing_columns:
        op.drop_column("invoices", "facturx_size")
    if "xml_size" in existing_columns:
        op.drop_column("invoices", "xml_size")
    if "pdf_size" in existing_columns:
        op.drop_column("invoices", "pdf_size")
