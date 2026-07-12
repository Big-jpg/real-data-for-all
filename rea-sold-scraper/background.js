// background.js — REA Sold Scraper Background Service Worker
// Multi-tab parallel processing with MV3 keepalive, watchdog, and re-entrant resume.

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const ALARM_NAME          = "rea-scraper-keepalive";
const ALARM_PERIOD_MIN    = 0.4;          // ~24 seconds — under the 30s kill threshold
const STALL_MULTIPLIER    = 3;            // job stalled if no activity for delay * 3
const STALL_MIN_MS        = 20_000;       // floor: always stall-detect after 20s silence
const POSTCODE_CSV_URL    =
  "https://raw.githubusercontent.com/matthewproctor/australianpostcodes/master/australian_postcodes.csv";

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  queue: [],
  settings: {
    delayBetweenPages: 4000,
    maxPagesPerSuburb: 100,
    fetchRetries: 3,
    fetchRetryDelay: 2500,
    concurrency: 2
  },
  processing: false,
  paused: false
};

// Tab pool: Map<tabId, jobId | null>
const tabPool = new Map();

// ─── Rate-limit / Cooldown State ─────────────────────────────────────────────
const rl = {
  cooldownUntil:   0,
  nextCooldownMs:  60_000,
  pageRetries:     new Map(),
  maxPageRetries:  3,
  backoffSchedule: [30_000, 60_000, 120_000],
  retiredCount:    0
};

// ─── Persistence ─────────────────────────────────────────────────────────────
const saveState = async () => {
  await chrome.storage.local.set({
    queue:      state.queue,
    settings:   state.settings,
    processing: state.processing,
    paused:     state.paused
  });
};

const loadState = async () => {
  const stored = await chrome.storage.local.get(["queue", "settings", "processing", "paused"]);
  if (stored.queue)    state.queue    = stored.queue;
  if (stored.settings) state.settings = { ...state.settings, ...stored.settings };
  // On restart: processing flag is unreliable — reset it; watchdog will resume
  state.processing = false;
  state.paused     = false;
  // Any job that was "running" when the worker died → back to pending
  // (watchdog/onStartup will re-dispatch them)
  state.queue.forEach(job => {
    if (job.status === "running") job.status = "pending";
  });
  await saveState();
};

// ─── Broadcast ───────────────────────────────────────────────────────────────
const broadcastState = () => {
  const activeJobIds     = [...tabPool.values()].filter(Boolean);
  const cooldownRemainMs = Math.max(0, rl.cooldownUntil - Date.now());
  chrome.runtime.sendMessage({
    type: "STATE_UPDATE",
    queue:             state.queue,
    settings:          state.settings,
    processing:        state.processing,
    paused:            state.paused,
    activeJobIds,
    cooldownRemainMs
  }).catch(() => {});
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const buildUrl = (suburb, stateAbbr, postcode, propertyType, page, includeSurrounding) => {
  const suburbSlug = suburb.toLowerCase().replace(/\s+/g, "+");
  const st = stateAbbr.toLowerCase();
  const base = `https://www.realestate.com.au/sold/property-${propertyType}-in-${suburbSlug},+${st}+${postcode}/list-${page}`;
  return includeSurrounding ? base : `${base}?includeSurrounding=false`;
};

const makeKey = (r) =>
  `${r.address}|${r.soldDate}|${r.priceValue}|${r.bedrooms}|${r.bathrooms}|${r.carSpaces}|${r.landSizeSqm}`;

// ─── Keepalive Alarm ──────────────────────────────────────────────────────────
const startKeepaliveAlarm = () => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
};

const stopKeepaliveAlarm = () => {
  chrome.alarms.clear(ALARM_NAME);
};

// ─── Rate-limit Helpers ───────────────────────────────────────────────────────
const triggerGlobalCooldown = async () => {
  const now = Date.now();
  if (rl.cooldownUntil > now) return;
  rl.cooldownUntil  = now + rl.nextCooldownMs;
  rl.nextCooldownMs = Math.min(rl.nextCooldownMs * 2, 300_000);
  state.settings.delayBetweenPages = Math.min(state.settings.delayBetweenPages * 2, 60_000);
  if (tabPool.size > 1 && rl.retiredCount < state.settings.concurrency - 1) {
    for (const [tabId, jobId] of tabPool) {
      if (!jobId) {
        tabPool.delete(tabId);
        rl.retiredCount++;
        try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
        break;
      }
    }
  }
  await saveState();
  broadcastState();
  const tickInterval = setInterval(() => {
    const remain = Math.max(0, rl.cooldownUntil - Date.now());
    broadcastState();
    if (remain === 0) clearInterval(tickInterval);
  }, 1000);
};

