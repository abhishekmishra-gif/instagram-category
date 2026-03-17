/* ============================================================
   app.js — Influencer Category Dashboard
   ============================================================ */

// ── State ──
let currentJobs = [];
let batchPage = 1;
let batchTotalPages = 1;
let batchStatus = "all";
let batchSearchQuery = "";

// ── DOM Refs ──
const $ = (id) => document.getElementById(id);

const elTotalDocs = $("batchTotalDocs");
const elChunkSize = $("batchChunkSize");
const btnConfirm = $("btnConfirmStart");
const btnStopSession = $("btnStopSession");
const sessionProgress = $("sessionProgress");
const btnSync = $("btnSync");

// ── Utilities ──
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function getStatusDot(status) {
  const low = status.toLowerCase();
  if (low === "completed") return "dot-done";
  if (["failed", "expired", "cancelled"].includes(low)) return "dot-null";
  return "dot-pending";
}

// ── Theme Toggle ──
function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeButton(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeButton(next);
}

function updateThemeButton(theme) {
  const toggle = $("themeToggle");
  const label = $("themeLabel");
  if (theme === "dark") {
    toggle.innerHTML = "☀️ <span id='themeLabel'>Light</span>";
  } else {
    toggle.innerHTML = "🌙 <span id='themeLabel'>Dark</span>";
  }
}

