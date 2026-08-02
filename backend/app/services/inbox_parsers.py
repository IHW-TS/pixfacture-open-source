from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any


@dataclass
class InvoiceParseResult:
    format: str | None
    profile: str | None
    invoice_number: str | None
    issue_date: date | None
    supplier_name: str | None
    supplier_siren: str | None
    supplier_siret: str | None
    total_ex_vat: Decimal | None
    total_vat: Decimal | None
    total_ttc: Decimal | None
    currency: str | None
    validation_status: str
    validation_errors: list[str]
    validation_warnings: list[str]
    purchase_lines: list[dict[str, Any]] | None = None
