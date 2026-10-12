const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en-AU");
const dateTime = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Perth" });
const dateLabel = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Perth" });
const statuses = {
  queued: ["Queued", "neutral"], pending: ["Pending", "neutral"], starting: ["Opening Chrome", "active"],
  running: ["Running", "active"], pausing: ["Finishing current page", "warning"], paused: ["Paused", "neutral"],
  interrupted: ["Interrupted", "warning"], "source-challenge": ["Chrome needs attention", "warning"],
  complete: ["Complete", "positive"], "finished-with-exceptions": ["Exceptions", "warning"],
  failed: ["Failed", "error"], partial: ["Partial", "warning"], capped: ["Page limit", "warning"],
};
const busyStates = new Set(["starting", "running", "pausing"]);
const exceptionStates = new Set(["failed", "partial", "capped"]);
const retryStates = new Set(["failed", "partial"]);
const kindNames = { pilot: "Small pilot", custom: "Selected localities", "perth-wide": "Perth-wide" };
let state = null;
let selectedIds = new Set();
let retryNames = new Set();
let selectedJobId = null;
let catalogueSignature = "";
let queueSignature = "";
let detailSignature = "";
let pollTimer;
let pollController;
let pollPromise;
let pollFailures = 0;
let actionPending = false;
let lastDefaultName = "";

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}
function fmt(value) { return number.format(Number.isFinite(Number(value)) ? Number(value) : 0); }
function formattedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}
function statusTag(value) {
  const [label, tone] = statuses[value] || [String(value || "Pending"), "neutral"];
  const node = el("span", "status-tag", label);
  node.dataset.tone = tone;
  return node;
}
function focusKey(node, key) { node.dataset.focusKey = key; return node; }
function preserveFocus(callback) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  callback();
  if (!key || !active || active.isConnected) return;
  const replacement = Array.from(document.querySelectorAll("[data-focus-key]")).find((node) => node.dataset.focusKey === key);
  replacement?.focus({ preventScroll: true });
}
function selectedJob() { return (state?.jobs || []).find((job) => job.id === selectedJobId); }
function activeBusyJob() { return (state?.jobs || []).find((job) => busyStates.has(job.status)); }
function jobSlices(job) { return Array.isArray(job.slices) ? job.slices : []; }
function needsPilot(job) { return job.kind === "perth-wide" || jobSlices(job).length > 3; }
function committedPages(slice) { return Array.isArray(slice.pages) ? slice.pages.length : Number(slice.pages || 0); }
function rowCount(slice) { return Number(slice.rows ?? slice.summary?.capturedRows ?? 0); }
function failureText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.message || value.code || "Capture failed");
}
function defaultName() {
  const kind = byId("capture-kind").value;
  return `${kindNames[kind]} · ${dateLabel.format(new Date())}`;
}
function updateDefaultName() {
  const input = byId("capture-name");
  if (!input.value || input.value === lastDefaultName) input.value = defaultName();
  lastDefaultName = defaultName();
}
function showMessage(message, tone = "success") {
  const node = byId("action-message");
  node.textContent = message;
  node.className = `alert${tone === "error" ? " error" : tone === "pending" ? " pending" : ""}`;
  node.hidden = !message;
}
function updateComposer() {
  const kind = byId("capture-kind").value;
  const wide = kind === "perth-wide";
  const catalogue = state?.catalogue || [];
  byId("locality-picker").hidden = wide;
  byId("wide-scope").hidden = !wide;
  byId("wide-count").textContent = `${fmt(catalogue.length)} Perth locality / postcode pairs`;
  const passed = state?.pilot?.passed === true;
  byId("pilot-gate").dataset.passed = String(passed);
  byId("pilot-gate").querySelector(".gate-icon").textContent = passed ? "✓" : "○";
  byId("pilot-gate-text").textContent = passed ? "Pilot passed. Larger captures are available." : "Complete a small pilot before a larger capture.";
  const count = selectedIds.size;
  byId("selection-summary").textContent = `${fmt(count)} selected${kind === "pilot" ? " · choose 1–3 for a pilot" : ""}`;
  byId("create-button").disabled = !state || actionPending || (!wide && count === 0) || (kind === "pilot" && count > 3) || (wide && catalogue.length === 0);
  byId("clear-selection").disabled = count === 0;
  byId("create-button").textContent = actionPending ? "Please wait…" : "Add to queue";
}
function renderPicker() {
  const catalogue = state?.catalogue || [];
  const query = byId("locality-search").value.trim().toLocaleLowerCase("en-AU");
  const matches = catalogue.filter((item) => `${item.suburb} ${item.postcode}`.toLocaleLowerCase("en-AU").includes(query));
  const options = matches.map((item) => {
    const label = el("label", "locality-option");
    const input = focusKey(el("input"), `locality:${item.id}`);
    input.type = "checkbox";
    input.checked = selectedIds.has(item.id);
    input.addEventListener("change", () => {
      if (input.checked) selectedIds.add(item.id); else selectedIds.delete(item.id);
      renderChips();
      updateComposer();
    });
    label.append(input, el("span", "", item.suburb), el("small", "", item.postcode));
    return label;
  });
  if (!options.length) options.push(el("p", "picker-empty", catalogue.length ? "No matching localities." : "Locality catalogue unavailable."));
  preserveFocus(() => byId("locality-results").replaceChildren(...options));
  renderChips();
  updateComposer();
}
function renderChips() {
  const items = (state?.catalogue || []).filter((item) => selectedIds.has(item.id));
  const chips = items.map((item) => {
    const button = focusKey(el("button", "locality-chip"), `chip:${item.id}`);
    button.type = "button";
    button.setAttribute("aria-label", `Remove ${item.suburb} ${item.postcode}`);
    button.append(el("span", "", `${item.suburb} ${item.postcode}`), el("span", "", "×"));
    button.addEventListener("click", () => {
      selectedIds.delete(item.id);
      renderPicker();
      byId("locality-search").focus({ preventScroll: true });
    });
    return button;
  });
  byId("selected-localities").replaceChildren(...chips);
}
function actionButton(label, action, job, primary = false) {
  const button = focusKey(el("button", primary ? "primary-button" : "secondary-button", label), `${job.id}:${action}`);
  button.type = "button";
  button.disabled = actionPending || (action !== "pause" && Boolean(activeBusyJob())) || (needsPilot(job) && !state?.pilot?.passed && ["start", "resume", "retry"].includes(action));
  button.addEventListener("click", () => {
    const names = action === "retry" ? jobSlices(job).filter((slice) => retryStates.has(slice.status)).map((slice) => slice.name) : [];
    void performAction(job.id, action, names.length ? names : undefined);
  });
  return button;
}
function renderJob(job) {
  const slices = jobSlices(job);
  const complete = slices.filter((slice) => slice.status === "complete").length;
  const pages = job.progress?.committedPages ?? slices.reduce((sum, slice) => sum + committedPages(slice), 0);
  const rows = job.progress?.capturedRows ?? slices.reduce((sum, slice) => sum + rowCount(slice), 0);
  const card = el("article", "job-card");
  card.dataset.selected = String(job.id === selectedJobId);
  card.dataset.active = String(job.id === state?.activeJobId && busyStates.has(job.status));
  const top = el("div", "job-top");
  const title = el("div", "job-title");
  const heading = el("h3", "", job.name || job.runId || "Capture");
  const meta = el("div", "job-meta");
  meta.append(el("span", "", kindNames[job.kind] || "Capture"), el("span", "", `${fmt(slices.length)} localities`), el("span", "", `${formattedDate(job.createdAt)} AWST`));
  title.append(heading, meta);
  top.append(title, statusTag(job.status));
  const progressWrap = el("div", "job-progress");
  const progress = el("progress");
  progress.max = Math.max(1, slices.length);
  progress.value = complete;
  progress.setAttribute("aria-label", `${job.name || "Capture"}: ${complete} of ${slices.length} localities complete`);
  progressWrap.append(progress, el("span", "", `${fmt(complete)} / ${fmt(slices.length)} complete`));
  const bottom = el("div", "job-bottom");
  const stats = el("div", "job-stats");
  for (const [value, label] of [[pages, "committed pages"], [rows, "captured rows"]]) {
    const stat = el("span"); stat.append(el("strong", "", fmt(value)), document.createTextNode(` ${label}`)); stats.append(stat);
  }
  const actions = el("div", "job-actions");
  const view = focusKey(el("button", "secondary-button", job.id === selectedJobId ? "Viewing localities" : "View localities"), `${job.id}:view`);
  view.type = "button";
  view.setAttribute("aria-pressed", String(job.id === selectedJobId));
  view.addEventListener("click", () => { selectedJobId = job.id; retryNames.clear(); renderQueue(true); renderDetail(true); });
  actions.append(view);
  if (["queued", "pending"].includes(job.status)) actions.append(actionButton("Start capture", "start", job, true));
  if (job.status === "running") actions.append(actionButton("Pause", "pause", job));
  if (["paused", "interrupted"].includes(job.status)) actions.append(actionButton("Resume", "resume", job, true));
  const hasRetryableSlices = slices.some((slice) => retryStates.has(slice.status));
  if (["paused", "interrupted", "failed", "finished-with-exceptions", "source-challenge"].includes(job.status) && hasRetryableSlices) actions.append(actionButton("Retry incomplete", "retry", job, true));
  if (job.status === "failed" && !hasRetryableSlices && slices.some((slice) => ["pending", "running"].includes(slice.status))) actions.append(actionButton("Retry capture", "retry", job, true));
  bottom.append(stats, actions);
  card.append(top, progressWrap, bottom);
  const notices = {
    pausing: "Pause requested. The current page will be committed before the worker stops.",
    paused: "Checkpoints are saved. Resume continues from the next uncommitted page.",
    interrupted: "The worker stopped. Resume checks saved pages before continuing.",
    "source-challenge": "Check the visible Chrome window. Retry only after resolving the source’s prompt.",
  };
  if (notices[job.status]) card.append(el("p", "job-notice", notices[job.status]));
  if (needsPilot(job) && !state?.pilot?.passed && job.status !== "complete") card.append(el("p", "job-notice", "A successful small pilot is required before a capture larger than three localities can start."));
  if (job.error) card.append(el("p", "job-error", failureText(job.error)));
  return card;
}
function renderQueue(force = false) {
  const jobs = state?.jobs || [];
  const signature = JSON.stringify([jobs, selectedJobId, state?.activeJobId, state?.pilot?.passed, actionPending]);
  if (!force && signature === queueSignature) return;
  queueSignature = signature;
  byId("queue-count").textContent = fmt(jobs.length);
  byId("queue-empty").hidden = jobs.length > 0;
  preserveFocus(() => byId("job-list").replaceChildren(...jobs.map(renderJob)));
}
function renderDetail(force = false) {
  const job = selectedJob();
  byId("job-detail").hidden = !job;
  if (!job) return;
  const filter = byId("slice-filter").value;
  const signature = JSON.stringify([job, filter, [...retryNames], actionPending, Boolean(activeBusyJob())]);
  if (!force && signature === detailSignature) return;
  detailSignature = signature;
  byId("detail-heading").textContent = job.name || "Locality progress";
  byId("detail-status").replaceWith(Object.assign(statusTag(job.status), { id: "detail-status" }));
  const meta = [];
  for (const [label, value] of [["Capture", job.runId], ["Updated", `${formattedDate(job.updatedAt)} AWST`]]) {
    if (!value) continue;
    const node = el("span"); node.append(el("strong", "", `${label} `), document.createTextNode(value)); meta.push(node);
  }
  if (job.outputDirectory) meta.push(el("span", "capture-path", job.outputDirectory));
  byId("capture-meta").replaceChildren(...meta);
  const slices = jobSlices(job);
  const filtered = slices.filter((slice) => filter === "all" || (filter === "incomplete" && slice.status !== "complete") || (filter === "complete" && slice.status === "complete") || (filter === "exceptions" && exceptionStates.has(slice.status)));
  const rows = filtered.map((slice) => {
    const row = el("tr");
    const check = el("td", "check-cell");
    if (retryStates.has(slice.status)) {
      const input = focusKey(el("input"), `${job.id}:retry:${slice.name}`);
      input.type = "checkbox";
      input.checked = retryNames.has(slice.name);
      input.disabled = actionPending || Boolean(activeBusyJob());
      input.setAttribute("aria-label", `Select ${slice.suburb} ${slice.postcode} for retry`);
      input.addEventListener("change", () => {
        if (input.checked) retryNames.add(slice.name); else retryNames.delete(slice.name);
        updateRetryButton();
      });
      check.append(input);
    }
    const locality = el("td");
    const localityName = el("span", "locality-name", slice.suburb);
    localityName.append(el("small", "", slice.postcode));
    locality.append(localityName);
    const failure = failureText(slice.failure);
    if (failure) locality.append(el("span", "slice-failure", failure));
    if (slice.status === "capped") locality.append(el("span", "slice-failure", "Page limit reached. Create a new capture with a higher limit."));
    const status = el("td"); status.append(statusTag(slice.status));
    row.append(check, locality, status, el("td", "numeric", fmt(committedPages(slice))), el("td", "numeric", fmt(rowCount(slice))));
    return row;
  });
  const scrollTop = byId("slice-rows").parentElement.parentElement.scrollTop;
  preserveFocus(() => byId("slice-rows").replaceChildren(...rows));
  byId("slice-rows").parentElement.parentElement.scrollTop = scrollTop;
  byId("slice-count").textContent = `${fmt(filtered.length)} of ${fmt(slices.length)} localities`;
  byId("slice-empty").hidden = filtered.length > 0;
  updateRetryButton();
}
function updateRetryButton() {
  const job = selectedJob();
  const button = byId("retry-selected");
  const names = jobSlices(job || {}).filter((slice) => retryStates.has(slice.status) && retryNames.has(slice.name)).map((slice) => slice.name);
  button.hidden = names.length === 0;
  button.disabled = actionPending || Boolean(activeBusyJob()) || (job && needsPilot(job) && !state?.pilot?.passed);
  button.textContent = `Retry ${fmt(names.length)} selected`;
}
function renderState(next) {
  state = next;
  const catalogue = state.catalogue || [];
  const nextSignature = JSON.stringify(catalogue);
  if (catalogueSignature !== nextSignature) {
    const initial = !catalogueSignature;
    catalogueSignature = nextSignature;
    const available = new Set(catalogue.map((item) => item.id));
    selectedIds = new Set([...selectedIds].filter((id) => available.has(id)));
    if (initial && !selectedIds.size) {
      const hocking = catalogue.find((item) => item.suburb.toLocaleLowerCase("en-AU") === "hocking");
      if (hocking) selectedIds.add(hocking.id);
    }
    renderPicker();
  }
  if (!(state.jobs || []).some((job) => job.id === selectedJobId)) {
    selectedJobId = state.activeJobId || state.jobs?.[0]?.id || null;
    retryNames.clear();
  }
  const worker = state.worker || {};
  const workerLabels = {
    idle: "Ready to start", starting: "Opening dedicated Chrome profile", running: "Collecting listing responses",
    pausing: "Finishing and saving the current page", paused: "Paused · checkpoints saved", "source-challenge": "Waiting for attention in Chrome",
    complete: "Capture complete", "finished-with-exceptions": "Stopped with exceptions", error: "Worker error", closed: "Chrome closed",
  };
  byId("worker-status").textContent = worker.error ? `${workerLabels[worker.state] || worker.state || "Ready"} · ${failureText(worker.error)}` : workerLabels[worker.state] || worker.state || "Ready to start";
  updateComposer();
  renderQueue();
  renderDetail();
  byId("last-updated").textContent = `Checked ${new Intl.DateTimeFormat("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Australia/Perth" }).format(new Date())} AWST`;
}
function setConnection(connected, error) {
  const node = byId("connection-status");
  const label = connected ? "Connected" : "Disconnected";
  if (node.textContent !== label) node.textContent = label;
  node.dataset.state = connected ? "connected" : "error";
  byId("connection-error").hidden = connected;
  const message = error || "The local server is unavailable. Saved captures remain on disk.";
  if (byId("connection-error").textContent !== message) byId("connection-error").textContent = message;
}
async function requestJson(url, options = {}, signal) {
  const response = await fetch(url, { ...options, signal, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", ...options.headers } });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error(`Local server returned an unexpected response (${response.status}).`);
  const data = await response.json();
  if (!response.ok) throw new Error(failureText(data.error || data.message) || `Request failed (${response.status}).`);
  return data;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden || actionPending) return;
  pollTimer = setTimeout(() => { void poll(); }, Math.min(15000, 2500 * 2 ** pollFailures));
}
async function poll() {
  if (pollPromise || document.hidden || actionPending) return pollPromise;
  pollController = new AbortController();
  const timeout = setTimeout(() => pollController?.abort("timeout"), 10000);
  pollPromise = (async () => {
    try {
      const next = await requestJson("/api/state", {}, pollController.signal);
      renderState(next);
      pollFailures = 0;
      setConnection(true);
    } catch (error) {
      if (document.hidden || actionPending) return;
      pollFailures = Math.min(3, pollFailures + 1);
      setConnection(false, `${error.message || "The local server is unavailable."} Reconnecting automatically.`);
    } finally {
      clearTimeout(timeout);
      pollController = null;
      pollPromise = null;
      schedulePoll();
    }
  })();
  return pollPromise;
}
async function mutate(url, body, pendingMessage) {
  if (actionPending) return null;
  actionPending = true;
  clearTimeout(pollTimer);
  pollController?.abort("action");
  if (pollPromise) await pollPromise;
  updateComposer(); renderQueue(true); renderDetail(true);
  showMessage(pendingMessage, "pending");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 65000);
  try {
    const result = await requestJson(url, { method: "POST", body: JSON.stringify(body) }, controller.signal);
    return result;
  } catch (error) {
    showMessage(controller.signal.aborted ? "The action is taking longer than expected. Check the queue status before trying again." : error.message || "The action failed.", "error");
    return null;
  } finally {
    clearTimeout(timeout);
    actionPending = false;
    updateComposer();
    await poll();
  }
}
async function performAction(id, action, sliceNames) {
  const messages = {
    start: "Opening visible Chrome for this capture…",
    resume: "Checking saved pages and resuming capture…",
    pause: "Pause requested. Waiting for the current page to finish and save…",
    retry: "Retrying capture from its saved checkpoints…",
  };
  const result = await mutate(`/api/jobs/${encodeURIComponent(id)}/${action}`, sliceNames ? { sliceNames } : {}, messages[action]);
  if (!result) return;
  if (action === "retry") retryNames.clear();
  const success = { start: "Capture started in visible Chrome.", resume: "Capture resumed from saved checkpoints.", pause: "Capture paused. Committed pages are saved.", retry: "Retry started. Existing committed pages are preserved." };
  const returnedStatus = result.job?.status;
  const outcomeMessages = {
    "source-challenge": "Chrome needs attention. Resolve the source’s prompt in the visible Chrome window, then explicitly retry the capture.",
    complete: "Capture complete. Dated data and committed pages are saved.",
    "finished-with-exceptions": "Capture stopped with exceptions. Review the locality results before retrying failed or partial captures.",
    failed: "The capture failed. Review the worker error and locality results before retrying.",
  };
  const outcomeTone = returnedStatus === "failed" ? "error" : ["source-challenge", "finished-with-exceptions"].includes(returnedStatus) ? "pending" : "success";
  showMessage(outcomeMessages[returnedStatus] || success[action], outcomeTone);
  renderDetail(true);
}