// ── Toast Notifications ──
function showToast(message, type = "info", duration = 4000) {
  const container = $("toastContainer");
  const toast = document.createElement("div");
  const iconMap = { success: "✅", error: "❌", info: "ℹ️" };
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${iconMap[type] || "ℹ️"}</span> ${message}`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Confirm Modal ──
function showConfirm(title, message, icon = "❓") {
  return new Promise((resolve) => {
    const modal = $("confirmModal");
    const titleEl = $("confirmTitle");
    const messageEl = $("confirmMessage");
    const iconEl = $("confirmIcon");
    const btnYes = $("btnConfirmYes");
    const btnNo = $("btnConfirmNo");

    titleEl.innerText = title;
    messageEl.innerText = message;
    iconEl.innerText = icon;
    btnNo.style.display = "block";
    btnYes.innerText = "Yes";
    btnYes.className = "confirm-btn confirm-btn--ok";

    modal.classList.add("active");

    const onYes = () => { modal.classList.remove("active"); cleanup(); resolve(true); };
    const onNo = () => { modal.classList.remove("active"); cleanup(); resolve(false); };
    const cleanup = () => { btnYes.removeEventListener("click", onYes); btnNo.removeEventListener("click", onNo); };

    btnYes.addEventListener("click", onYes);
    btnNo.addEventListener("click", onNo);
  });
}

function showAlert(title, message, icon = "ℹ️", isError = false) {
  const modal = $("confirmModal");
  $("confirmTitle").innerText = title;
  $("confirmMessage").innerText = message;
  $("confirmIcon").innerText = icon;
  $("btnConfirmNo").style.display = "none";

  const btnYes = $("btnConfirmYes");
  btnYes.innerText = "OK";
  btnYes.className = isError ? "confirm-btn confirm-btn--danger" : "confirm-btn confirm-btn--ok";
  modal.classList.add("active");

  const onOk = () => { modal.classList.remove("active"); btnYes.removeEventListener("click", onOk); };
  btnYes.addEventListener("click", onOk);
}

// ── Stats ──
async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const s = await res.json();
    $("statTotal").textContent = formatNumber(s.total);
    $("statProcessed").textContent = formatNumber(s.processed);
    $("statWithCategory").textContent = formatNumber(s.withCategory);
    $("statNoCategory").textContent = formatNumber(s.noCategory);
    $("statPriceSpent").textContent = s.totalCost !== undefined ? "$" + s.totalCost.toFixed(2) : "$0.00";

    // Hero progress bar
    const pct = s.total > 0 ? ((s.processed / s.total) * 100).toFixed(1) : 0;
    const fillEl = $("heroProgressFill");
    const textEl = $("heroProgressText");
    if (fillEl) fillEl.style.width = pct + "%";
    if (textEl) textEl.textContent = `${pct}% categorized — ${formatNumber(s.processed)} of ${formatNumber(s.total)}`;

    // Contextual subtitles
    const processedPct = s.total > 0 ? ((s.processed / s.total) * 100).toFixed(1) : 0;
    const catPct = s.processed > 0 ? ((s.withCategory / s.processed) * 100).toFixed(0) : 0;
    const costPerInf = s.processed > 0 ? (s.totalCost / s.processed).toFixed(4) : "—";

    const procSub = $("statProcessedSub");
    const catSub = $("statCategorySub");
    const noCatSub = $("statNoCategorySub");
    const costSub = $("statCostSub");
    if (procSub) procSub.textContent = `${processedPct}% of total`;
    if (catSub) catSub.textContent = `${catPct}% success rate`;
    const disqualifiedPct = s.total > 0 ? ((s.noCategory / s.total) * 100).toFixed(1) : 0;
    if (noCatSub) noCatSub.textContent = `${disqualifiedPct}% of total`;
    if (costSub) costSub.textContent = `$${costPerInf} per influencer`;
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

// ── Batch Jobs ──
async function fetchJobs(page = 1) {
  try {
    batchPage = page;
    const res = await fetch(`/api/openai-batch/list?page=${page}&limit=10&status=${batchStatus}&search=${batchSearchQuery}`);
    const data = await res.json();
    currentJobs = data.jobs;
    batchTotalPages = data.pages;
    const countEl = $("tableJobCount");
    if (countEl) countEl.textContent = data.total || currentJobs.length;
    renderTable();
    updateBatchPagination();
  } catch (err) {
    console.error(err);
  }
}

function renderTable() {
  const tbody = $("tableBody");
  if (currentJobs.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <div class="empty-state-title">No batch jobs found</div>
          <div class="empty-state-desc">Start a session or adjust your filters to see batch jobs here.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = currentJobs.map((job) => {
    const costHtml = job.cost > 0 ? "$" + job.cost.toFixed(4) : "—";
    const canRerun = !["validating", "in_progress", "finalizing", "in_queue", "cancelling"].includes(job.status.toLowerCase());
    const canCancel = ["in_progress", "validating", "finalizing", "in_queue"].includes(job.status.toLowerCase());
    const statusLow = job.status.toLowerCase();
    const statusClass = `status-pill status-pill--${statusLow}`;
    const rowClass = statusLow === "in_progress" ? " class=\"row-in-progress\"" : "";
    let actionHtml = "—";
    if (canCancel) {
      actionHtml = `<button class="btn-cancel-single" onclick="cancelBatch('${job.batch_id}')">Cancel</button>`;
    } else if (canRerun) {
      actionHtml = `<button class="btn-rerun" onclick="rerunBatch('${job.batch_id}')">Rerun</button>`;
    }
    return `
      <tr${rowClass} onclick="showBatchDetails('${job.batch_id}')">
        <td class="td-status">
          <span class="${statusClass}"><span class="status-pill-dot"></span>${job.status.replace("_", " ")}</span>
        </td>
        <td class="td-batchid">${job.batch_id || "Generating..."}</td>
        <td>${formatNumber(job.doc_count)}</td>
        <td class="td-progress">
          <div class="td-progress-inner">
            <div class="td-progress-bar">
              <div class="td-progress-fill" style="width: ${job.progress || 0}%;"></div>
            </div>
            <span class="td-progress-text">${job.progress || 0}%</span>
          </div>
        </td>
        <td>${formatNumber(job.tokens || 0)}</td>
        <td class="td-cost">${costHtml}</td>
        <td class="td-date">${formatDate(job.created_at)}</td>
        <td class="td-error">${job.error || "—"}</td>
        <td class="td-action" style="text-align: center;" onclick="event.stopPropagation()">
          ${actionHtml}
        </td>
      </tr>`;
  }).join("");
}

function updateBatchPagination() {
  const pagination = $("batchPagination");
  const info = $("batchPageInfo");
  const btnPrev = $("btnPrevBatch");
  const btnNext = $("btnNextBatch");

  if (batchTotalPages > 1) {
    pagination.style.display = "flex";
    info.innerText = `Page ${batchPage} of ${batchTotalPages}`;
    btnPrev.disabled = batchPage === 1;
    btnNext.disabled = batchPage === batchTotalPages;
  } else {
    pagination.style.display = "none";
  }
}

async function rerunBatch(batchId) {
  const confirmed = await showConfirm(
    "Rerun Batch",
    "Are you sure you want to rerun this failed batch? This will create a new OpenAI batch job for the same influencers.",
    "🔄"
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/openai-batch/${batchId}/rerun`, { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast(`New batch created: ${data.newBatchId}`, "success");
    fetchJobs(1);
    loadStats();
  } catch (err) {
    showAlert("Error", "Error rerunning batch: " + err.message, "❌", true);
  }
}

