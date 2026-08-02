"use client";

import { useEffect, useCallback } from "react";

/**
 * Hook to warn users before navigating away from a page with unsaved changes.
 * Attaches a `beforeunload` event when `dirty` is true.
 *
 * Usage:
 *   const [dirty, setDirty] = useState(false);
 *   useUnsavedChanges(dirty);
 */
export function useUnsavedChanges(dirty: boolean, message?: string) {
  const handler = useCallback(
    (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      // Modern browsers ignore custom messages but require returnValue
      e.returnValue = message || "Vous avez des modifications non enregistrées. Quitter quand même ?";
    },
    [dirty, message],
  );

  useEffect(() => {
    if (!dirty) return;
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, handler]);
}
