"""Patch schema: token_version, siret, TVA débits, livraison, stripe_events

Revision ID: 20251213_01
Revises: 20250101_00
Create Date: 2025-01-01
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "20251213_01"
down_revision = "20250101_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
        """
    )
    op.execute(
        """
        ALTER TABLE public.customers
        ADD COLUMN IF NOT EXISTS siret varchar,
        ADD COLUMN IF NOT EXISTS siren varchar;
        """
    )
    op.execute(
        """
        ALTER TABLE public.tenants
        ADD COLUMN IF NOT EXISTS vat_on_debits boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS late_payment_interest text,
        ADD COLUMN IF NOT EXISTS recovery_fee_eur numeric(10,2) NOT NULL DEFAULT 40,
        ADD COLUMN IF NOT EXISTS discount_terms text;
        """
    )
    op.execute(
        """
        ALTER TABLE public.invoices
        ADD COLUMN IF NOT EXISTS delivery_address text,
        ADD COLUMN IF NOT EXISTS operation_nature varchar NOT NULL DEFAULT 'services';
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.stripe_events (
            id varchar PRIMARY KEY,
            event_id varchar UNIQUE NOT NULL,
            received_at timestamp NOT NULL DEFAULT now(),
            processed_at timestamp NULL
        );
        """
    )


def downgrade() -> None:
    # Downgrade non destructif pour conserver la compatibilité existante
    pass
