// popup.js — REA Sold Scraper Popup UI Logic
"use strict";

// ─── Elements ────────────────────────────────────────────────────────────────
const statusBar       = document.getElementById("statusBar");
const addForm         = document.getElementById("addForm");
const selState        = document.getElementById("inputState");
const selPostcode     = document.getElementById("inputPostcode");
const selSuburb       = document.getElementById("inputSuburb");
const inputType                = document.getElementById("inputType");
const inputIncludeSurrounding  = document.getElementById("inputIncludeSurrounding");
const dataStatus      = document.getElementById("dataStatus");
const btnStart        = document.getElementById("btnStart");
const btnPause        = document.getElementById("btnPause");
const btnStop         = document.getElementById("btnStop");
const btnExportAll    = document.getElementById("btnExportAll");
const btnClearDone        = document.getElementById("btnClearDone");
const btnClearPending     = document.getElementById("btnClearPending");
const btnClearSelections  = document.getElementById("btnClearSelections");
const btnAddAll           = document.getElementById("btnAddAll");
const queueList       = document.getElementById("queueList");
const settingsToggle  = document.getElementById("settingsToggle");
const settingsPanel   = document.getElementById("settingsPanel");
const settingDelay       = document.getElementById("settingDelay");
const settingMaxPages    = document.getElementById("settingMaxPages");
const settingConcurrency = document.getElementById("settingConcurrency");
const btnSaveSettings = document.getElementById("btnSaveSettings");
const btnRefreshData  = document.getElementById("btnRefreshData");

// ─── App State ───────────────────────────────────────────────────────────────
let currentState = {
  queue:           [],
  settings:        { delayBetweenPages: 4000, maxPagesPerSuburb: 100, concurrency: 2 },
  processing:      false,
  paused:          false,
  activeJobIds:    [],
  cooldownRemainMs: 0
};

// In-memory postcode dataset: [{p, l, s}]
let postcodeData = [];

// ─── Messaging ───────────────────────────────────────────────────────────────
const sendMessage = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

// ─── Postcode Data ───────────────────────────────────────────────────────────
const loadPostcodeData = async () => {
  dataStatus.textContent = "Loading postcode data…";

  let resp = await sendMessage({ type: "GET_POSTCODE_DATA" });

  if (!resp || !resp.data || resp.data.length === 0) {
    dataStatus.textContent = "Fetching postcode dataset…";
    await sendMessage({ type: "REFRESH_POSTCODE_DATA" });
    resp = await sendMessage({ type: "GET_POSTCODE_DATA" });
  }

  if (resp && resp.data && resp.data.length > 0) {
    postcodeData = resp.data;
    dataStatus.textContent = `${postcodeData.length.toLocaleString()} localities loaded`;
  } else {
    dataStatus.textContent = "Failed to load postcode data. Check network.";
  }

  populateStateSelect();
};

// ─── Cascading Select Population ─────────────────────────────────────────────

const resetSelect = (sel, placeholder) => {
  sel.innerHTML = `<option value="" selected disabled>${placeholder}</option>`;
  sel.disabled = true;
  sel.value = "";
};

const populateStateSelect = () => {
  const states = [...new Set(postcodeData.map(r => r.s))].sort();
  selState.innerHTML = `<option value="" selected disabled>State…</option>`;
  for (const st of states) {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = st;
    selState.appendChild(opt);
  }
  selState.disabled = false;
  resetSelect(selPostcode, "Postcode…");
  resetSelect(selSuburb, "Suburb…");
};

const populatePostcodeSelect = (state) => {
  // Unique postcodes for the given state, sorted numerically
  const postcodes = [...new Set(
    postcodeData.filter(r => r.s === state).map(r => r.p)
  )].sort((a, b) => Number(a) - Number(b));

  selPostcode.innerHTML = `<option value="" selected disabled>Postcode…</option>`;
  for (const pc of postcodes) {
    const opt = document.createElement("option");
    opt.value = pc;
    opt.textContent = pc;
    selPostcode.appendChild(opt);
  }
  selPostcode.disabled = false;
  resetSelect(selSuburb, "Suburb…");
};

