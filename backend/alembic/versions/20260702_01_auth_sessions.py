"""Add auth sessions table

Revision ID: 20260702_01
Revises: 20260702_00
Create Date: 2026-01-29
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_01"
down_revision = "20260702_00"
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
    if not _table_exists(conn, "auth_sessions"):
        op.create_table(
            "auth_sessions",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("refresh_jti_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("last_used_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
            sa.Column("user_agent", sa.Text(), nullable=True),
            sa.Column("ip", sa.String(), nullable=True),
        )
    if _table_exists(conn, "auth_sessions"):
        if not _index_exists(conn, "auth_sessions", "ix_auth_sessions_user_id"):
            op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
        if not _index_exists(conn, "auth_sessions", "ix_auth_sessions_tenant_id"):
            op.create_index("ix_auth_sessions_tenant_id", "auth_sessions", ["tenant_id"])
        if not _index_exists(conn, "auth_sessions", "ix_auth_sessions_refresh_jti_hash"):
            op.create_index("ix_auth_sessions_refresh_jti_hash", "auth_sessions", ["refresh_jti_hash"])


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "auth_sessions"):
        if _index_exists(conn, "auth_sessions", "ix_auth_sessions_refresh_jti_hash"):
            op.drop_index("ix_auth_sessions_refresh_jti_hash", table_name="auth_sessions")
        if _index_exists(conn, "auth_sessions", "ix_auth_sessions_tenant_id"):
            op.drop_index("ix_auth_sessions_tenant_id", table_name="auth_sessions")
        if _index_exists(conn, "auth_sessions", "ix_auth_sessions_user_id"):
            op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
        op.drop_table("auth_sessions")
