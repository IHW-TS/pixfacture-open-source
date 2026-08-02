"""Add e-reporting status fields

Revision ID: 20260410_03
Revises: 20260410_02
Create Date: 2026-04-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260410_03"
down_revision = "20260410_02"
branch_labels = None
depends_on = None


def _safe_add_column(table: str, column: sa.Column) -> None:
    try:
        op.add_column(table, column)
    except Exception:
        pass


def _safe_create_index(name: str, table: str, columns: list[str]) -> None:
    try:
        op.create_index(name, table, columns)
    except Exception:
        pass


def upgrade() -> None:
    _safe_add_column("ereporting_events", sa.Column("provider_slug", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("status", sa.String(), nullable=False, server_default="pending"))
    _safe_add_column("ereporting_events", sa.Column("external_id", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("payload_hash", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("client_country", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("client_vat_number", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("client_type", sa.String(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
    _safe_add_column("ereporting_events", sa.Column("last_attempt_at", sa.DateTime(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("next_retry_at", sa.DateTime(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("sent_at", sa.DateTime(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("error_message", sa.Text(), nullable=True))
    _safe_add_column("ereporting_events", sa.Column("updated_at", sa.DateTime(), nullable=True))

    _safe_create_index("ix_ereporting_events_external_id", "ereporting_events", ["external_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_ereporting_events_external_id", table_name="ereporting_events")
    except Exception:
        pass

    for column in [
        "updated_at",
        "error_message",
        "sent_at",
        "next_retry_at",
        "last_attempt_at",
        "attempts",
        "client_type",
        "client_vat_number",
        "client_country",
        "payload_hash",
        "external_id",
        "status",
        "provider_slug",
    ]:
        try:
            op.drop_column("ereporting_events", column)
        except Exception:
            pass
