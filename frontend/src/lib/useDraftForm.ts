import { useCallback, useEffect, useRef, useState } from "react";
import { clearDraft, loadDraft, saveDraft } from "./formDraft";

type DraftOptions = {
  ttlMinutes?: number;
  saveDelayMs?: number;
};

const DEFAULT_SAVE_DELAY_MS = 500;
const DEFAULT_TTL_MINUTES = 60;

export function useDraftForm<T>(draftKey: string, initialState: T, options: DraftOptions = {}) {
  const ttlMinutes = Number.isFinite(options.ttlMinutes) ? (options.ttlMinutes as number) : DEFAULT_TTL_MINUTES;
  const saveDelayMs = Number.isFinite(options.saveDelayMs) ? (options.saveDelayMs as number) : DEFAULT_SAVE_DELAY_MS;
  const [state, setState] = useState<T>(() => {
    const stored = loadDraft<T>(draftKey);
    return stored ?? initialState;
  });
  const latestRef = useRef(state);

  useEffect(() => {
    latestRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!draftKey) return;
    const handle = window.setTimeout(() => {
      saveDraft(draftKey, latestRef.current, ttlMinutes);
    }, saveDelayMs);
    return () => window.clearTimeout(handle);
  }, [draftKey, saveDelayMs, ttlMinutes, state]);

  useEffect(() => {
    if (!draftKey) return;
    return () => {
      saveDraft(draftKey, latestRef.current, ttlMinutes);
    };
  }, [draftKey, ttlMinutes]);

  const clear = useCallback(() => {
    clearDraft(draftKey);
  }, [draftKey]);

  return [state, setState, clear] as const;
}
