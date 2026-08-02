import type { SessionUser } from "./types";

type InternalUserLike = Pick<SessionUser, "is_admin" | "is_support"> | null | undefined;

export const isInternalUser = (user?: InternalUserLike | null) => {
  return Boolean(user?.is_admin || user?.is_support);
};

let internalUser = false;

export const setInternalUser = (user?: InternalUserLike | null) => {
  internalUser = isInternalUser(user);
};

export const getInternalUser = () => internalUser;
