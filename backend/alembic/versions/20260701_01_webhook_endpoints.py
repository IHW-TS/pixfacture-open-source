"""Add webhook endpoints

Revision ID: 20260701_01
Revises: 20260701_00
Create Date: 2026-07-01
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260701_01"
down_revision = "20260701_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
            id varchar PRIMARY KEY,
            tenant_id varchar NOT NULL REFERENCES public.tenants(id),
            url text NOT NULL,
            status varchar NOT NULL DEFAULT 'active',
            events json NOT NULL DEFAULT '[]'::json,
            encrypted_secret bytea NULL,
            last_status_code integer NULL,
            last_success_at timestamp NULL,
            last_failure_at timestamp NULL,
            last_error_message text NULL,
            created_at timestamp NOT NULL DEFAULT now(),
            updated_at timestamp NOT NULL DEFAULT now()
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_webhook_endpoints_tenant
        ON public.webhook_endpoints (tenant_id);
        """
    )


def downgrade() -> None:
    # Downgrade non destructif pour conserver la compatibilite existante
    pass
