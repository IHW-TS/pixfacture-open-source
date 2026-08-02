from __future__ import annotations

import asyncio


class PdpProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        retryable: bool = False,
        submission_outcome: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.submission_outcome = submission_outcome


class PdpRetryableError(PdpProviderError):
    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message, code=code, retryable=True)


class PdpPreSubmitError(PdpProviderError):
    """Certain provider failure raised before an unsafe remote request starts."""

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False) -> None:
        super().__init__(
            message,
            code=code,
            retryable=retryable,
            submission_outcome="not_sent",
        )


class PdpPreSubmitCancelled(asyncio.CancelledError):
    """Cancellation known to have happened before an unsafe remote request."""

    submission_outcome = "not_sent"
