from __future__ import annotations

import re
from typing import Any


_LEGAL_NOTE_RE = re.compile(
    r"(TVA (?:sur les encaissements|sur les d[ée]bits|exigible|non applicable|acquitt[ée]e d['’]apr[èe]s les d[ée]bits)|"
    r"Option pour le paiement de la taxe d['’]apr[èe]s les d[ée]bits|"
    r"p[ée]nalit[ée]s (?:de retard|au taux|pour retard)|"
    r"retard de paiement|"
    r"indemnit[ée] forfaitaire|"
    r"recouvrement de\s+\d+|"
    r"taux\s+BCE|"
    r"escompte pour paiement anticip[ée]|aucun escompte|"
    r"late penalties|fixed recovery fee|no early payment discount|"
    r"devis valable|bon pour accord|quote valid|approved)",
    flags=re.IGNORECASE,
)


def looks_like_generated_legal_note(value: Any) -> bool:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if not text:
        return False
    return bool(_LEGAL_NOTE_RE.search(text))


def visible_document_note(note: Any, document_title: Any = None, extra_note: Any = None) -> str | None:
    title = str(document_title or "").strip()
    blocks = [block.strip() for block in re.split(r"\n{2,}", str(note or "")) if block.strip()]
    extra_blocks = [block.strip() for block in re.split(r"\n{2,}", str(extra_note or "")) if block.strip()]
    blocks.extend(extra_blocks)
    seen: set[str] = set()
    visible_blocks = [
        block
        for block in blocks
        if block != title
        and not looks_like_generated_legal_note(block)
        and not (block in seen or seen.add(block))
    ]
    return "\n\n".join(visible_blocks) or None
