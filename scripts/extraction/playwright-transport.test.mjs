import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBufferedCdp, createCollectorTab, createPlaywrightTransport } from "./playwright-transport.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "rea-transport-test-"))) throw new Error("Unsafe test cleanup");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function sessionFixture() { const session = new EventEmitter(); session.send = vi.fn(async () => ({})); return session; }
function request(id) { return { requestId: id, wallTime: 123, request: { url: "https://example.test/", postData: "scope", headers: { Cookie: "private" } } }; }

describe("Playwright network adapter", () => {
  it("buffers ordered response evidence without headers and flags evicted checkpoints", async () => {
    const session = sessionFixture();
    const cdp = createBufferedCdp(session, { maxEvents: 3 });
    expect(await cdp.readEvents()).toMatchObject({ cursor: 0, events: [] });
    session.emit("Network.requestWillBeSent", request("one"));
    session.emit("Network.responseReceived", { requestId: "one", type: "Fetch", response: { url: "https://example.test/", status: 200, mimeType: "application/json", headers: { "Set-Cookie": "private" } } });
    session.emit("Network.loadingFinished", { requestId: "one", encodedDataLength: 200 });
    const first = await cdp.readEvents({ afterSequence: 0, limit: 2 });
    expect(first).toMatchObject({ cursor: 2, hasMore: true, truncated: false });
    expect(first.events[0].params.request).toEqual({ url: "https://example.test/", postData: "scope" });
    expect(first.events[1].params.response).not.toHaveProperty("headers");
    expect(await cdp.readEvents({ afterSequence: 2 })).toMatchObject({ cursor: 3, hasMore: false, events: [{ method: "Network.loadingFinished" }] });
    session.emit("Network.requestWillBeSent", request("two"));
    expect(await cdp.readEvents({ afterSequence: 0 })).toMatchObject({ truncated: true });
    expect(await cdp.readEvents({ afterSequence: 1 })).toMatchObject({ truncated: false });
    await cdp.send("Network.enable");
    expect(session.send).toHaveBeenCalledWith("Network.enable", { maxPostDataSize: 1024 * 1024 });
    cdp.dispose();
    expect(session.listenerCount("Network.requestWillBeSent")).toBe(0);
    await expect(cdp.readEvents()).rejects.toThrow("closed");
  });

  it("waits for relevant events and releases waiting readers when disposed", async () => {
    const session = sessionFixture();
    const cdp = createBufferedCdp(session);
    const pending = cdp.readEvents({ afterSequence: 0, methods: ["Network.loadingFinished"], timeoutMs: 1000 });
    session.emit("Network.requestWillBeSent", request("one"));
    session.emit("Network.loadingFinished", { requestId: "one" });
    expect(await pending).toMatchObject({ cursor: 2, events: [{ method: "Network.loadingFinished", sequence: 2 }] });
    const closing = cdp.readEvents({ afterSequence: 2, timeoutMs: 1000 });
    cdp.dispose();
    await expect(closing).rejects.toThrow("closed");
  });

  it("uses bounded DOM navigation and translates the existing collector's locator timeout", async () => {
    const click = vi.fn();
    const page = { url: () => "https://example.test/", goto: vi.fn(), reload: vi.fn(), waitForLoadState: vi.fn(), waitForURL: vi.fn(), evaluate: vi.fn(), getByRole: vi.fn(() => ({ click })) };
    const tab = createCollectorTab(page);
    await tab.goto("https://example.test/list-1");
    await tab.playwright.getByRole("link", { name: "Go to next page", exact: true }).click({ timeoutMs: 7000 });
    expect(page.goto).toHaveBeenCalledWith("https://example.test/list-1", { waitUntil: "domcontentloaded", timeout: 30000 });
    expect(click).toHaveBeenCalledWith({ timeout: 7000 });
    await tab.waitForUrl("https://example.test/list-2?b=2&a=1");
    const [matches, waitOptions] = page.waitForURL.mock.calls[0];
    expect(matches(new URL("https://example.test/list-2?a=1&b=2"))).toBe(true);
    expect(matches(new URL("https://example.test/list-1?a=1&b=2"))).toBe(false);
    expect(waitOptions).toEqual({ waitUntil: "domcontentloaded", timeout: 15000 });
  });

  it("launches visible Chrome with a dedicated persistent profile and closes owned resources once", async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "rea-transport-test-")); temporaryDirectories.push(profile);
    const context = { pages: () => [{}], newCDPSession: vi.fn(async () => sessionFixture()), close: vi.fn() };
    const launchPersistentContext = vi.fn(async () => context);
    const transport = await createPlaywrightTransport({ profileDirectory: profile, launchPersistentContext });
    expect(launchPersistentContext).toHaveBeenCalledWith(path.resolve(profile), { channel: "chrome", headless: false, viewport: null });
    await transport.close(); await transport.close();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
