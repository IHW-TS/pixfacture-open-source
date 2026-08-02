"""Add email event delivery mode

Revision ID: 20260722_email_delivery_mode
Revises: 20260721_accounting_exports
Create Date: 2026-07-22 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260722_email_delivery_mode"
down_revision = "20260721_accounting_exports"
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
    if not _column_exists(conn, "email_events", "delivery_mode"):
        op.add_column(
            "email_events",
            sa.Column("delivery_mode", sa.String(), nullable=False, server_default="smtp"),
        )
    if not _index_exists(conn, "email_events", "ix_email_events_delivery_mode"):
        op.create_index("ix_email_events_delivery_mode", "email_events", ["delivery_mode"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "email_events"):
        return
    if _index_exists(conn, "email_events", "ix_email_events_delivery_mode"):
        op.drop_index("ix_email_events_delivery_mode", table_name="email_events")
    if _column_exists(conn, "email_events", "delivery_mode"):
        op.drop_column("email_events", "delivery_mode")
