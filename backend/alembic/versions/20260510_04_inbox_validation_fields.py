"""Add inbound invoice validation fields

Revision ID: 20260510_04
Revises: 20260510_03
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260510_04"
down_revision = "20260510_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.add_column("inbound_invoices", sa.Column("total_ex_vat", sa.Numeric(12, 2), nullable=True))
        op.add_column("inbound_invoices", sa.Column("total_vat", sa.Numeric(12, 2), nullable=True))
        op.add_column("inbound_invoices", sa.Column("facturx_profile", sa.String(), nullable=True))
        op.add_column("inbound_invoices", sa.Column("validation_status", sa.String(), nullable=True))
        op.add_column("inbound_invoices", sa.Column("validation_errors", sa.JSON(), nullable=True))
        op.add_column("inbound_invoices", sa.Column("validation_warnings", sa.JSON(), nullable=True))
        op.add_column("inbound_invoices", sa.Column("validated_at", sa.DateTime(), nullable=True))
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_column("inbound_invoices", "validated_at")
        op.drop_column("inbound_invoices", "validation_warnings")
        op.drop_column("inbound_invoices", "validation_errors")
        op.drop_column("inbound_invoices", "validation_status")
        op.drop_column("inbound_invoices", "facturx_profile")
        op.drop_column("inbound_invoices", "total_vat")
        op.drop_column("inbound_invoices", "total_ex_vat")
    except Exception:
        pass
