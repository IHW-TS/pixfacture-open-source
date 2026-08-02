"""harden customer portal defaults

Revision ID: 20260806_harden_portal_defaults
Revises: 20260805_purchase_workflow
Create Date: 2026-06-10
"""

from __future__ import annotations

import json
from typing import Any

from alembic import op
import sqlalchemy as sa


revision = "20260806_harden_portal_defaults"
down_revision = "20260805_purchase_workflow"
branch_labels = None
depends_on = None


def _decode_features(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "tenant_settings" not in inspector.get_table_names():
        return

    rows = conn.execute(sa.text("SELECT tenant_id, features FROM tenant_settings")).mappings().all()
    update_stmt = sa.text(
        "UPDATE tenant_settings SET features = :features WHERE tenant_id = :tenant_id"
    ).bindparams(sa.bindparam("features", type_=sa.JSON()))

    for row in rows:
        features = _decode_features(row.get("features"))
        portal = features.get("portal")
        if not isinstance(portal, dict):
            portal = {}
        else:
            portal = dict(portal)

        portal["show_all_documents"] = bool(portal.get("show_all_documents", False))
        if portal.get("quote_convert_mode") in (None, "", "create_draft"):
            portal["quote_convert_mode"] = "disabled"
        if portal.get("quote_convert_mode") == "auto_issue":
            portal["quote_convert_mode"] = "create_draft"

        features["portal"] = portal
        conn.execute(update_stmt, {"tenant_id": row["tenant_id"], "features": features})


def downgrade() -> None:
    # Non-destructive downgrade: keep hardened public portal settings in place.
    return