const waitForCooldown = async () => {
  while (true) {
    const remain = rl.cooldownUntil - Date.now();
    if (remain <= 0) return;
    await sleep(Math.min(remain, 500));
  }
};

// ─── Tab Management ──────────────────────────────────────────────────────────
const openTab = () => new Promise((resolve, reject) => {
  chrome.tabs.create(
    { url: "https://www.realestate.com.au/sold/", active: false },
    (tab) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab.id);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    }
  );
});

const isTabAlive = async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!(tab && tab.url && tab.url.includes("realestate.com.au"));
  } catch { return false; }
};

const injectContentScript = async (tabId) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    console.warn(`[tab ${tabId}] Injection failed:`, err.message);
  }
};

// Send message to content script; on failure, re-inject and retry once
const sendToContent = async (tabId, message) => {
  const send = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });

  try {
    return await send();
  } catch (firstErr) {
    // Receiving end doesn't exist — re-inject content script and retry once
    console.warn(`[tab ${tabId}] sendMessage failed (${firstErr.message}), re-injecting…`);
    await injectContentScript(tabId);
    await sleep(800);
    return await send(); // throws if still failing — caller handles it
  }
};

const ensurePool = async () => {
  const n = state.settings.concurrency;
  for (const [tabId] of tabPool) {
    if (!(await isTabAlive(tabId))) tabPool.delete(tabId);
  }
  while (tabPool.size < n) {
    try {
      const tabId = await openTab();
      tabPool.set(tabId, null);
    } catch (err) {
      console.error("Failed to open tab:", err.message);
      break;
    }
  }
};

const closePool = async () => {
  for (const [tabId] of tabPool) {
    try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
  }
  tabPool.clear();
};

// ─── Tab closed by user ───────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabPool.has(tabId)) return;
  const jobId = tabPool.get(tabId);
  tabPool.delete(tabId);
  if (jobId) {
    const job = state.queue.find(j => j.id === jobId);
    if (job && job.status === "running") {
      job.status = "pending";
      saveState().then(() => broadcastState());
    }
  }
  if (state.processing && !state.paused) {
    openTab().then(newTabId => {
      tabPool.set(newTabId, null);
      dispatchNextJob(newTabId);
    }).catch(err => console.error("Replacement tab failed:", err.message));
  }
});

// ─── Job Processing ───────────────────────────────────────────────────────────
const claimNextJob = () => {
  const job = state.queue.find(j => j.status === "pending");
  if (!job) return null;
  job.status = "running";
  return job;
};

const touchActivity = (job) => {
  job.lastActivityTimestamp = Date.now();
};

