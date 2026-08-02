"""Add e-reporting reports and lines

Revision ID: 20260510_03
Revises: 20260510_02
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260510_03"
down_revision = "20260510_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.create_table(
            "ereporting_reports",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False, index=True),
            sa.Column("provider_slug", sa.String(), nullable=True),
            sa.Column("report_type", sa.String(), nullable=False),
            sa.Column("period_start", sa.Date(), nullable=False),
            sa.Column("period_end", sa.Date(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("external_id", sa.String(), nullable=True, index=True),
            sa.Column("idempotency_hash", sa.String(), nullable=False, index=True),
            sa.Column("payload_hash", sa.String(), nullable=True),
            sa.Column("line_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
            sa.Column("next_retry_at", sa.DateTime(), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_table(
            "ereporting_lines",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("report_id", sa.String(), sa.ForeignKey("ereporting_reports.id"), nullable=False, index=True),
            sa.Column("source_type", sa.String(), nullable=False),
            sa.Column("source_id", sa.String(), nullable=True, index=True),
            sa.Column("event_type", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("payload_hash", sa.String(), nullable=True),
            sa.Column("amounts", sa.JSON(), nullable=True),
            sa.Column("payment_date", sa.Date(), nullable=True),
            sa.Column("country", sa.String(), nullable=True),
            sa.Column("client_country", sa.String(), nullable=True),
            sa.Column("client_vat_number", sa.String(), nullable=True),
            sa.Column("client_type", sa.String(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_table("ereporting_lines")
    except Exception:
        pass
    try:
        op.drop_table("ereporting_reports")
    except Exception:
        pass