const populateSuburbSelect = (state, postcode) => {
  // Suburbs matching both state and postcode, sorted alphabetically
  const suburbs = postcodeData
    .filter(r => r.s === state && r.p === postcode)
    .map(r => r.l)
    .filter((v, i, a) => a.indexOf(v) === i) // unique
    .sort();

  selSuburb.innerHTML = `<option value="" selected disabled>Suburb…</option>`;
  for (const sub of suburbs) {
    const opt = document.createElement("option");
    opt.value = sub;
    opt.textContent = sub;
    selSuburb.appendChild(opt);
  }
  selSuburb.disabled = suburbs.length === 0;
};

// ─── Add All enablement ──────────────────────────────────────────────────────
// Enabled when state + postcode + type are all selected (suburb not required)
const updateAddAllButton = () => {
  btnAddAll.disabled = !(selState.value && selPostcode.value && inputType.value);
};

// ─── Cascade Event Handlers ───────────────────────────────────────────────────

selState.addEventListener("change", () => {
  const state = selState.value;
  if (!state) return;
  populatePostcodeSelect(state);
  updateAddAllButton();
});

selPostcode.addEventListener("change", () => {
  const postcode = selPostcode.value;
  if (!postcode) return;

  // Auto-select state if somehow unset (shouldn't happen, but defensive)
  const stateForPc = postcodeData.find(r => r.p === postcode)?.s;
  if (stateForPc && !selState.value) {
    selState.value = stateForPc;
    populatePostcodeSelect(stateForPc);
    selPostcode.value = postcode;
  }

  const state = selState.value;
  if (state) populateSuburbSelect(state, postcode);
  updateAddAllButton();
});

selSuburb.addEventListener("change", () => {
  const suburb = selSuburb.value;
  if (!suburb) return;

  // Auto-fill postcode and state from dataset if not already set
  const match = postcodeData.find(r => r.l === suburb && r.s === selState.value);
  if (match) {
    if (!selPostcode.value) {
      selPostcode.value = match.p;
    }
    if (!selState.value) {
      selState.value = match.s;
    }
  }
});

// Update Add All when type changes
inputType.addEventListener("change", updateAddAllButton);

// ─── Add All handler ──────────────────────────────────────────────────────────
const flashDataStatus = (msg, durationMs = 2500) => {
  dataStatus.textContent = msg;
  setTimeout(() => { dataStatus.textContent = ""; }, durationMs);
};

btnAddAll.addEventListener("click", async () => {
  const stateAbbr          = selState.value;
  const postcode           = selPostcode.value;
  const propertyType       = inputType.value;
  const includeSurrounding = inputIncludeSurrounding.checked;

  if (!stateAbbr || !postcode || !propertyType) return;

  // Collect all suburbs in the Suburb dropdown (skip the placeholder)
  const suburbs = [...selSuburb.options]
    .filter(o => o.value !== "")
    .map(o => o.value);

  if (suburbs.length === 0) {
    flashDataStatus("No suburbs found for this postcode.");
    return;
  }

  btnAddAll.disabled = true;
  btnAddAll.textContent = "Adding\u2026";

  for (const suburb of suburbs) {
    await sendMessage({ type: "ADD_JOB", suburb, stateAbbr, postcode, propertyType, includeSurrounding });
  }

  // Reset suburb to placeholder; leave state/postcode/type intact
  selSuburb.value = "";
  btnAddAll.textContent = "Add All";
  updateAddAllButton();

  flashDataStatus(`Added ${suburbs.length} suburb${suburbs.length !== 1 ? "s" : ""}`);
  refreshState();
});