const processJobOnTab = async (tabId, job) => {
  tabPool.set(tabId, job.id);
  job.currentPage  = job.currentPage  || 0;
  job.totalRecords = job.totalRecords || 0;
  job.error        = null;
  if (!job.calculatedPageCeiling) job.calculatedPageCeiling = null;
  if (!job.detectedTotalResults)  job.detectedTotalResults  = null;
  touchActivity(job);
  await saveState();
  broadcastState();

  await injectContentScript(tabId);

  const storageKey = `results_${job.id}`;
  const existing   = (await chrome.storage.local.get(storageKey))[storageKey] || [];
  const seenKeys   = new Set(existing.map(makeKey));
  let allRecords   = existing;
  let consecutiveDuplicatePages = 0;
  const includeSurrounding = job.includeSurrounding !== false;

  const startPage = job.currentPage + 1;
  const maxPage   = () => Math.min(
    job.calculatedPageCeiling || state.settings.maxPagesPerSuburb,
    state.settings.maxPagesPerSuburb
  );

  for (let page = startPage; page <= maxPage(); page++) {
    // ── Stop check ──
    if (!state.processing) {
      job.status = "pending";
      job.currentPage = page - 1;
      tabPool.set(tabId, null);
      await saveState(); broadcastState();
      return;
    }

    // ── Pause check ──
    while (state.paused && state.processing) {
      touchActivity(job); // keep watchdog happy while paused
      await sleep(500);
    }
    if (!state.processing) {
      job.status = "pending";
      job.currentPage = page - 1;
      tabPool.set(tabId, null);
      await saveState(); broadcastState();
      return;
    }

    // ── Global cooldown wait ──
    await waitForCooldown();

    // ── Tab alive check ──
    if (!(await isTabAlive(tabId))) {
      job.status = "pending";
      job.currentPage = page - 1;
      tabPool.delete(tabId);
      await saveState(); broadcastState();
      return;
    }

    const pageUrl = buildUrl(job.suburb, job.stateAbbr, job.postcode, job.propertyType, page, includeSurrounding);
    job.currentPage = page;
    touchActivity(job);
    await saveState(); broadcastState();

    // ── Fetch with 429 retry loop ──
    const pageKey = `${job.id}:${page}`;
    let response;
    let fetchOk = false;

    while (!fetchOk) {
      try {
        response = await sendToContent(tabId, {
          type:         "EXTRACT_PAGE",
          pageUrl,
          pageNumber:   page,
          retries:      state.settings.fetchRetries,
          retryDelayMs: state.settings.fetchRetryDelay
        });
      } catch (err2) {
        job.status = "error";
        job.error  = `Content script unreachable: ${err2.message}`;
        tabPool.set(tabId, null);
        await saveState(); broadcastState();
        return;
      }

      if (!response || !response.success) {
        job.status = "error";
        job.error  = response?.error || "Unknown extraction error";
        tabPool.set(tabId, null);
        await saveState(); broadcastState();
        return;
      }

      if (response.rateLimited) {
        const retryCount = (rl.pageRetries.get(pageKey) || 0);
        if (retryCount >= rl.maxPageRetries) {
          job.status = "error";
          job.error  = "Rate limited — try again later";
          rl.pageRetries.delete(pageKey);
          tabPool.set(tabId, null);
          await saveState(); broadcastState();
          return;
        }
        rl.pageRetries.set(pageKey, retryCount + 1);
        await triggerGlobalCooldown();
        const backoffMs = rl.backoffSchedule[retryCount] || 120_000;
        job.error = `Rate limited — slowing down (retry ${retryCount + 1}/${rl.maxPageRetries})`;
        await saveState(); broadcastState();
        const waitUntil = Date.now() + backoffMs;
        while (Date.now() < waitUntil || rl.cooldownUntil > Date.now()) {
          if (!state.processing) {
            job.status = "pending";
            job.currentPage = page - 1;
            tabPool.set(tabId, null);
            await saveState(); broadcastState();
            return;
          }
          touchActivity(job);
          await sleep(500);
        }
        job.error = null;
        continue;
      }

      rl.pageRetries.delete(pageKey);
      fetchOk = true;
    }

    // ── Activity timestamp after successful fetch ──
    touchActivity(job);

    if (response.empty || response.records.length === 0) {
      if (!job.calculatedPageCeiling || page >= job.calculatedPageCeiling) break;
      // Sparse page — keep going toward ceiling
    }

    // On page 1, capture total results and calculate page ceiling
    if (page === 1 && response.totalResults != null) {
      job.detectedTotalResults  = response.totalResults;
      job.calculatedPageCeiling = Math.ceil(response.totalResults / 25);
      job.progressNote = `Detected ${response.totalResults} results (~${job.calculatedPageCeiling} pages)`;
    }

    let newCount = 0;
    for (const record of (response.records || [])) {
      const key = makeKey(record);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allRecords.push(record);
        newCount++;
      }
    }

    job.totalRecords = allRecords.length;

    if (newCount === 0) {
      if (++consecutiveDuplicatePages >= 3) {
        if (!job.calculatedPageCeiling || page >= job.calculatedPageCeiling) break;
        consecutiveDuplicatePages = 0;
      }
    } else {
      consecutiveDuplicatePages = 0;
    }

    await chrome.storage.local.set({ [storageKey]: allRecords });
    await saveState(); broadcastState();

    if (page < maxPage()) {
      // Sleep in short chunks so the service worker stays active
      const delay = state.settings.delayBetweenPages;
      const chunk = 5_000; // 5s chunks
      let elapsed = 0;
      while (elapsed < delay) {
        if (!state.processing) break;
        const wait = Math.min(chunk, delay - elapsed);
        await sleep(wait);
        elapsed += wait;
        // Touch activity each chunk so watchdog doesn't fire during intentional delay
        touchActivity(job);
      }
    }
  }

  job.status       = "complete";
  job.totalRecords = allRecords.length;
  await chrome.storage.local.set({ [storageKey]: allRecords });
  tabPool.set(tabId, null);
  await saveState(); broadcastState();
};

