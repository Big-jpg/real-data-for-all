import fs from "node:fs/promises";
import path from "node:path";
import { listingUrlMatches } from "../chrome-listing-collector.mjs";

const METHODS = ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"];

// The collector only needs scope, timing and response completion. Discard headers at the adapter boundary.
function projectEvent(method, params) {
  const base = { requestId: params.requestId };
  if (method === "Network.requestWillBeSent") return { ...base, wallTime: params.wallTime,
    request: { url: params.request.url, postData: params.request.postData } };
  if (method === "Network.responseReceived") return { ...base, type: params.type,
    response: { url: params.response.url, status: params.response.status, mimeType: params.response.mimeType } };
  if (method === "Network.loadingFailed") return { ...base, errorText: params.errorText };
  return base;
}

export function createBufferedCdp(session, { maxEvents = 10000 } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("CDP buffer size must be a positive integer");
  let sequence = 0;
  let disposed = false;
  const events = [];
  const waiters = new Set();
  const handlers = new Map();
  for (const method of METHODS) {
    const handler = (params) => {
      events.push({ method, params: projectEvent(method, params), sequence: ++sequence });
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
      for (const wake of waiters) wake();
    };
    handlers.set(method, handler);
    session.on(method, handler);
  }

  async function readEvents({ afterSequence, limit = 1000, methods = METHODS, timeoutMs = 0 } = {}) {
    if (disposed) throw new Error("Chrome network adapter is closed");
    if (afterSequence === undefined) return { events: [], cursor: sequence, hasMore: false, truncated: false };
    const selected = new Set(methods);
    const available = () => events.filter((event) => event.sequence > afterSequence && selected.has(event.method));
    if (!available().length && timeoutMs > 0) {
      await new Promise((resolve) => {
        let timer;
        const wake = () => {
          if (!disposed && !available().length) return;
          clearTimeout(timer); waiters.delete(wake); resolve();
        };
        waiters.add(wake);
        timer = setTimeout(() => { waiters.delete(wake); resolve(); }, timeoutMs);
      });
    }
    if (disposed) throw new Error("Chrome network adapter is closed");
    const matches = available();
    const chunk = matches.slice(0, limit);
    const hasMore = matches.length > chunk.length;
    return { events: chunk, cursor: hasMore ? chunk.at(-1).sequence : sequence, hasMore,
      truncated: events.length > 0 && afterSequence < events[0].sequence - 1 };
  }

  return {
    send: (method, params) => session.send(method, method === "Network.enable" ? { maxPostDataSize: 1024 * 1024, ...params } : params),
    readEvents,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [method, handler] of handlers) session.off(method, handler);
      for (const wake of waiters) wake();
      events.length = 0;
    },
  };
}

export function createCollectorTab(page) {
  return {
    url: async () => page.url(),
    goto: (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
    reload: () => page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }),
    getAXState: () => page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
    waitForUrl: (expected) => page.waitForURL((actual) => listingUrlMatches(actual.toString(), expected), { waitUntil: "domcontentloaded", timeout: 15000 }),
    playwright: {
      evaluate: (read) => page.evaluate(read),
      getByRole: (role, options) => {
        const locator = page.getByRole(role, options);
        return { click: ({ timeoutMs = 15000 } = {}) => locator.click({ timeout: timeoutMs }) };
      },
    },
  };
}

/** Own a separate visible Chrome profile; never attach to or modify the user's ordinary Chrome profile. */
export async function createPlaywrightTransport({ profileDirectory, channel = "chrome", launchPersistentContext } = {}) {
  if (!profileDirectory) throw new Error("A dedicated Chrome profile directory is required");
  const profile = path.resolve(profileDirectory);
  await fs.mkdir(profile, { recursive: true });
  const chromium = launchPersistentContext ? null : (await import("playwright-core")).chromium;
  const launch = launchPersistentContext ?? chromium.launchPersistentContext.bind(chromium);
  const context = await launch(profile, { channel, headless: false, viewport: null });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const session = await context.newCDPSession(page);
    const cdp = createBufferedCdp(session);
    let closed = false;
    return { tab: createCollectorTab(page), cdp,
      close: async () => {
        if (closed) return;
        closed = true; cdp.dispose();
        await context.close();
      } };
  } catch (error) { await context.close(); throw error; }
}
