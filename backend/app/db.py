from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings


def _database_drivername(url: str) -> str:
    try:
        return make_url(url).drivername.lower()
    except Exception:
        return ""


def _is_sqlite_url(url: str) -> bool:
    return _database_drivername(url).startswith("sqlite")


def _is_postgres_url(url: str) -> bool:
    driver = _database_drivername(url)
    return driver.startswith("postgresql") or driver.startswith("postgres")


def _postgres_connect_options() -> str:
    parts: list[str] = []
    statement_timeout = int(getattr(settings, "DB_STATEMENT_TIMEOUT_MS", 0) or 0)
    lock_timeout = int(getattr(settings, "DB_LOCK_TIMEOUT_MS", 0) or 0)
    app_name = (getattr(settings, "DB_APPLICATION_NAME", "") or "pixfacture-api").strip()
    if statement_timeout > 0:
        parts.append(f"-c statement_timeout={statement_timeout}")
    if lock_timeout > 0:
        parts.append(f"-c lock_timeout={lock_timeout}")
    if app_name:
        parts.append(f"-c application_name={app_name}")
    return " ".join(parts)


def engine_kwargs(database_url: str | None = None) -> dict:
    url = database_url or settings.DATABASE_URL
    kwargs: dict = {"pool_pre_ping": True, "future": True}
    if not _is_sqlite_url(url):
        kwargs.update(
            {
                "pool_size": int(getattr(settings, "DB_POOL_SIZE", 10) or 10),
                "max_overflow": int(getattr(settings, "DB_MAX_OVERFLOW", 20) or 20),
                "pool_timeout": int(getattr(settings, "DB_POOL_TIMEOUT_SECONDS", 30) or 30),
                "pool_recycle": int(getattr(settings, "DB_POOL_RECYCLE_SECONDS", 1800) or 1800),
            }
        )
    if _is_postgres_url(url):
        options = _postgres_connect_options()
        if options:
            kwargs["connect_args"] = {"options": options}
    return kwargs


engine = create_engine(settings.DATABASE_URL, **engine_kwargs())
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