// ─── Dispatch Loop ────────────────────────────────────────────────────────────
const dispatchNextJob = async (tabId) => {
  while (state.processing) {
    while (state.paused && state.processing) await sleep(500);
    if (!state.processing) break;
    const job = claimNextJob();
    if (!job) break;
    await processJobOnTab(tabId, job);
  }
  if (tabPool.has(tabId)) tabPool.set(tabId, null);
};

const startProcessing = async () => {
  rl.cooldownUntil  = 0;
  rl.nextCooldownMs = 60_000;
  rl.pageRetries.clear();
  rl.retiredCount   = 0;

  state.processing = true;
  state.paused     = false;
  await saveState(); broadcastState();

  startKeepaliveAlarm();
  await ensurePool();

  const dispatches = [...tabPool.keys()].map(tabId => dispatchNextJob(tabId));
  await Promise.all(dispatches);

  state.processing = false;
  stopKeepaliveAlarm();
  await saveState(); broadcastState();
};

// ─── Watchdog (runs on every alarm tick) ─────────────────────────────────────
// Checks for stalled running jobs and re-dispatches them.
const runWatchdog = async () => {
  if (!state.processing || state.paused) return;

  const stallThresholdMs = Math.max(
    state.settings.delayBetweenPages * STALL_MULTIPLIER,
    STALL_MIN_MS
  );
  const now = Date.now();

  for (const job of state.queue) {
    if (job.status !== "running") continue;

    const lastActivity = job.lastActivityTimestamp || 0;
    const idle = now - lastActivity;

    if (idle < stallThresholdMs) continue;

    console.warn(`[watchdog] Job ${job.id} stalled (${Math.round(idle / 1000)}s idle) — resetting to pending`);
    job.status = "pending";

    // Release the tab assignment if we know which tab had it
    for (const [tabId, jobId] of tabPool) {
      if (jobId === job.id) {
        tabPool.set(tabId, null);
        break;
      }
    }
  }

  await saveState(); broadcastState();

  // Ensure pool is full and dispatch to any idle tabs
  await ensurePool();
  for (const [tabId, jobId] of tabPool) {
    if (!jobId) {
      // Idle tab — dispatch next pending job if any
      const next = state.queue.find(j => j.status === "pending");
      if (next) dispatchNextJob(tabId); // fire-and-forget
    }
  }
};

