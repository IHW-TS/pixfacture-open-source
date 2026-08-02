"""Add legal acceptances table

Revision ID: 20260609_00
Revises: 20260608_00
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa


revision = "20260609_00"
down_revision = "20260608_00"
branch_labels = None
depends_on = None


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "legal_acceptances"):
        return
    op.create_table(
        "legal_acceptances",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("doc_slug", sa.String(), nullable=False),
        sa.Column("doc_version", sa.String(), nullable=False),
        sa.Column("accepted_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.UniqueConstraint("tenant_id", "user_id", "doc_slug", "doc_version", name="uniq_legal_acceptance"),
    )
    op.create_index("ix_legal_acceptance_tenant_doc", "legal_acceptances", ["tenant_id", "doc_slug"])
    op.create_index("ix_legal_acceptances_tenant_id", "legal_acceptances", ["tenant_id"])
    op.create_index("ix_legal_acceptances_user_id", "legal_acceptances", ["user_id"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "legal_acceptances"):
        return
    op.drop_index("ix_legal_acceptances_user_id", table_name="legal_acceptances")
    op.drop_index("ix_legal_acceptances_tenant_id", table_name="legal_acceptances")
    op.drop_index("ix_legal_acceptance_tenant_doc", table_name="legal_acceptances")
    op.drop_table("legal_acceptances")