async function cancelBatch(batchId) {
  try {
    const res = await fetch(`/api/openai-batch/${batchId}/cancel`, { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast("Batch cancelling...", "success");
    fetchJobs(batchPage);
  } catch (err) {
    showAlert("Error", "Cancel failed: " + err.message, "❌", true);
  }
}

// ── Batch Details Modal ──
let currentBatchTiming = null;

async function showBatchDetails(batchId) {
  const modal = $("batchDetailsModal");
  $("detailBatchId").innerText = batchId;
  const tbody = $("detailsTbody");
  const loading = $("detailsLoading");
  const content = $("detailsContent");
  const timePanel = $("batchTimePanel");
  const timeBtn = $("btnBatchTime");

  tbody.innerHTML = "";
  loading.classList.add("active");
  content.style.display = "none";
  timePanel.style.display = "none";
  timeBtn.classList.remove("active");
  modal.classList.add("active");

  try {
    const res = await fetch(`/api/openai-batch/${batchId}/influencers`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const influencers = data.influencers || data;
    currentBatchTiming = data.timing || null;

    // Populate time stats if timing available
    if (currentBatchTiming) {
      const created = currentBatchTiming.created_at ? new Date(currentBatchTiming.created_at) : null;
      const completed = currentBatchTiming.completed_at ? new Date(currentBatchTiming.completed_at) : null;

      $("batchTimeCreated").textContent = created ? created.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
      $("batchTimeCompleted").textContent = completed ? completed.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "In progress";

      if (created && completed) {
        const diffMs = completed - created;
        const mins = Math.floor(diffMs / 60000);
        const secs = Math.floor((diffMs % 60000) / 1000);
        $("batchTimeDuration").textContent = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

        const docs = currentBatchTiming.doc_count || influencers.length;
        const docsPerMin = mins > 0 ? (docs / (diffMs / 60000)).toFixed(1) : docs;
        $("batchTimeSpeed").textContent = `${docsPerMin} influencers/min`;
      } else {
        $("batchTimeDuration").textContent = "—";
        $("batchTimeSpeed").textContent = "—";
      }
    }

    tbody.innerHTML = influencers.map((inf) => {
      const avatarHtml = inf.avatar
        ? `<img src="${inf.avatar}" class="avatar-sm" style="border-radius: 50%; object-fit: cover;" />`
        : `<div class="avatar-fallback avatar-sm">${(inf.name || inf.handle || "@")[0].toUpperCase()}</div>`;

      const catHtml = inf.category
        ? `<span class="badge badge-success">${inf.category}</span>`
        : `<span class="badge badge-pending">PENDING</span>`;

      const subCatHtml = (inf.subCategories || [])
        .map(sc => `<span class="badge badge-sm" style="background: var(--divider); color: var(--text-secondary); margin-top: 4px; display: inline-block;">${sc}</span>`)
        .join(" ");

      const costHtml = inf.cost > 0
        ? `<span class="td-cost">$${inf.cost.toFixed(4)}</span>`
        : "—";

      return `
        <tr>
          <td>
            <div class="details-influencer">
              ${avatarHtml}
              <a href="https://www.instagram.com/${inf.handle}/" target="_blank" rel="noopener">
                <span class="name-primary link">${inf.name || inf.handle || "—"}</span>
                ${inf.handle ? `<span class="name-handle">@${inf.handle}</span>` : ""}
              </a>
            </div>
          </td>
          <td>
            ${catHtml}
            <div style="margin-top: 4px;">${subCatHtml}</div>
          </td>
          <td>${costHtml}</td>
          <td>
            <button onclick="analyzeInstant('${inf.id}', this, '${batchId}')" class="btn-instant">
              <span>Instant</span> ⚡
            </button>
          </td>
        </tr>`;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 20px; color: var(--color-error);">Error loading details: ${err.message}</td></tr>`;
  } finally {
    loading.classList.remove("active");
    content.style.display = "block";
  }
}

// ── Instant Analysis ──
async function analyzeInstant(influencerId, btn, batchId) {
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Analyzing...</span>`;
  btn.style.color = "var(--text-secondary)";
  btn.style.borderColor = "var(--text-secondary)";

  try {
    const res = await fetch(`/api/process/rerun/${influencerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showToast(`Analyzed: ${data.result.category || "No Category"}`, "success");

    const row = btn.closest("tr");
    if (row) {
      const catCell = row.cells[1];
      const costCell = row.cells[2];

      const catHtml = data.result.category
        ? `<span class="badge badge-success">${data.result.category}</span>`
        : `<span class="badge badge-error">NO CATEGORY</span>`;

      const subCatHtml = (data.result.subCategories || [])
        .map(sc => `<span class="badge badge-sm" style="background: var(--divider); color: var(--text-secondary); margin-top: 4px; display: inline-block;">${sc}</span>`)
        .join(" ");

      catCell.innerHTML = `${catHtml}<div style="margin-top: 4px;">${subCatHtml}</div>`;
      if (costCell && data.result.cost) costCell.innerHTML = `<span class="td-cost">$${data.result.cost.toFixed(4)}</span>`;
    }

    if (data.batchCompleted) {
      showToast("🎉 Batch complete — all influencers processed!", "success", 6000);
      fetchJobs(batchPage);
    }

    if (typeof loadStats === "function") loadStats();
  } catch (err) {
    showAlert("Error", "Analysis failed: " + err.message, "❌", true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    btn.style.color = "var(--color-primary)";
    btn.style.borderColor = "var(--color-primary)";
  }
}

// ── Session Logic ──
async function pollSessionStatus() {
  try {
    const res = await fetch("/api/openai-batch/session/status");
    const state = await res.json();

    if (state.isRunning || state.processedCount > 0 || state.timing || state.pendingDBCount > 0) {
      sessionProgress.style.display = "flex";
      $("sessionQueuedText").innerText = state.queuedCount || 0;
      $("sessionPendingText").innerText = state.pendingDBCount !== undefined ? state.pendingDBCount : "...";

      const dot = $("statusDot");
      const spinner = $("statusSpinner");
      const pctEl = $("sessionPct");
      const fillEl = $("sessionProgressFill");
      const processed = state.processedCount || 0;
      const pending = state.pendingDBCount || 0;
      const total = processed + pending;
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

      if (pctEl) pctEl.textContent = pct + "%";
      if (fillEl) fillEl.style.width = pct + "%";

      if (state.isRunning) {
        $("sessionStatusText").innerText = "Processing";
        $("sessionStatusText").style.color = "var(--color-primary)";
        if (dot) { dot.className = "status-chip-dot running"; }
        if (spinner) { spinner.style.display = "inline"; }
        btnStopSession.style.display = "inline-flex";
        btnConfirm.style.display = "none";
        elTotalDocs.disabled = true;
        elChunkSize.disabled = true;
      } else {
        const allDone = state.pendingDBCount === 0;
        $("sessionStatusText").innerText = allDone ? "Complete" : "Stopped";
        $("sessionStatusText").style.color = allDone ? "var(--color-success)" : "var(--color-error)";
        if (dot) { dot.className = allDone ? "status-chip-dot done" : "status-chip-dot stopped"; }
        if (spinner) { spinner.style.display = "none"; }
        btnStopSession.style.display = "none";
        btnConfirm.style.display = "inline-flex";
        elTotalDocs.disabled = false;
        elChunkSize.disabled = false;
      }

      // Update Timing Card
      if (state.timing) {
        if (state.timing.started) $("timingStarted").innerText = formatDate(state.timing.started);
        if (state.timing.lastUpdated) {
          const diffMs = new Date() - new Date(state.timing.lastUpdated);
          const diffMins = Math.floor(diffMs / 60000);
          const diffSecs = Math.floor(diffMs / 1000);
          let timeAgoStr;
          if (diffMins > 60) timeAgoStr = Math.floor(diffMins / 60) + "h ago";
          else if (diffMins > 0) timeAgoStr = diffMins + "m ago";
          else timeAgoStr = diffSecs + "s ago";
          $("timingUpdated").innerText = timeAgoStr;
        }
        if (state.timing.elapsedHrs !== undefined && state.timing.elapsedMins !== undefined) {
          $("timingElapsed").innerText = `${state.timing.elapsedHrs}h ${state.timing.elapsedMins}m`;
        }
        if (state.timing.rate !== undefined)
          $("timingRate").innerText = `${state.timing.rate.toFixed(1)}/sec`;

        const lastIdToUse = state.latestBatchId || state.timing?.lastId;
        if (lastIdToUse) {
          const lastId = lastIdToUse.toString();
          const el = $("timingLastId");
          const displayId = lastId.startsWith("batch_") ? "batch_..." + lastId.slice(-8) : "..." + lastId.slice(-12);
          if (el.dataset.fullId !== lastId) {
            el.innerText = displayId;
            el.dataset.fullId = lastId;
          }
        } else {
          $("timingLastId").innerText = "—";
        }
      } else {
        $("timingStarted").innerText = "—";
        $("timingUpdated").innerText = "—";
        $("timingElapsed").innerText = "0h 0m";
        $("timingRate").innerText = "0.0/sec";
        $("timingLastId").innerText = "—";
      }
    } else {
      sessionProgress.style.display = "none";
      btnStopSession.style.display = "none";
      btnConfirm.style.display = "inline-flex";
      elTotalDocs.disabled = false;
      elChunkSize.disabled = false;
    }
  } catch (e) {
    console.error("Failed to poll session status:", e);
  }
}

// ── Event Listeners ──
function initEventListeners() {
  // Theme
  $("themeToggle").addEventListener("click", toggleTheme);

  // Search & Filter
  $("batchSearch").addEventListener("input", (e) => {
    batchSearchQuery = e.target.value;
    fetchJobs(1);
  });

  // Custom dropdown
  const filterWrap = $("batchStatusFilterWrap");
  const filterTrigger = $("filterTrigger");
  const filterMenu = $("filterMenu");
  const filterLabel = $("filterLabel");

  filterTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    filterWrap.classList.toggle("open");
  });

  filterMenu.querySelectorAll(".custom-select-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      filterMenu.querySelectorAll(".custom-select-option").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
      filterLabel.textContent = opt.textContent.trim();
      batchStatus = opt.dataset.value;
      filterWrap.classList.remove("open");
      fetchJobs(1);
    });
  });

  document.addEventListener("click", (e) => {
    if (!filterWrap.contains(e.target)) {
      filterWrap.classList.remove("open");
    }
  });

  // Pagination
  $("btnPrevBatch").addEventListener("click", () => {
    if (batchPage > 1) fetchJobs(batchPage - 1);
  });

  $("btnNextBatch").addEventListener("click", () => {
    if (batchPage < batchTotalPages) fetchJobs(batchPage + 1);
  });

  // Toggle time stats panel
  $("btnBatchTime").addEventListener("click", () => {
    const panel = $("batchTimePanel");
    const btn = $("btnBatchTime");
    const isVisible = panel.style.display !== "none";
    panel.style.display = isVisible ? "none" : "block";
    btn.classList.toggle("active", !isVisible);
  });

  // Close details modal
  $("btnCloseDetails").addEventListener("click", () => {
    $("batchDetailsModal").classList.remove("active");
  });

  $("batchDetailsModal").addEventListener("click", (e) => {
    if (e.target === $("batchDetailsModal")) {
      $("batchDetailsModal").classList.remove("active");
    }
  });

  // Timing Last ID copy
  $("timingLastId").addEventListener("click", function () {
    if (this.dataset.fullId) {
      navigator.clipboard.writeText(this.dataset.fullId);
      const original = this.innerHTML;
      this.innerHTML = '✓ Copied';
      setTimeout(() => this.innerHTML = original, 1500);
    }
  });

  // Start session
  btnConfirm.addEventListener("click", async () => {
    const limit = parseInt(elTotalDocs.value, 10);
    const chunk = parseInt(elChunkSize.value, 10);
    if (!limit || limit < 1 || !chunk || chunk < 1)
      return showAlert("Invalid Input", "Enter valid counts", "⚠️", true);
    if (chunk > limit)
      return showAlert("Invalid Batch Size", "Batch size cannot exceed influencers per round", "⚠️", true);

    btnConfirm.disabled = true;
    btnConfirm.innerText = "Starting...";
    try {
      const res = await fetch("/api/openai-batch/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, chunkSize: chunk }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await pollSessionStatus();
    } catch (err) {
      showAlert("Session Error", "Error: " + err.message, "❌", true);
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.innerText = "▶ Start Session";
    }
  });

  // Stop session
  btnStopSession.addEventListener("click", async () => {
    btnStopSession.disabled = true;
    btnStopSession.innerText = "Stopping...";
    try {
      await fetch("/api/openai-batch/session/stop", { method: "POST" });
      await pollSessionStatus();
    } catch (err) {
      console.error(err);
    } finally {
      btnStopSession.disabled = false;
      btnStopSession.innerText = "⏹ Stop Session";
    }
  });

  // Sync
  const syncOriginalHTML = btnSync.innerHTML;
  btnSync.addEventListener("click", async () => {
    const svgIcon = btnSync.querySelector("svg")?.outerHTML || "";
    btnSync.innerHTML = svgIcon + " Refreshing...";
    try {
      await fetch("/api/openai-batch/sync", { method: "POST" });
      await fetchJobs(batchPage);
      await loadStats();
      showToast("Results refreshed", "success");
    } catch (e) {
      showAlert("Sync Error", "Refresh failed: " + e.message, "❌", true);
    } finally {
      btnSync.innerHTML = syncOriginalHTML;
    }
  });

  // Cancel All Batches
  $("btnCancelAll").addEventListener("click", async () => {
    const confirmed = await showConfirm(
      "Cancel All Batches",
      "This will cancel all active OpenAI batches. Are you sure?",
      "⚠️"
    );
    if (!confirmed) return;

    const btn = $("btnCancelAll");
    btn.disabled = true;
    btn.innerText = "Cancelling...";
    try {
      const res = await fetch("/api/openai-batch/cancel-all", { method: "POST" });
      const data = await res.json();
      await fetchJobs(batchPage);
      await pollSessionStatus();
      showToast(`${data.cancelled} batch(es) cancelled`, "success");
    } catch (err) {
      showAlert("Error", "Failed to cancel: " + err.message, "❌", true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Cancel All`;
    }
  });

  // Resume — show preview modal first
  $("btnResume").addEventListener("click", async () => {
    const modal = $('resumeModal');
    modal.classList.add('active');
    $("resumePreviewLoading").style.display = "block";
    $("resumePreviewContent").style.display = "none";
    $("resumePreviewEmpty").style.display = "none";
    $("resumeModalFooter").style.display = "none";

    try {
      const res = await fetch("/api/openai-batch/resume/preview");
      const data = await res.json();

      $("resumePreviewLoading").style.display = "none";

      if (data.cancelledBatches === 0) {
        $("resumePreviewEmpty").style.display = "block";
        return;
      }

      $("rpCancelledCount").textContent = data.cancelledBatches;
      $("rpTotalCount").textContent = formatNumber(data.totalInfluencers);
      $("rpProcessedCount").textContent = formatNumber(data.processed);
      $("rpUnprocessedCount").textContent = formatNumber(data.unprocessed);

      // Render batch list
      $("rpBatchList").innerHTML = data.batches.map(b => `
        <div class="resume-batch-item">
          <span class="resume-batch-item-id">${b.batch_id.substring(0, 28)}...</span>
          <span class="resume-batch-item-count">${b.doc_count} influencers</span>
        </div>
      `).join("");

      $("resumePreviewContent").style.display = "block";
      if (data.unprocessed > 0) {
        $("resumeModalFooter").style.display = "flex";
      }
    } catch (err) {
      $("resumePreviewLoading").innerText = "Error loading preview: " + err.message;
    }
  });

  // Confirm Resume
  $("btnConfirmResume").addEventListener("click", async () => {
    const btn = $("btnConfirmResume");
    btn.disabled = true;
    btn.innerText = "Resuming...";
    try {
      const res = await fetch("/api/openai-batch/resume", { method: "POST" });
      const data = await res.json();
      $('resumeModal').classList.remove('active');
      await fetchJobs(batchPage);
      await pollSessionStatus();
      if (data.batchesCreated > 0) {
        showToast(`Resumed: ${data.batchesCreated} batch(es) for ${data.totalUnprocessed} influencers`, "success");
      } else {
        showToast(data.message || "No unprocessed influencers to resume", "info");
      }
    } catch (err) {
      showAlert("Error", "Resume failed: " + err.message, "❌", true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg> Confirm Resume`;
    }
  });
}

// ── Initialize ──
function init() {
  initTheme();
  initEventListeners();
  loadStats();
  fetchJobs(1);
  pollSessionStatus();

  // Background sync every 15 seconds
  setInterval(async () => {
    fetch("/api/openai-batch/sync", { method: "POST" })
      .then(() => {
        fetchJobs(batchPage);
        pollSessionStatus();
        loadStats();
      })
      .catch(console.error);
  }, 15000);
}

init();
