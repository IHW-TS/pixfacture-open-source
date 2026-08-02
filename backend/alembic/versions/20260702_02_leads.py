"""Add leads table

Revision ID: 20260702_02
Revises: 20260702_01
Create Date: 2026-01-29
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_02"
down_revision = "20260702_01"
branch_labels = None
depends_on = None


def _table_exists(conn, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in inspector.get_table_names()


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "leads"):
        op.create_table(
            "leads",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("company", sa.String(), nullable=True),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("source", sa.String(), nullable=True),
            sa.Column("utm_source", sa.String(), nullable=True),
            sa.Column("utm_medium", sa.String(), nullable=True),
            sa.Column("utm_campaign", sa.String(), nullable=True),
            sa.Column("utm_term", sa.String(), nullable=True),
            sa.Column("utm_content", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("ip", sa.String(), nullable=True),
            sa.Column("user_agent", sa.Text(), nullable=True),
        )
    if _table_exists(conn, "leads"):
        if not _index_exists(conn, "leads", "ix_leads_created_at"):
            op.create_index("ix_leads_created_at", "leads", ["created_at"])
        if not _index_exists(conn, "leads", "ix_leads_email"):
            op.create_index("ix_leads_email", "leads", ["email"])


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "leads"):
        if _index_exists(conn, "leads", "ix_leads_email"):
            op.drop_index("ix_leads_email", table_name="leads")
        if _index_exists(conn, "leads", "ix_leads_created_at"):
            op.drop_index("ix_leads_created_at", table_name="leads")
        op.drop_table("leads")
