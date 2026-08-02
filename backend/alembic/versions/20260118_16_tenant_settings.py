"""Add tenant settings

Revision ID: 20260118_16
Revises: 20260117_15
Create Date: 2026-01-18
"""

from alembic import op
import sqlalchemy as sa

revision = "20260118_16"
down_revision = "20260117_15"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.create_table(
            "tenant_settings",
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), primary_key=True),
            sa.Column("preset", sa.String(), nullable=False),
            sa.Column("features", sa.JSON(), nullable=False),
            sa.Column("onboarding_completed", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_table("tenant_settings")
    except Exception:
        pass