byId("capture-kind").addEventListener("change", () => { updateDefaultName(); updateComposer(); });
byId("locality-search").addEventListener("input", renderPicker);
byId("clear-selection").addEventListener("click", () => { selectedIds.clear(); renderPicker(); });
byId("slice-filter").addEventListener("change", () => renderDetail(true));
byId("retry-selected").addEventListener("click", () => {
  const job = selectedJob();
  if (!job) return;
  const names = jobSlices(job).filter((slice) => retryStates.has(slice.status) && retryNames.has(slice.name)).map((slice) => slice.name);
  if (names.length) void performAction(job.id, "retry", names);
});
function updateSettingsSummary() {
  document.querySelector(".settings summary span").textContent = `${byId("delay-seconds").value || "5"} sec · ${byId("max-pages").value || "100"} pages`;
}
byId("delay-seconds").addEventListener("input", updateSettingsSummary);
byId("max-pages").addEventListener("input", updateSettingsSummary);
byId("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (byId("create-button").disabled || !byId("create-form").reportValidity()) return;
  const kind = byId("capture-kind").value;
  const localityIds = kind === "perth-wide" ? (state?.catalogue || []).map((item) => item.id) : [...selectedIds];
  const body = { name: byId("capture-name").value.trim(), kind, localityIds, delayMs: Number(byId("delay-seconds").value) * 1000, maxPages: Number(byId("max-pages").value) };
  const result = await mutate("/api/jobs", body, "Saving the dated capture plan…");
  if (!result) return;
  if (result.job?.id) { selectedJobId = result.job.id; retryNames.clear(); renderQueue(true); renderDetail(true); }
  showMessage("Capture added to the queue. Select Start capture when ready.");
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (document.hidden) pollController?.abort("hidden"); else void poll();
});
window.addEventListener("pagehide", () => { clearTimeout(pollTimer); pollController?.abort("closed"); });
updateDefaultName();
void poll();
