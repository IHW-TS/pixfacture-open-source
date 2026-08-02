from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_viewer_or_admin
from ..models import Customer, CustomerContact, Invoice, Quote, Product


router = APIRouter(prefix="/api/search", tags=["search"])


class SearchResult(BaseModel):
    type: str  # customer|invoice|quote|item|credit_note
    id: str
    title: str
    subtitle: str | None = None
    url: str


class SearchResponse(BaseModel):
    q: str
    results: list[SearchResult]


def _like(term: str) -> str:
    return f"%{term.lower()}%"


@router.get("", response_model=SearchResponse)
def search(
    q: str = Query("", min_length=0, max_length=120),
    limit: int = Query(20, ge=5, le=50),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    term = (q or "").strip()
    if not term:
        return SearchResponse(q="", results=[])

    like = _like(term)

    results: list[SearchResult] = []

    # Customers (name, email, SIRET/SIREN, contacts)
    cust_ids_by_contact = (
        db.query(CustomerContact.customer_id)
        .filter(CustomerContact.tenant_id == user.tenant_id)
        .filter(func.lower(CustomerContact.email).like(like))
        .limit(50)
        .all()
    )
    cust_ids = [cid for (cid,) in cust_ids_by_contact]

    customers_filters = [
        func.lower(Customer.name).like(like),
        func.lower(Customer.email).like(like),
        func.lower(Customer.siret).like(like),
        func.lower(Customer.siren).like(like),
    ]
    if cust_ids:
        customers_filters.append(Customer.id.in_(cust_ids))

    customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == user.tenant_id)
        .filter(or_(*customers_filters))
        .order_by(Customer.created_at.desc())
        .limit(8)
        .all()
    )
    for c in customers:
        if not c.id:
            continue
        subtitle = (c.email or c.siret or c.siren or "").strip() or None
        results.append(
            SearchResult(
                type="customer",
                id=c.id,
                title=c.name or "Client",
                subtitle=subtitle,
                url=f"/app/customers/{c.id}",
            )
        )

    # Invoices + credit notes by number / PO
    inv_rows = (
        db.query(Invoice, Customer)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(
            or_(
                func.lower(Invoice.number).like(like),
                func.lower(Invoice.purchase_order_number).like(like),
                func.lower(Customer.name).like(like),
            )
        )
        .order_by(Invoice.created_at.desc())
        .limit(8)
        .all()
    )
    for inv, c in inv_rows:
        doc_label = "Avoir" if inv.type == "credit_note" else "Facture"
        title = f"{doc_label} {inv.number or ''}".strip()
        subtitle = f"{(c.name or '').strip()} • {inv.status}".strip(" •") or None
        kind = "credit_note" if inv.type == "credit_note" else "invoice"
        results.append(
            SearchResult(type=kind, id=inv.id, title=title, subtitle=subtitle, url=f"/app/invoices/{inv.id}")
        )

    # Quotes
    quote_rows = (
        db.query(Quote, Customer)
        .join(Customer, Customer.id == Quote.customer_id)
        .filter(Quote.tenant_id == user.tenant_id)
        .filter(or_(func.lower(Quote.number).like(like), func.lower(Customer.name).like(like)))
        .order_by(Quote.created_at.desc())
        .limit(8)
        .all()
    )
    for qt, c in quote_rows:
        title = f"Devis {qt.number or ''}".strip()
        subtitle = f"{(c.name or '').strip()} • {qt.status}".strip(" •") or None
        results.append(SearchResult(type="quote", id=qt.id, title=title, subtitle=subtitle, url=f"/app/quotes/{qt.id}"))

    # Items
    items = (
        db.query(Product)
        .filter(Product.tenant_id == user.tenant_id)
        .filter(or_(func.lower(Product.name).like(like), func.lower(Product.description).like(like)))
        .order_by(Product.created_at.desc())
        .limit(6)
        .all()
    )
    for it in items:
        if not it.id:
            continue
        subtitle = (it.description or "").strip() or None
        results.append(
            SearchResult(
                type="item",
                id=it.id,
                title=it.name or "Article",
                subtitle=subtitle,
                url=f"/app/items?highlight={it.id}",
            )
        )

    # Dedup & cap
    dedup: list[SearchResult] = []
    seen: set[str] = set()
    for r in results:
        key = f"{r.type}:{r.id}"
        if key in seen:
            continue
        seen.add(key)
        dedup.append(r)
        if len(dedup) >= limit:
            break

    return SearchResponse(q=term, results=dedup)
