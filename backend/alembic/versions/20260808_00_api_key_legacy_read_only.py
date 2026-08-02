"""Narrow legacy API key scopes to read-only defaults.

Revision ID: 20260808_api_key_read_only
Revises: 20260807_sales_amount_precision
Create Date: 2026-06-14
"""

from __future__ import annotations

import json
from typing import Any

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260808_api_key_read_only"
down_revision = "20260807_sales_amount_precision"
branch_labels = None
depends_on = None


LEGACY_FULL_SCOPES = [
    "read:invoices",
    "write:invoices",
    "read:customers",
    "write:customers",
    "read:jobs",
]

READ_ONLY_SCOPES = [
    "read:invoices",
    "read:customers",
    "read:jobs",
]
LEGACY_FULL_SCOPE_SET = set(LEGACY_FULL_SCOPES)


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB, "postgresql")


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    if table not in inspector.get_table_names():
        return False
    return column in {col["name"] for col in inspector.get_columns(table)}


def _normalize_scopes(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value.split(",")
    else:
        parsed = value
    if not isinstance(parsed, (list, tuple, set)):
        return []
    return [str(item).strip().lower() for item in parsed if str(item).strip()]


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "api_keys", "scopes"):
        return
    api_keys = sa.table(
        "api_keys",
        sa.column("id", sa.String()),
        sa.column("scopes", _json_type()),
    )
    rows = conn.execute(sa.select(api_keys.c.id, api_keys.c.scopes)).mappings().all()
    for row in rows:
        scopes = _normalize_scopes(row["scopes"])
        if set(scopes) == LEGACY_FULL_SCOPE_SET:
            conn.execute(
                api_keys.update()
                .where(api_keys.c.id == row["id"])
                .values(scopes=READ_ONLY_SCOPES)
            )


def downgrade() -> None:
    # Do not re-grant write scopes automatically on downgrade.
    return
