"""Add token wallet tables

Revision ID: 20260526_00
Revises: 20260525_00
Create Date: 2026-05-26
"""

from alembic import op
import sqlalchemy as sa

revision = "20260526_00"
down_revision = "20260525_00"
branch_labels = None
depends_on = None


def _safe_create_index(name: str, table: str, columns: list[str]) -> None:
    try:
        op.create_index(name, table, columns)
    except Exception:
        pass


def upgrade() -> None:
    try:
        op.create_table(
            "token_wallets",
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), primary_key=True),
            sa.Column("balance", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    try:
        op.create_table(
            "token_topups",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("stripe_session_id", sa.String(), nullable=False),
            sa.Column("stripe_payment_intent_id", sa.String(), nullable=True),
            sa.Column("tokens", sa.Integer(), nullable=False),
            sa.Column("amount_eur", sa.Numeric(10, 2), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("stripe_session_id", name="uniq_token_topups_session"),
        )
    except Exception:
        pass

    try:
        op.create_table(
            "token_ledger",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("delta", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("reference_type", sa.String(), nullable=False),
            sa.Column("reference_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("tenant_id", "reference_type", "reference_id", name="uniq_token_ledger_ref"),
        )
    except Exception:
        pass

    _safe_create_index("ix_token_topups_tenant_id", "token_topups", ["tenant_id"])
    _safe_create_index("ix_token_topups_stripe_session_id", "token_topups", ["stripe_session_id"])
    _safe_create_index("ix_token_topups_stripe_payment_intent_id", "token_topups", ["stripe_payment_intent_id"])
    _safe_create_index("ix_token_ledger_tenant_id", "token_ledger", ["tenant_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_token_ledger_tenant_id", table_name="token_ledger")
    except Exception:
        pass
    try:
        op.drop_index("ix_token_topups_stripe_payment_intent_id", table_name="token_topups")
    except Exception:
        pass
    try:
        op.drop_index("ix_token_topups_stripe_session_id", table_name="token_topups")
    except Exception:
        pass
    try:
        op.drop_index("ix_token_topups_tenant_id", table_name="token_topups")
    except Exception:
        pass
    try:
        op.drop_table("token_ledger")
    except Exception:
        pass
    try:
        op.drop_table("token_topups")
    except Exception:
        pass
    try:
        op.drop_table("token_wallets")
    except Exception:
        pass
