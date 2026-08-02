"""Add transmission event tracking fields

Revision ID: 20260525_00
Revises: 20260524_00
Create Date: 2026-05-25
"""

from alembic import op
import sqlalchemy as sa

revision = "20260525_00"
down_revision = "20260524_00"
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
    _safe_add_column("transmission_events", sa.Column("correlation_id", sa.String(), nullable=True))
    _safe_add_column("transmission_events", sa.Column("provider_slug", sa.String(), nullable=True))
    _safe_add_column("transmission_events", sa.Column("external_id", sa.String(), nullable=True))
    _safe_create_index("ix_transmission_events_correlation_id", "transmission_events", ["correlation_id"])
    _safe_create_index("ix_transmission_events_provider_slug", "transmission_events", ["provider_slug"])
    _safe_create_index("ix_transmission_events_external_id", "transmission_events", ["external_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_transmission_events_external_id", table_name="transmission_events")
    except Exception:
        pass
    try:
        op.drop_index("ix_transmission_events_provider_slug", table_name="transmission_events")
    except Exception:
        pass
    try:
        op.drop_index("ix_transmission_events_correlation_id", table_name="transmission_events")
    except Exception:
        pass
    try:
        op.drop_column("transmission_events", "external_id")
    except Exception:
        pass
    try:
        op.drop_column("transmission_events", "provider_slug")
    except Exception:
        pass
    try:
        op.drop_column("transmission_events", "correlation_id")
    except Exception:
        pass
