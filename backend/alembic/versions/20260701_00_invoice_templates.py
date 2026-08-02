"""Add invoice template fields

Revision ID: 20260701_00
Revises: 20251213_01
Create Date: 2026-07-01
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260701_00"
down_revision = "20251213_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE public.invoices
        ADD COLUMN IF NOT EXISTS template_key varchar,
        ADD COLUMN IF NOT EXISTS template_options json;
        """
    )


def downgrade() -> None:
    # Downgrade non destructif pour conserver la compatibilite existante
    pass