// ─── Form Submit ──────────────────────────────────────────────────────────────
addForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const suburb             = selSuburb.value;
  const stateAbbr          = selState.value;
  const postcode           = selPostcode.value;
  const propertyType       = inputType.value;
  const includeSurrounding = inputIncludeSurrounding.checked;

  if (!suburb || !stateAbbr || !postcode || !propertyType) return;

  await sendMessage({ type: "ADD_JOB", suburb, stateAbbr, postcode, propertyType, includeSurrounding });

  // Only reset property type — leave state/postcode/suburb populated
  inputType.value = "";
  updateAddAllButton(); // type was cleared, disable Add All

  refreshState();
});

// ─── Render ───────────────────────────────────────────────────────────────────
const render = () => {
  // Status bar
  const coolSec = Math.ceil((currentState.cooldownRemainMs || 0) / 1000);
  if (currentState.processing && coolSec > 0) {
    statusBar.textContent = `Rate limited — cooling down (${coolSec}s)`;
    statusBar.className = "status-bar rate-limited";
  } else if (currentState.processing && currentState.paused) {
    statusBar.textContent = "Paused";
    statusBar.className = "status-bar paused";
  } else if (currentState.processing) {
    statusBar.textContent = "Running";
    statusBar.className = "status-bar running";
  } else {
    statusBar.textContent = "Idle";
    statusBar.className = "status-bar";
  }

  // Control buttons
  btnStart.disabled = currentState.processing;
  btnPause.disabled = !currentState.processing || currentState.paused;
  btnStop.disabled  = !currentState.processing;
  btnPause.textContent = currentState.paused ? "Resume" : "Pause";
  if (currentState.paused) btnPause.disabled = false;

  // Settings fields
  settingDelay.value       = currentState.settings.delayBetweenPages;
  settingMaxPages.value    = currentState.settings.maxPagesPerSuburb;
  settingConcurrency.value = currentState.settings.concurrency ?? 2;

  // Queue list
  if (currentState.queue.length === 0) {
    queueList.innerHTML = '<div class="empty-state">No suburbs in queue</div>';
    return;
  }

  queueList.innerHTML = currentState.queue.map(job => {
    const surrounding = job.includeSurrounding !== false;
    const label = `${job.suburb}, ${job.stateAbbr.toUpperCase()} ${job.postcode} (${job.propertyType}${surrounding ? " +nearby" : ""})`;
    let meta = "";
    const isActive = currentState.activeJobIds.includes(job.id);
    if (job.status === "running") {
      const ceiling = job.calculatedPageCeiling ? `/${job.calculatedPageCeiling}` : "";
      const detected = job.progressNote ? ` · ${job.progressNote}` : "";
      meta = `Page ${job.currentPage}${ceiling} · ${job.totalRecords} records${isActive ? " · ⬤" : " · ◌"}${detected}`;
    } else if (job.status === "complete") {
      const detected = job.detectedTotalResults ? ` of ${job.detectedTotalResults}` : "";
      meta = `${job.totalRecords}${detected} records · ${job.currentPage} pages`;
    } else if (job.status === "error") {
      meta = job.error || "Unknown error";
    } else {
      meta = job.totalRecords ? `${job.totalRecords} records` : "pending";
    }

    return `
      <div class="queue-item">
        <div class="job-info">
          <div class="job-label">${escapeHtml(label)}</div>
          <div class="job-meta">${escapeHtml(meta)}</div>
        </div>
        <span class="job-status status-${job.status}">${job.status}</span>
        <div class="job-actions">
          ${job.status === "complete"
            ? `<button class="btn btn-xs btn-secondary" data-export="${job.id}">CSV</button>`
            : ""}
          ${job.status !== "running"
            ? `<button class="btn btn-xs btn-danger" data-remove="${job.id}">✕</button>`
            : ""}
        </div>
      </div>
    `;
  }).join("");
};

const escapeHtml = (str) => {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
};

// ─── CSV Export ───────────────────────────────────────────────────────────────
const columns = [
  "sourceUrl", "pageNumber", "ordinalOnPage", "price", "priceValue", "address",
  "detailPath", "detailUrl", "bedrooms", "bathrooms", "carSpaces", "landSize",
  "landSizeSqm", "propertyType", "soldDate", "soldDateISO", "scrapedAt"
];

