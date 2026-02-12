import { generateUUID } from "./uuid.ts";

const STORAGE_KEY = "openclaw-ui-instance-id-v1";

export function loadOrCreateInstanceId(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = typeof raw === "string" ? raw.trim() : "";
    if (stored) {
      return stored;
    }
  } catch {
    // Ignore storage access issues (e.g. blocked in some embedded browsers).
  }

  const created = generateUUID();
  try {
    localStorage.setItem(STORAGE_KEY, created);
  } catch {
    // Ignore write failures (e.g. Safari private mode).
  }
  return created;
}

