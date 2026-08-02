from __future__ import annotations

from collections import Counter
from threading import Lock

_LOCK = Lock()
_COUNTERS: Counter[str] = Counter()
_PDP_SUBMIT: Counter[str] = Counter()
_OPERATIONAL_EVENTS: Counter[str] = Counter()


def inc_login_success() -> None:
    _increment("login_success_total")


def inc_login_failure() -> None:
    _increment("login_failure_total")


def inc_invoice_export() -> None:
    _increment("invoice_export_total")


def inc_operational_event(event: str) -> None:
    label = (event or "unknown").strip().lower() or "unknown"
    with _LOCK:
        _OPERATIONAL_EVENTS[label] += 1


def inc_pdp_submit(provider: str | None) -> None:
    label = (provider or "unknown").strip().lower() or "unknown"
    with _LOCK:
        _PDP_SUBMIT[label] += 1


def _increment(name: str) -> None:
    with _LOCK:
        _COUNTERS[name] += 1


def snapshot() -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    with _LOCK:
        return dict(_COUNTERS), dict(_PDP_SUBMIT), dict(_OPERATIONAL_EVENTS)


def render_prometheus() -> str:
    counters, pdp_submit, operational_events = snapshot()
    lines: list[str] = []
    lines.append("# TYPE login_success_total counter")
    lines.append(f"login_success_total {counters.get('login_success_total', 0)}")
    lines.append("# TYPE login_failure_total counter")
    lines.append(f"login_failure_total {counters.get('login_failure_total', 0)}")
    lines.append("# TYPE invoice_export_total counter")
    lines.append(f"invoice_export_total {counters.get('invoice_export_total', 0)}")
    lines.append("# TYPE pdp_submit_total counter")
    if pdp_submit:
        for provider, count in sorted(pdp_submit.items()):
            safe_provider = provider.replace('"', "")
            lines.append(f'pdp_submit_total{{provider="{safe_provider}"}} {count}')
    else:
        lines.append('pdp_submit_total{provider="unknown"} 0')
    lines.append("# TYPE pixfacture_operational_events_total counter")
    if operational_events:
        for event, count in sorted(operational_events.items()):
            safe_event = event.replace('"', "")
            lines.append(f'pixfacture_operational_events_total{{event="{safe_event}"}} {count}')
    else:
        lines.append('pixfacture_operational_events_total{event="unknown"} 0')
    lines.append("")
    return "\n".join(lines)
