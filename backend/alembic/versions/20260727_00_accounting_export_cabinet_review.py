"""Add accounting export cabinet review status

Revision ID: 20260727_export_cabinet_review
Revises: 20260726_supplier_vat_rules2
Create Date: 2026-05-19 16:45:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260727_export_cabinet_review"
down_revision = "20260726_supplier_vat_rules2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounting_exports", sa.Column("cabinet_validation_status", sa.String(), nullable=True))
    op.add_column("accounting_exports", sa.Column("cabinet_reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("accounting_exports", sa.Column("cabinet_reviewed_by", sa.String(), nullable=True))
    op.execute(
        "UPDATE accounting_exports "
        "SET cabinet_validation_status = 'pending_review' "
        "WHERE cabinet_validation_status IS NULL"
    )
    op.alter_column("accounting_exports", "cabinet_validation_status", nullable=False)
    op.create_foreign_key(
        "fk_accounting_exports_cabinet_reviewed_by_users",
        "accounting_exports",
        "users",
        ["cabinet_reviewed_by"],
        ["id"],
    )
    op.create_index(
        "ix_accounting_exports_tenant_validation",
        "accounting_exports",
        ["tenant_id", "cabinet_validation_status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_accounting_exports_tenant_validation", table_name="accounting_exports")
    op.drop_constraint("fk_accounting_exports_cabinet_reviewed_by_users", "accounting_exports", type_="foreignkey")
    op.drop_column("accounting_exports", "cabinet_reviewed_by")
    op.drop_column("accounting_exports", "cabinet_reviewed_at")
    op.drop_column("accounting_exports", "cabinet_validation_status")
