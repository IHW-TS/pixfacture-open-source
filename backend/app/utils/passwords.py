"""Shared password hashing policy.

``bcrypt_sha256`` pre-hashes the complete password before invoking bcrypt, so
passwords longer than bcrypt's 72-byte input limit remain distinct.  Plain
``bcrypt`` stays in the context only to verify hashes created before this
policy was introduced; ``verify_and_update`` transparently upgrades them
after a successful password login.
"""

from passlib.context import CryptContext


pwd = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
)