const csvEscape = (value) => {
  if (value == null) return "";
  const s = String(value).replace(/\r?\n/g, " ").trim();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportCsv = (records, filename) => {
  const header = columns.join(",");
  const rows   = records.map(r => columns.map(c => csvEscape(r[c])).join(","));
  const csv    = [header, ...rows].join("\n");
  const blob   = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

// ─── Control Buttons ──────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  await sendMessage({ type: "START" });
  refreshState();
});

btnPause.addEventListener("click", async () => {
  await sendMessage({ type: currentState.paused ? "RESUME" : "PAUSE" });
  refreshState();
});

btnStop.addEventListener("click", async () => {
  await sendMessage({ type: "STOP" });
  refreshState();
});

btnExportAll.addEventListener("click", async () => {
  const jobIds = currentState.queue.map(j => j.id);
  if (!jobIds.length) return;
  const resp = await sendMessage({ type: "EXPORT_CSV", jobIds });
  if (resp?.success && resp.records.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    exportCsv(resp.records, `rea-sold-all-${ts}.csv`);
  }
});

btnClearDone.addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_COMPLETE" });
  refreshState();
});

btnClearPending.addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_PENDING" });
  refreshState();
});

btnClearSelections.addEventListener("click", () => {
  selState.value = "";
  resetSelect(selPostcode, "Postcode…");
  resetSelect(selSuburb, "Suburb…");
  inputType.value = "";
});

// Queue item actions (event delegation)
queueList.addEventListener("click", async (e) => {
  const exportBtn = e.target.closest("[data-export]");
  if (exportBtn) {
    const jobId = exportBtn.dataset.export;
    const resp  = await sendMessage({ type: "EXPORT_CSV", jobIds: [jobId] });
    if (resp?.success && resp.records.length > 0) {
      const job  = currentState.queue.find(j => j.id === jobId);
      const name = job ? `${job.suburb}-${job.stateAbbr}-${job.postcode}` : "export";
      exportCsv(resp.records, `rea-sold-${name}.csv`);
    }
    return;
  }

  const removeBtn = e.target.closest("[data-remove]");
  if (removeBtn) {
    await sendMessage({ type: "REMOVE_JOB", jobId: removeBtn.dataset.remove });
    refreshState();
  }
});

// Settings
settingsToggle.addEventListener("click", () => {
  const hidden = settingsPanel.classList.toggle("hidden");
  settingsToggle.textContent = hidden ? "Settings ▸" : "Settings ▾";
});

btnSaveSettings.addEventListener("click", async () => {
  await sendMessage({
    type: "UPDATE_SETTINGS",
    settings: {
      delayBetweenPages: parseInt(settingDelay.value, 10)    || 4000,
      maxPagesPerSuburb: parseInt(settingMaxPages.value, 10) || 100,
      concurrency:       Math.min(4, Math.max(1, parseInt(settingConcurrency.value, 10) || 2))
    }
  });
  refreshState();
});

btnRefreshData.addEventListener("click", async () => {
  dataStatus.textContent = "Refreshing…";
  await sendMessage({ type: "REFRESH_POSTCODE_DATA" });
  await loadPostcodeData();
});

// ─── State Refresh ────────────────────────────────────────────────────────────
const refreshState = async () => {
  const resp = await sendMessage({ type: "GET_STATE" });
  if (resp) {
    currentState = {
      queue:            resp.queue,
      settings:         resp.settings,
      processing:       resp.processing,
      paused:           resp.paused,
      activeJobIds:     resp.activeJobIds    || [],
      cooldownRemainMs: resp.cooldownRemainMs || 0
    };
    render();
  }
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_UPDATE") {
    currentState = {
      queue:            message.queue,
      settings:         message.settings,
      processing:       message.processing,
      paused:           message.paused,
      activeJobIds:     message.activeJobIds    || [],
      cooldownRemainMs: message.cooldownRemainMs || 0
    };
    render();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
refreshState();
loadPostcodeData();
