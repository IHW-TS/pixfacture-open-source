"""Add durable/idempotent e-invoicing submission outbox state.

Revision ID: 20260814_chorus_outbox
Revises: 20260813_quote_duplicate_lineage
"""

from alembic import op
import sqlalchemy as sa


revision = "20260814_chorus_outbox"
down_revision = "20260813_quote_duplicate_lineage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("einvoicing_transmissions", sa.Column("idempotency_key", sa.String(), nullable=True))
    op.add_column(
        "einvoicing_transmissions",
        sa.Column("delivery_state", sa.String(), nullable=False, server_default="pending"),
    )
    op.add_column(
        "einvoicing_transmissions",
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("einvoicing_transmissions", sa.Column("last_attempt_at", sa.DateTime(), nullable=True))

    # Historical rows may contain legitimate repeated attempts. Give each one a
    # unique legacy key, while all new rows use the deterministic logical key.
    op.execute(
        sa.text(
            "UPDATE einvoicing_transmissions "
            "SET idempotency_key = 'legacy:' || id "
            "WHERE idempotency_key IS NULL"
        )
    )
    op.execute(
        sa.text(
            "UPDATE einvoicing_transmissions "
            "SET delivery_state = CASE "
            "WHEN lower(status) IN ('failed', 'rejected', 'refused') THEN 'failed' "
            "WHEN external_id IS NOT NULL THEN 'delivered' "
            "ELSE 'reconciliation_required' END"
        )
    )
    op.create_index(
        "uniq_einvoicing_transmission_idempotency",
        "einvoicing_transmissions",
        ["idempotency_key"],
        unique=True,
    )
    op.create_index(
        "ix_einvoicing_transmissions_delivery_state",
        "einvoicing_transmissions",
        ["delivery_state", "updated_at"],
        unique=False,
    )
    op.create_table(
        "einvoicing_action_outbox",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("transmission_id", sa.String(), nullable=True),
        sa.Column("provider_slug", sa.String(), nullable=False),
        sa.Column("external_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, server_default="submitting"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["transmission_id"], ["einvoicing_transmissions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uniq_einvoicing_action_idempotency"),
    )
    op.create_index(
        "ix_einvoicing_action_outbox_tenant_id",
        "einvoicing_action_outbox",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        "ix_einvoicing_action_outbox_transmission_id",
        "einvoicing_action_outbox",
        ["transmission_id"],
        unique=False,
    )
    op.create_index(
        "ix_einvoicing_action_outbox_tenant_state",
        "einvoicing_action_outbox",
        ["tenant_id", "state", "updated_at"],
        unique=False,
    )
def downgrade() -> None:
    op.drop_index("ix_einvoicing_action_outbox_tenant_state", table_name="einvoicing_action_outbox")
    op.drop_index("ix_einvoicing_action_outbox_transmission_id", table_name="einvoicing_action_outbox")
    op.drop_index("ix_einvoicing_action_outbox_tenant_id", table_name="einvoicing_action_outbox")
    op.drop_table("einvoicing_action_outbox")
    op.drop_index("ix_einvoicing_transmissions_delivery_state", table_name="einvoicing_transmissions")
    op.drop_index("uniq_einvoicing_transmission_idempotency", table_name="einvoicing_transmissions")
    op.drop_column("einvoicing_transmissions", "last_attempt_at")
    op.drop_column("einvoicing_transmissions", "attempt_count")
    op.drop_column("einvoicing_transmissions", "delivery_state")
    op.drop_column("einvoicing_transmissions", "idempotency_key")
