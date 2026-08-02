#!/usr/bin/env python
from __future__ import annotations

import argparse

from app.db import SessionLocal
from app.models import InboundInvoice, InboundInvoiceAttachment
from app.services.storage import head_object
from sqlalchemy import func


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill size_bytes for purchase/inbox attachments.")
    parser.add_argument("--tenant-id", default=None, help="Limit the backfill to one tenant id.")
    parser.add_argument("--limit", type=int, default=500, help="Maximum rows to inspect in one run.")
    parser.add_argument("--dry-run", action="store_true", help="Inspect storage without updating the database.")
    args = parser.parse_args()

    inspected = 0
    updated = 0
    missing = 0
    db = SessionLocal()
    try:
        query = (
            db.query(InboundInvoiceAttachment)
            .join(InboundInvoice, InboundInvoice.id == InboundInvoiceAttachment.inbound_invoice_id)
            .filter(func.coalesce(InboundInvoiceAttachment.size_bytes, 0) <= 0)
            .order_by(InboundInvoiceAttachment.created_at.asc())
        )
        if args.tenant_id:
            query = query.filter(InboundInvoice.tenant_id == args.tenant_id)
        for row in query.limit(max(1, args.limit)).all():
            inspected += 1
            if not row.storage_key:
                missing += 1
                continue
            meta = head_object(row.storage_key)
            if not meta or not meta.size:
                missing += 1
                continue
            row.size_bytes = int(meta.size)
            updated += 1
            if not args.dry_run:
                db.add(row)
        if args.dry_run:
            db.rollback()
        else:
            db.commit()
    finally:
        db.close()
    print(f"inspected={inspected} updated={updated} missing={missing} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
