import { describe, expect, it, vi } from "vitest";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

describe("createVpsAwareOAuthHandlers", () => {
  it("surfaces remote OAuth URL via note and reuses manual prompt value", async () => {
    const note = vi.fn(async () => {});
    const text = vi.fn(async () => "http://127.0.0.1:1456/oauth-callback?code=abc");
    const log = vi.fn();
    const stop = vi.fn();

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: { note, text } as any,
      runtime: { log } as any,
      spin: { stop, update: vi.fn() } as any,
      openUrl: vi.fn(async () => {}),
      localBrowserMessage: "Complete sign-in",
    });

    await handlers.onAuth({ url: "https://auth.example.test/start" });
    const manual = await handlers.onPrompt({ message: "Paste redirect URL" });

    expect(stop).toHaveBeenCalledWith("OAuth URL ready");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("https://auth.example.test/start"),
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("https://auth.example.test/start"),
      "OAuth browser step",
    );
    expect(text).toHaveBeenCalledTimes(1);
    expect(manual).toContain("oauth-callback");
  });

  it("opens browser directly in local mode", async () => {
    const openUrl = vi.fn(async () => {});
    const update = vi.fn();
    const log = vi.fn();

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: false,
      prompter: { note: vi.fn(), text: vi.fn(async () => "unused") } as any,
      runtime: { log } as any,
      spin: { stop: vi.fn(), update } as any,
      openUrl,
      localBrowserMessage: "Complete sign-in in browser…",
    });

    await handlers.onAuth({ url: "https://auth.example.test/local" });

    expect(update).toHaveBeenCalledWith("Complete sign-in in browser…");
    expect(openUrl).toHaveBeenCalledWith("https://auth.example.test/local");
    expect(log).toHaveBeenCalledWith("Open: https://auth.example.test/local");
  });
});
