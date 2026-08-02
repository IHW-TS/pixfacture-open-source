"""Add durable customer webhook delivery outbox.

Revision ID: 20260818_webhook_outbox
Revises: 20260817_chorus_pilot_binding
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260818_webhook_outbox"
down_revision = "20260817_chorus_pilot_binding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "webhook_delivery_outbox",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("endpoint_id", sa.String(), nullable=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="8"),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("locked_at", sa.DateTime(), nullable=True),
        sa.Column("lock_token", sa.String(), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.Column("last_status_code", sa.Integer(), nullable=True),
        sa.Column("last_error_code", sa.String(), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "status IN ('pending', 'queued', 'processing', 'retry', 'delivered', 'failed', 'cancelled')",
            name="ck_webhook_delivery_status",
        ),
        sa.CheckConstraint("attempt_count >= 0", name="ck_webhook_delivery_attempt_count"),
        sa.CheckConstraint("max_attempts > 0", name="ck_webhook_delivery_max_attempts"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(
            ["endpoint_id"],
            ["webhook_endpoints.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "idempotency_key",
            name="uniq_webhook_delivery_idempotency",
        ),
    )
    op.create_index(
        "ix_webhook_delivery_outbox_tenant_id",
        "webhook_delivery_outbox",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        "ix_webhook_delivery_outbox_endpoint_id",
        "webhook_delivery_outbox",
        ["endpoint_id"],
        unique=False,
    )
    op.create_index(
        "ix_webhook_delivery_outbox_event_id",
        "webhook_delivery_outbox",
        ["event_id"],
        unique=False,
    )
    op.create_index(
        "ix_webhook_delivery_due",
        "webhook_delivery_outbox",
        ["status", "next_attempt_at", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_webhook_delivery_tenant_status",
        "webhook_delivery_outbox",
        ["tenant_id", "status", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_delivery_tenant_status", table_name="webhook_delivery_outbox")
    op.drop_index("ix_webhook_delivery_due", table_name="webhook_delivery_outbox")
    op.drop_index("ix_webhook_delivery_outbox_event_id", table_name="webhook_delivery_outbox")
    op.drop_index("ix_webhook_delivery_outbox_endpoint_id", table_name="webhook_delivery_outbox")
    op.drop_index("ix_webhook_delivery_outbox_tenant_id", table_name="webhook_delivery_outbox")
    op.drop_table("webhook_delivery_outbox")
