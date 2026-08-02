"""Add MFA columns to users

Revision ID: 20260701_02
Revises: 20260701_01
Create Date: 2026-07-01
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260701_02"
down_revision = "20260701_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS mfa_secret bytea,
        ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamp;
        """
    )


def downgrade() -> None:
    # Downgrade non destructif pour conserver la compatibilite existante
    pass
