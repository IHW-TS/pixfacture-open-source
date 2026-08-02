"""Add PDF/A-3 status fields to invoices

Revision ID: 20260401_22
Revises: 20260325_21
Create Date: 2026-04-01
"""

from alembic import op
import sqlalchemy as sa

revision = "20260401_22"
down_revision = "20260325_21"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "pdfa3_status" not in existing_columns:
        op.add_column("invoices", sa.Column("pdfa3_status", sa.String(), nullable=True))
    if "pdfa3_report" not in existing_columns:
        op.add_column("invoices", sa.Column("pdfa3_report", sa.Text(), nullable=True))
    if "facturx_spec_version" not in existing_columns:
        op.add_column("invoices", sa.Column("facturx_spec_version", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("invoices")}
    if "facturx_spec_version" in existing_columns:
        op.drop_column("invoices", "facturx_spec_version")
    if "pdfa3_report" in existing_columns:
        op.drop_column("invoices", "pdfa3_report")
    if "pdfa3_status" in existing_columns:
        op.drop_column("invoices", "pdfa3_status")
