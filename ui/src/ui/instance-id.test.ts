import { describe, expect, it } from "vitest";
import { loadOrCreateInstanceId } from "./instance-id.ts";

describe("loadOrCreateInstanceId", () => {
  it("persists a stable instance id in localStorage", () => {
    localStorage.removeItem("openclaw-ui-instance-id-v1");

    const first = loadOrCreateInstanceId();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);

    const second = loadOrCreateInstanceId();
    expect(second).toBe(first);

    expect(localStorage.getItem("openclaw-ui-instance-id-v1")).toBe(first);
  });
});