// ─── Alarm Handler ────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Simply being invoked keeps the service worker alive.
  // Also run the watchdog to recover stalled jobs.
  await runWatchdog();
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "GET_STATE") {
    const activeJobIds     = [...tabPool.values()].filter(Boolean);
    const cooldownRemainMs = Math.max(0, rl.cooldownUntil - Date.now());
    sendResponse({
      queue: state.queue, settings: state.settings,
      processing: state.processing, paused: state.paused,
      activeJobIds, cooldownRemainMs
    });
    return false;
  }

  if (message.type === "ADD_JOB") {
    const job = {
      id:                    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      suburb:                message.suburb,
      stateAbbr:             message.stateAbbr,
      postcode:              message.postcode,
      propertyType:          message.propertyType,
      includeSurrounding:    message.includeSurrounding !== false,
      status:                "pending",
      currentPage:           0,
      totalRecords:          0,
      detectedTotalResults:  null,
      calculatedPageCeiling: null,
      progressNote:          null,
      lastActivityTimestamp: null,
      error:                 null
    };
    state.queue.push(job);
    saveState().then(() => broadcastState());
    sendResponse({ success: true, job });
    return false;
  }

  if (message.type === "REMOVE_JOB") {
    state.queue = state.queue.filter(j => j.id !== message.jobId);
    chrome.storage.local.remove(`results_${message.jobId}`);
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "START") {
    if (!state.processing) startProcessing();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "STOP") {
    state.processing = false;
    state.paused     = false;
    state.queue.forEach(j => { if (j.status === "running") j.status = "pending"; });
    stopKeepaliveAlarm();
    saveState().then(async () => { await closePool(); broadcastState(); });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "PAUSE") {
    state.paused = true;
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "RESUME") {
    state.paused = false;
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "UPDATE_SETTINGS") {
    state.settings = { ...state.settings, ...message.settings };
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "EXPORT_CSV") {
    const jobIds = message.jobIds || state.queue.map(j => j.id);
    const keys   = jobIds.map(id => `results_${id}`);
    chrome.storage.local.get(keys, (data) => {
      let allRecords = [];
      for (const key of keys) { if (data[key]) allRecords = allRecords.concat(data[key]); }
      sendResponse({ success: true, records: allRecords });
    });
    return true;
  }

  if (message.type === "CLEAR_COMPLETE") {
    const done = state.queue.filter(j => j.status === "complete");
    chrome.storage.local.remove(done.map(j => `results_${j.id}`));
    state.queue = state.queue.filter(j => j.status !== "complete");
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "CLEAR_PENDING") {
    const pending = state.queue.filter(j => j.status === "pending");
    chrome.storage.local.remove(pending.map(j => `results_${j.id}`));
    state.queue = state.queue.filter(j => j.status !== "pending");
    saveState().then(() => broadcastState());
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "GET_POSTCODE_DATA") {
    chrome.storage.local.get(["postcodeData"], (data) => {
      sendResponse({ success: true, data: data.postcodeData || [] });
    });
    return true;
  }

  if (message.type === "REFRESH_POSTCODE_DATA") {
    fetchAndStorePostcodes().then(count => sendResponse({ success: true, count }));
    return true;
  }

  return false;
});

// ─── Startup / Install Recovery ───────────────────────────────────────────────
// On worker restart (e.g. Chrome killed the SW), check for jobs that were
// running and resume them automatically.
const resumeAfterRestart = async () => {
  const pendingJobs = state.queue.filter(j => j.status === "pending");
  if (pendingJobs.length === 0) return;

  // Only auto-resume if there were previously running jobs (i.e. processing was active)
  // We can't know for sure since we reset processing=false on load, so check
  // if any job has a non-zero currentPage (was mid-run when worker died).
  const wasRunning = pendingJobs.some(j => j.currentPage > 0);
  if (!wasRunning) return;

  console.log(`[startup] Resuming ${pendingJobs.length} pending job(s) after worker restart`);
  startProcessing();
};

// ─── Postcode Dataset ─────────────────────────────────────────────────────────
const fetchAndStorePostcodes = async () => {
  try {
    const response = await fetch(POSTCODE_CSV_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const csvText = await response.text();
    const lines   = csvText.split("\n");
    const header  = lines[0].split(",").map(h => h.trim().toLowerCase());
    const pcIdx   = header.indexOf("postcode");
    const locIdx  = header.indexOf("locality");
    const stIdx   = header.indexOf("state");
    if (pcIdx === -1 || locIdx === -1 || stIdx === -1)
      throw new Error("CSV header missing expected columns");
    const seen = new Set(), records = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim()) continue;
      const parts    = line.split(",");
      const postcode = (parts[pcIdx]  || "").trim();
      const locality = (parts[locIdx] || "").trim().replace(/^"|"$/g, "");
      const st       = (parts[stIdx]  || "").trim().replace(/^"|"$/g, "");
      if (!postcode || !locality || !st) continue;
      const key = `${postcode}|${locality}|${st}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ p: postcode, l: locality, s: st });
    }
    await chrome.storage.local.set({ postcodeData: records, postcodeDataTimestamp: Date.now() });
    return records.length;
  } catch (err) {
    console.error("Failed to fetch postcode data:", err);
    return 0;
  }
};

const ensurePostcodeData = async () => {
  const stored = await chrome.storage.local.get(["postcodeData"]);
  if (stored.postcodeData && stored.postcodeData.length > 0) return;
  await fetchAndStorePostcodes();
};

// ─── Init ─────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  ensurePostcodeData();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  await ensurePostcodeData();
  await resumeAfterRestart();
});

// Initial load (covers normal service worker activation, not just onStartup)
loadState().then(async () => {
  await ensurePostcodeData();
  await resumeAfterRestart();
});
