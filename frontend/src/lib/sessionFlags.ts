const HAD_SESSION_KEY = "had_session";

export const setHadSession = () => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HAD_SESSION_KEY, "1");
  } catch {
    // ignore storage failures
  }
};

export const clearHadSession = () => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HAD_SESSION_KEY);
  } catch {
    // ignore storage failures
  }
};

export const hasHadSession = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HAD_SESSION_KEY) === "1";
  } catch {
    return false;
  }
};
