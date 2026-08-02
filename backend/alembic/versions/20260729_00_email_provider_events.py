"""Add provider fields to email events

Revision ID: 20260729_email_provider_events
Revises: 20260728_cust_supplier_rel
Create Date: 2026-05-19 19:20:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260729_email_provider_events"
down_revision = "20260728_cust_supplier_rel"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "email_events"):
        return

    columns = [
        ("provider", sa.Column("provider", sa.String(), nullable=True)),
        ("provider_message_id", sa.Column("provider_message_id", sa.String(), nullable=True)),
        ("provider_event_id", sa.Column("provider_event_id", sa.String(), nullable=True)),
        ("provider_status", sa.Column("provider_status", sa.String(), nullable=True)),
        ("provider_event_at", sa.Column("provider_event_at", sa.DateTime(), nullable=True)),
    ]
    for column_name, column in columns:
        if not _column_exists(conn, "email_events", column_name):
            op.add_column("email_events", column)

    indexes = [
        ("ix_email_events_provider", ["provider"]),
        ("ix_email_events_provider_message_id", ["provider_message_id"]),
        ("ix_email_events_provider_event_id", ["provider_event_id"]),
    ]
    for index_name, column_names in indexes:
        if not _index_exists(conn, "email_events", index_name):
            op.create_index(index_name, "email_events", column_names, unique=False)


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "email_events"):
        return

    for index_name in (
        "ix_email_events_provider_event_id",
        "ix_email_events_provider_message_id",
        "ix_email_events_provider",
    ):
        if _index_exists(conn, "email_events", index_name):
            op.drop_index(index_name, table_name="email_events")

    for column_name in (
        "provider_event_at",
        "provider_status",
        "provider_event_id",
        "provider_message_id",
        "provider",
    ):
        if _column_exists(conn, "email_events", column_name):
            op.drop_column("email_events", column_name)
