const STATUSES = [
  { name: "Not Started", color: "#9ca3af" },
  { name: "Reached Out", color: "#3b82f6" },
  { name: "Active Dialogue", color: "#f59e0b" },
  { name: "Under LOI", color: "#22c55e" },
  { name: "Dead", color: "#ef4444" },
];

const PRIORITIES = ["Normal", "High", "Watch"];

const STORAGE_KEY = "pasco-site-tracker-v1";
const DATA_URL = "./data/parcels.json";
const SUPABASE_TABLE = "parcels";
const LOCAL_SAVE_DELAY = 350;
const SHARED_SAVE_DELAY = 900;
const SHARED_REFRESH_MS = 25000;

const state = {
  parcels: [],
  salesComps: Array.isArray(window.PASCO_SALES_COMPS) ? window.PASCO_SALES_COMPS : [],
  selectedId: null,
  activeStatus: "all",
  search: "",
  showArchived: false,
  showTargets: true,
  showComps: false,
  notificationsOpen: false,
  layerMode: "satellite",
  viewMode: "map",
  focusMode: false,
  pendingImport: [],
  dirtyParcelIds: new Set(),
  sharedMode: false,
  authUser: null,
  currentUser: "Signed In",
  chromeBound: false,
  placementMode: null,
};

let map;
let roadLayer;
let satelliteLayer;
let markers = new Map();
let compMarkers = new Map();
let newPinPreviewMarker;
let saveTimer;
let sharedClient;
let sharedSaveTimer;
let sharedRefreshTimer;
let sharedErrorShown = false;

const els = {};

document.addEventListener("DOMContentLoaded", start);

async function start() {
  cacheElements();
  bindAccessEvents();
  try {
    sharedClient = createSupabaseClient();
    if (!sharedClient) {
      showAccessGate("Shared login is not configured yet.");
      return;
    }
    const { data, error } = await sharedClient.auth.getSession();
    if (error) throw error;
    if (!data.session?.user) {
      showAccessGate();
      return;
    }
    await initializeTracker(data.session.user);
  } catch (error) {
    console.error(error);
    showAccessGate("Could not reach the sign-in service. Refresh and try again.");
  }
}

async function initializeTracker(authUser) {
  if (!authUser) {
    showAccessGate();
    return;
  }
  document.body.classList.remove("locked");
  els.accessGate.hidden = true;
  state.authUser = authUser;
  state.currentUser = getUserLabel(authUser);
  renderCurrentUser();
  bindChromeEvents();
  renderStatusControls();
  renderNewStatusOptions();
  resetLocalStateIfRequested();

  try {
    setSync("Loading");
    const baseParcels = await loadBaseParcels();
    state.parcels = await loadInitialParcels(baseParcels);
    initMap();
    renderAll();
    setSync(state.sharedMode ? "Synced shared" : "Autosaved locally");
  } catch (error) {
    console.error(error);
    setSync("Load error");
    toast("Could not load parcel data. Run this through a local server.");
  }
}

function resetLocalStateIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset") !== "1") return;
  localStorage.removeItem(STORAGE_KEY);
  window.history.replaceState({}, document.title, window.location.pathname);
}

function bindAccessEvents() {
  els.accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canUseAuth()) return;
    els.accessError.textContent = "Signing in...";
    const { data, error } = await sharedClient.auth.signInWithPassword({
      email: els.authEmail.value.trim(),
      password: els.authPassword.value,
    });
    if (error || !data.user) {
      els.accessError.textContent = error?.message || "Sign-in failed.";
      els.authPassword.select();
      return;
    }
    els.authPassword.value = "";
    els.accessError.textContent = "";
    await initializeTracker(data.user);
  });

  els.createAccountBtn.addEventListener("click", async () => {
    if (!els.accessForm.reportValidity() || !canUseAuth()) return;
    els.accessError.textContent = "Creating account...";
    const { data, error } = await sharedClient.auth.signUp({
      email: els.authEmail.value.trim(),
      password: els.authPassword.value,
      options: {
        emailRedirectTo: getTrackerRedirectUrl(),
      },
    });
    if (error) {
      els.accessError.textContent = error.message || "Account creation failed.";
      return;
    }
    if (data.session?.user) {
      els.authPassword.value = "";
      els.accessError.textContent = "";
      await initializeTracker(data.session.user);
      return;
    }
    els.authPassword.value = "";
    els.accessError.textContent = "Account created. Check your email to confirm it, then sign in.";
  });
}

function showAccessGate(message = "") {
  document.body.classList.add("locked");
  els.accessGate.hidden = false;
  els.accessError.textContent = message;
  els.authPassword.value = "";
  els.authEmail.focus();
}

function canUseAuth() {
  if (sharedClient) return true;
  els.accessError.textContent = "Shared login is not configured yet.";
  return false;
}

function getTrackerRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function renderCurrentUser() {
  els.userBtn.textContent = state.currentUser;
  els.userBtn.title = "Sign out";
}

function cacheElements() {
  els.accessGate = document.getElementById("accessGate");
  els.accessForm = document.getElementById("accessForm");
  els.authEmail = document.getElementById("authEmail");
  els.authPassword = document.getElementById("authPassword");
  els.createAccountBtn = document.getElementById("createAccountBtn");
  els.accessError = document.getElementById("accessError");
  els.map = document.getElementById("map");
  els.worklist = document.getElementById("worklist");
  els.pipelineView = document.getElementById("pipelineView");
  els.listView = document.getElementById("listView");
  els.viewToggle = document.getElementById("viewToggle");
  els.statusFilters = document.getElementById("statusFilters");
  els.summaryBar = document.getElementById("summaryBar");
  els.sidePanel = document.getElementById("sidePanel");
  els.notificationDrawer = document.getElementById("notificationDrawer");
  els.notificationBtn = document.getElementById("notificationBtn");
  els.notificationCount = document.getElementById("notificationCount");
  els.searchInput = document.getElementById("searchInput");
  els.targetsBtn = document.getElementById("targetsBtn");
  els.compsBtn = document.getElementById("compsBtn");
  els.showArchived = document.getElementById("showArchived");
  els.syncState = document.getElementById("syncState");
  els.toast = document.getElementById("toast");
  els.satelliteBtn = document.getElementById("satelliteBtn");
  els.roadBtn = document.getElementById("roadBtn");
  els.focusBtn = document.getElementById("focusBtn");
  els.focusExitBtn = document.getElementById("focusExitBtn");
  els.userBtn = document.getElementById("userBtn");
  els.saveBtn = document.getElementById("saveBtn");
  els.backupBtn = document.getElementById("backupBtn");
  els.parcelModal = document.getElementById("parcelModal");
  els.parcelForm = document.getElementById("parcelForm");
  els.importModal = document.getElementById("importModal");
  els.importForm = document.getElementById("importForm");
  els.importFile = document.getElementById("importFile");
  els.importResult = document.getElementById("importResult");
  els.importPreview = document.getElementById("importPreview");
  els.commitImportBtn = document.getElementById("commitImportBtn");
}

async function loadBaseParcels() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Parcel data failed to load: ${response.status}`);
    }
    const parcels = await response.json();
    return parcels.map(normalizeParcel);
  } catch (error) {
    if (getSupabaseConfig()) {
      console.warn("Local parcel file unavailable; loading from Supabase.", error);
      return [];
    }
    throw error;
  }
}

function normalizeParcel(parcel) {
  return {
    ...parcel,
    status: normalizeStatus(parcel.status),
    category: parcel.category || parcel.type || "Land",
    lat: numericOrNull(parcel.lat),
    lng: numericOrNull(parcel.lng),
    priority: parcel.priority || "Normal",
    nextAction: parcel.nextAction || "",
    nextActionDue: parcel.nextActionDue || "",
    notes: parcel.notes || "",
    activity: Array.isArray(parcel.activity) ? parcel.activity : Array.isArray(parcel.comments) ? parcel.comments : [],
    comments: Array.isArray(parcel.comments) ? parcel.comments : [],
    actions: Array.isArray(parcel.actions) ? parcel.actions : [],
    extraFields: parcel.extraFields || parcel.extraData || {},
    documents: Array.isArray(parcel.documents) ? parcel.documents : [],
    attentionItems: Array.isArray(parcel.attentionItems) ? parcel.attentionItems : [],
    contact: {
      name: parcel.contact?.name || "",
      phones: Array.isArray(parcel.contact?.phones) ? parcel.contact.phones : [],
      emails: Array.isArray(parcel.contact?.emails) ? parcel.contact.emails : [],
    },
    owner: {
      name: parcel.owner?.name || "",
      mailingAddress: parcel.owner?.mailingAddress || "",
      mailingCity: parcel.owner?.mailingCity || "",
      mailingState: parcel.owner?.mailingState || "",
      mailingZip: parcel.owner?.mailingZip || "",
    },
    archived: Boolean(parcel.archived),
    deleted: Boolean(parcel.deleted),
  };
}

function normalizeStatus(status) {
  if (status === "Pending") return "Not Started";
  if (status === "Engaged") return "Active Dialogue";
  return STATUSES.some((item) => item.name === status) ? status : "Not Started";
}

function loadSavedState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function mergeSavedState(baseParcels, savedState) {
  if (!savedState?.parcels?.length) {
    return baseParcels;
  }
  const savedById = new Map(savedState.parcels.map((parcel) => [parcel.id, normalizeParcel(parcel)]));
  const merged = baseParcels.map((parcel) => savedById.get(parcel.id) || parcel);
  const baseIds = new Set(baseParcels.map((parcel) => parcel.id));
  savedState.parcels.forEach((parcel) => {
    if (!baseIds.has(parcel.id)) {
      merged.push(normalizeParcel(parcel));
    }
  });
  return merged;
}

async function loadInitialParcels(baseParcels) {
  const localParcels = mergeSavedState(baseParcels, loadSavedState());
  if (!sharedClient) {
    return localParcels;
  }

  try {
    setSync("Connecting shared");
    state.sharedMode = true;
    const sharedParcels = await loadSharedParcels();

    if (!sharedParcels.length) {
      setSync("Seeding shared");
      await upsertSharedParcels(localParcels);
      startSharedRefresh();
      return localParcels;
    }

    startSharedRefresh();
    return sharedParcels;
  } catch (error) {
    console.error(error);
    sharedClient = null;
    state.sharedMode = false;
    toast("Supabase is not connected yet. Using this computer only.");
    return localParcels;
  }
}

function createSupabaseClient() {
  const config = getSupabaseConfig();
  return config ? window.supabase.createClient(config.url, config.anonKey) : null;
}

function getSupabaseConfig() {
  const config = window.PASCO_SUPABASE || {};
  if (!config.enabled || !config.url || !config.anonKey) return null;
  if (!window.supabase?.createClient) {
    throw new Error("Supabase library did not load.");
  }
  return config;
}

function getUserLabel(user = state.authUser) {
  const email = String(user?.email || "").trim();
  if (email.toLowerCase() === "gregg.bazzani1@gmail.com") return "Gregg";
  return user?.user_metadata?.display_name || email || "Signed In";
}

async function loadSharedParcels() {
  const { data, error } = await sharedClient
    .from(SUPABASE_TABLE)
    .select("id,data,updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data || []).map((row) => normalizeParcel({ id: row.id, ...(row.data || {}) }));
}

function parcelToSharedRow(parcel) {
  return {
    id: parcel.id,
    data: {
      ...parcel,
      id: parcel.id,
      updatedAt: parcel.updatedAt || new Date().toISOString(),
    },
  };
}

async function upsertSharedParcels(parcels) {
  if (!sharedClient || !parcels.length) return;
  const rows = parcels.map(parcelToSharedRow);
  const { error } = await sharedClient.from(SUPABASE_TABLE).upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

function markParcelDirty(parcelOrId) {
  const id = typeof parcelOrId === "string" ? parcelOrId : parcelOrId?.id;
  if (id) state.dirtyParcelIds.add(id);
}

function markParcelsDirty(parcels) {
  parcels.forEach(markParcelDirty);
}

function persistLocalSnapshot() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      parcels: state.parcels,
    })
  );
}

function persistNow(options = {}) {
  setSync(state.sharedMode ? "Saving shared" : "Saving");
  persistLocalSnapshot();
  if (options.sync === false || !state.sharedMode) {
    setSync(state.sharedMode ? "Saved locally" : "Autosaved locally");
    return;
  }
  scheduleSharedSync(80);
}

function persistSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, LOCAL_SAVE_DELAY);
}

function scheduleSharedSync(delay = SHARED_SAVE_DELAY) {
  if (!sharedClient) return;
  window.clearTimeout(sharedSaveTimer);
  sharedSaveTimer = window.setTimeout(flushSharedChanges, delay);
}

async function flushSharedChanges() {
  if (!sharedClient || !state.dirtyParcelIds.size) {
    if (state.sharedMode) setSync("Synced shared");
    return;
  }

  const ids = Array.from(state.dirtyParcelIds);
  const parcels = ids.map((id) => state.parcels.find((parcel) => parcel.id === id)).filter(Boolean);
  state.dirtyParcelIds.clear();

  try {
    setSync("Saving shared");
    await upsertSharedParcels(parcels);
    sharedErrorShown = false;
    setSync("Synced shared");
  } catch (error) {
    console.error(error);
    ids.forEach((id) => state.dirtyParcelIds.add(id));
    setSync("Shared save error");
    if (!sharedErrorShown) {
      toast("Shared save failed. Your changes are still saved on this computer.");
      sharedErrorShown = true;
    }
  }
}

function startSharedRefresh() {
  window.clearInterval(sharedRefreshTimer);
  sharedRefreshTimer = window.setInterval(refreshFromShared, SHARED_REFRESH_MS);
}

async function refreshFromShared() {
  if (!sharedClient || state.dirtyParcelIds.size) return;
  try {
    const sharedParcels = await loadSharedParcels();
    if (!sharedParcels.length) return;
    const selectedId = state.selectedId;
    state.parcels = sharedParcels;
    if (selectedId && !state.parcels.some((parcel) => parcel.id === selectedId)) {
      state.selectedId = null;
    }
    persistLocalSnapshot();
    renderAll();
    setSync("Synced shared");
  } catch (error) {
    console.error(error);
    setSync("Shared refresh error");
  }
}

function bindChromeEvents() {
  if (state.chromeBound) return;
  state.chromeBound = true;
  document.getElementById("addParcelBtn").addEventListener("click", openParcelModal);
  document.getElementById("importBtn").addEventListener("click", openImportModal);
  document.getElementById("exportBtn").addEventListener("click", exportCsv);
  els.backupBtn.addEventListener("click", exportBackup);
  document.getElementById("closeParcelModal").addEventListener("click", closeParcelModal);
  document.getElementById("cancelParcelBtn").addEventListener("click", closeParcelModal);
  document.getElementById("closeImportModal").addEventListener("click", closeImportModal);
  document.getElementById("cancelImportBtn").addEventListener("click", closeImportModal);
  document.getElementById("geocodeBtn").addEventListener("click", geocodeNewAddress);
  document.getElementById("placeNewPinBtn").addEventListener("click", startNewPinPlacement);
  document.getElementById("mapCenterBtn").addEventListener("click", useMapCenterForNewPin);
  document.getElementById("newStatus").addEventListener("change", refreshNewPinPreview);
  document.getElementById("newLat").addEventListener("change", refreshNewPinPreview);
  document.getElementById("newLng").addEventListener("change", refreshNewPinPreview);
  els.parcelForm.addEventListener("submit", addParcelFromForm);
  els.parcelModal.addEventListener("close", clearNewPinPreview);
  els.importFile.addEventListener("change", handleImportFile);
  els.commitImportBtn.addEventListener("click", commitImport);

  els.viewToggle.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setViewMode(button.dataset.view);
  });

  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderAll();
  });

  els.showArchived.addEventListener("change", (event) => {
    state.showArchived = event.target.checked;
    renderAll();
  });

  els.targetsBtn.addEventListener("click", () => {
    state.showTargets = !state.showTargets;
    renderPinVisibilityControls();
    renderMarkers();
  });
  els.compsBtn.addEventListener("click", () => {
    state.showComps = !state.showComps;
    renderPinVisibilityControls();
    renderMarkers();
  });

  els.satelliteBtn.addEventListener("click", () => setLayerMode("satellite"));
  els.roadBtn.addEventListener("click", () => setLayerMode("road"));
  els.notificationBtn.addEventListener("click", () => {
    state.notificationsOpen = !state.notificationsOpen;
    renderNotifications();
  });
  els.focusBtn.addEventListener("click", () => setFocusMode(true));
  els.focusExitBtn.addEventListener("click", () => setFocusMode(false));
  els.userBtn.addEventListener("click", async () => {
    await sharedClient?.auth.signOut();
    window.location.reload();
  });
  els.saveBtn.addEventListener("click", () => {
    persistNow();
    toast(state.sharedMode ? "Saved to shared tracker" : "Saved on this computer");
  });

  els.statusFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-status-filter]");
    if (!button) return;
    state.activeStatus = button.dataset.statusFilter;
    renderAll();
  });

  els.sidePanel.addEventListener("click", handlePanelClick);
  els.sidePanel.addEventListener("input", handlePanelInput);
  els.sidePanel.addEventListener("change", handlePanelInput);
  els.notificationDrawer.addEventListener("click", handleNotificationClick);
}

function initMap() {
  if (!window.L) {
    throw new Error("Leaflet did not load.");
  }

  map = L.map("map", {
    zoomControl: false,
    minZoom: 8,
  }).setView([28.3205, -82.486], 11);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    }
  );

  roadLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  });

  satelliteLayer.addTo(map);
  map.on("click", handleMapClick);
}

function renderAll() {
  renderStatusControls();
  renderPinVisibilityControls();
  renderViewMode();
  renderWorklist();
  renderMarkers();
  renderPipelineView();
  renderListView();
  renderSummaryBar();
  renderNotifications();
  renderPanel();
}

function renderPinVisibilityControls() {
  els.targetsBtn.classList.toggle("active", state.showTargets);
  els.compsBtn.classList.toggle("active", state.showComps);
}

function renderStatusControls() {
  const counts = getCounts();
  const allCount = filteredBaseParcels().length;
  const buttons = [
    `<button class="filter-btn ${state.activeStatus === "all" ? "active" : ""}" data-status-filter="all" type="button">
      <span class="filter-dot" style="background:#d4d4d8"></span>
      All <span class="filter-count">${allCount}</span>
    </button>`,
    ...STATUSES.map((status) => {
      const active = state.activeStatus === status.name ? "active" : "";
      return `<button class="filter-btn ${active}" data-status-filter="${escapeAttr(status.name)}" type="button">
        <span class="filter-dot" style="background:${status.color}"></span>
        ${escapeHtml(status.name)} <span class="filter-count">${counts[status.name] || 0}</span>
      </button>`;
    }),
  ];
  els.statusFilters.innerHTML = buttons.join("");
}

function renderNewStatusOptions() {
  const select = document.getElementById("newStatus");
  select.innerHTML = STATUSES.map((status) => `<option>${escapeHtml(status.name)}</option>`).join("");
}

function setViewMode(viewMode) {
  state.viewMode = ["map", "pipeline", "list"].includes(viewMode) ? viewMode : "map";
  renderAll();
  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 120);
}

function renderViewMode() {
  document.body.classList.toggle("pipeline-mode", state.viewMode === "pipeline");
  document.body.classList.toggle("list-mode", state.viewMode === "list");
  document.body.classList.toggle("map-mode", state.viewMode === "map");
  els.viewToggle.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.viewMode);
  });
}

function renderWorklist() {
  const visible = getVisibleParcels();
  els.worklist.innerHTML = `
    <div class="worklist-head">
      <div>
        <strong>Parcels</strong>
        <span>${visible.length} shown</span>
      </div>
    </div>
    <div class="worklist-items">
      ${visible.map(renderWorklistItem).join("") || `<div class="worklist-empty">No parcels match the current filters.</div>`}
    </div>
  `;

  els.worklist.querySelectorAll("[data-parcel-id]").forEach((button) => {
    button.addEventListener("click", () => selectParcel(button.dataset.parcelId));
  });
}

function renderPipelineView() {
  const parcels = getPipelineParcels();
  const grouped = Object.fromEntries(STATUSES.map((status) => [status.name, []]));
  parcels.forEach((parcel) => {
    const key = grouped[parcel.status] ? parcel.status : "Not Started";
    grouped[key].push(parcel);
  });

  els.pipelineView.innerHTML = `
    <div class="view-head">
      <div>
        <strong>Acquisition Pipeline</strong>
        <span>${parcels.length} active parcel${parcels.length === 1 ? "" : "s"} in current search/type filter</span>
      </div>
    </div>
    <div class="pipeline-board">
      ${STATUSES.map((status) => renderPipelineColumn(status, grouped[status.name] || [])).join("")}
    </div>
  `;

  els.pipelineView.querySelectorAll("[data-parcel-id]").forEach((button) => {
    button.addEventListener("click", () => selectParcel(button.dataset.parcelId));
  });
}

function renderPipelineColumn(status, parcels) {
  return `<section class="pipeline-column">
    <header>
      <span class="filter-dot" style="background:${status.color}"></span>
      <strong>${escapeHtml(status.name)}</strong>
      <em>${parcels.length}</em>
    </header>
    <div class="pipeline-cards">
      ${parcels.map(renderPipelineCard).join("") || `<div class="pipeline-empty">No parcels</div>`}
    </div>
  </section>`;
}

function renderPipelineCard(parcel) {
  const next = getNextAction(parcel);
  const dueClass = parcel.nextActionDue ? getDueClass({ dueDate: parcel.nextActionDue }) : "";
  return `<button class="pipeline-card" data-parcel-id="${escapeAttr(parcel.id)}" type="button">
    <strong>${escapeHtml(parcel.displayAddress)}</strong>
    <span>${escapeHtml(parcel.owner.name || "Unknown Owner")}</span>
    <div class="pipeline-tags">
      ${parcel.priority !== "Normal" ? `<em class="priority-${parcel.priority.toLowerCase()}">${escapeHtml(parcel.priority)}</em>` : ""}
      ${parcel.lastContacted ? `<em>Contacted ${escapeHtml(formatShortDate(parcel.lastContacted))}</em>` : ""}
    </div>
    ${parcel.nextAction ? `<p class="${dueClass}">${escapeHtml(parcel.nextAction)}${parcel.nextActionDue ? ` · ${escapeHtml(formatShortDate(parcel.nextActionDue))}` : ""}</p>` : ""}
    ${next ? `<p>${escapeHtml(next.text)}${next.dueDate ? ` · ${escapeHtml(formatShortDate(next.dueDate))}` : ""}</p>` : ""}
  </button>`;
}

function renderListView() {
  const parcels = getVisibleParcels();
  els.listView.innerHTML = `
    <div class="view-head">
      <div>
        <strong>Parcel List</strong>
        <span>${parcels.length} shown</span>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Priority</th>
            <th>Address</th>
            <th>Owner</th>
            <th>Follow-Up</th>
            <th>Next Step</th>
            <th>Last Contacted</th>
            <th>Acres</th>
            <th>Zoning</th>
          </tr>
        </thead>
        <tbody>
          ${parcels.map(renderListRow).join("") || `<tr><td colspan="9">No parcels match the current filters.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  els.listView.querySelectorAll("[data-parcel-id]").forEach((row) => {
    row.addEventListener("click", () => selectParcel(row.dataset.parcelId));
  });
}

function renderListRow(parcel) {
  const status = getStatus(parcel.status);
  const dueClass = parcel.nextActionDue ? getDueClass({ dueDate: parcel.nextActionDue }) : "";
  return `<tr data-parcel-id="${escapeAttr(parcel.id)}">
    <td><span class="table-status"><i style="background:${status.color}"></i>${escapeHtml(parcel.status)}</span></td>
    <td>${escapeHtml(parcel.priority || "Normal")}</td>
    <td><strong>${escapeHtml(parcel.displayAddress)}</strong></td>
    <td>${escapeHtml(parcel.owner.name || "")}</td>
    <td class="${dueClass}">${escapeHtml(parcel.nextActionDue || "")}</td>
    <td>${escapeHtml(parcel.nextAction || "")}</td>
    <td>${escapeHtml(parcel.lastContacted || "")}</td>
    <td>${escapeHtml(formatNumber(parcel.acres, 2))}</td>
    <td>${escapeHtml(parcel.zoning || "")}</td>
  </tr>`;
}

function renderWorklistItem(parcel) {
  const status = getStatus(parcel.status);
  const next = getNextAction(parcel);
  const selected = parcel.id === state.selectedId ? "selected" : "";
  const dueClass = next ? getDueClass(next) : "";
  return `<button class="worklist-item ${selected}" data-parcel-id="${escapeAttr(parcel.id)}" type="button">
    <span class="filter-dot" style="background:${status.color}"></span>
    <span class="worklist-main">
      <strong>${escapeHtml(parcel.displayAddress)}</strong>
      <span>${escapeHtml(parcel.owner.name || "Unknown Owner")}</span>
      ${next ? `<em class="${dueClass}">${escapeHtml(next.text)}${next.dueDate ? ` · ${escapeHtml(formatShortDate(next.dueDate))}` : ""}</em>` : ""}
    </span>
  </button>`;
}

function renderMarkers() {
  if (!map) return;
  markers.forEach((marker) => marker.remove());
  markers = new Map();
  compMarkers.forEach((marker) => marker.remove());
  compMarkers = new Map();

  if (state.showTargets) {
    const visible = getMappableParcels(getVisibleParcels());
    visible.forEach((parcel) => {
      const marker = L.marker([parcel.lat, parcel.lng], {
        icon: makeMarkerIcon(parcel),
        keyboard: true,
      });
      marker.bindTooltip(makeTooltip(parcel), {
        direction: "top",
        offset: [0, -30],
        opacity: 1,
        className: "leaflet-tooltip",
      });
      marker.on("click", () => selectParcel(parcel.id));
      marker.addTo(map);
      markers.set(parcel.id, marker);
    });
  }

  if (state.showComps) {
    state.salesComps.filter(hasUsableCoordinates).forEach((comp) => {
      const marker = L.circleMarker([comp.lat, comp.lng], {
        radius: 7,
        color: "#fff7cc",
        weight: 2,
        fillColor: "#f7c948",
        fillOpacity: 0.95,
        className: "sales-comp-dot",
      });
      marker.bindPopup(makeSalesCompPopup(comp), {
        className: "sales-comp-popup",
      });
      marker.bindTooltip(`${escapeHtml(comp.address)}, ${escapeHtml(comp.city)}`, {
        direction: "top",
        opacity: 1,
        className: "leaflet-tooltip comp-tooltip",
      });
      marker.addTo(map);
      compMarkers.set(comp.id, marker);
    });
  }
}

function renderSummaryBar() {
  const counts = getCounts();
  const active = filteredBaseParcels().filter((parcel) => !parcel.archived).length;
  const archived = state.parcels.filter((parcel) => !parcel.deleted && parcel.archived).length;
  const deleted = state.parcels.filter((parcel) => parcel.deleted).length;
  els.summaryBar.innerHTML = [
    `<div class="summary-pill"><strong>${active}</strong> Active</div>`,
    ...STATUSES.map((status) => {
      return `<div class="summary-pill">
        <span class="filter-dot" style="background:${status.color}"></span>
        <strong>${counts[status.name] || 0}</strong> ${escapeHtml(status.name)}
      </div>`;
    }),
    `<div class="summary-pill"><strong>${archived}</strong> Archived</div>`,
    deleted ? `<div class="summary-pill"><strong>${deleted}</strong> Deleted</div>` : "",
  ].join("");
}

function renderNotifications() {
  const items = getOpenNotifications();
  els.notificationCount.textContent = items.length;
  els.notificationBtn.classList.toggle("has-items", items.length > 0);
  els.notificationDrawer.classList.toggle("open", state.notificationsOpen);

  if (!state.notificationsOpen) {
    els.notificationDrawer.innerHTML = "";
    return;
  }

  els.notificationDrawer.innerHTML = `
    <div class="notification-head">
      <div>
        <strong>Needs Attention</strong>
        <span>${items.length} open</span>
      </div>
      <button class="icon-btn" data-notification-action="close" type="button" aria-label="Close">x</button>
    </div>
    <div class="notification-list">
      ${
        items
          .map((item) => {
            return `<button class="notification-item" data-notification-action="open" data-parcel-id="${escapeAttr(item.parcel.id)}" type="button">
              <strong>${escapeHtml(item.parcel.displayAddress)}</strong>
              <span>${escapeHtml(item.attention.text)}</span>
              <em>${escapeHtml(formatDateTime(item.attention.createdAt))}</em>
            </button>`;
          })
          .join("") || `<div class="notification-empty">No open notifications.</div>`
      }
    </div>
  `;
}

function handleNotificationClick(event) {
  const target = event.target.closest("[data-notification-action]");
  if (!target) return;
  if (target.dataset.notificationAction === "close") {
    state.notificationsOpen = false;
    renderNotifications();
    return;
  }
  if (target.dataset.notificationAction === "open") {
    state.notificationsOpen = false;
    selectParcel(target.dataset.parcelId);
  }
}

function renderPanel() {
  const parcel = getSelectedParcel();
  if (!parcel) {
    els.sidePanel.classList.remove("open");
    els.sidePanel.innerHTML = `<div class="empty-panel">Select a pin</div>`;
    return;
  }

  els.sidePanel.classList.add("open");
  const status = getStatus(parcel.status);
  const phones = (parcel.contact.phones || []).join("\n");
  const emails = (parcel.contact.emails || []).join("\n");

  els.sidePanel.innerHTML = `
    <div class="panel-head">
      <div class="panel-head-row">
        <div>
          <div class="status-badge" style="border-color:${status.color};background:${hexToRgba(status.color, 0.18)}">
            <span class="filter-dot" style="background:${status.color}"></span>${escapeHtml(parcel.status)}
          </div>
          <h1 class="panel-title">${escapeHtml(parcel.displayAddress)}</h1>
          <div class="panel-subtitle">${escapeHtml(parcel.owner.name || "Unknown Owner")}</div>
          ${renderStatusChoices(parcel.status)}
        </div>
        <button class="icon-btn" data-action="close-panel" type="button" aria-label="Close">x</button>
      </div>
    </div>
    <div class="panel-scroll">
      <div class="section-title panel-work-title">Property Notes And Follow-Up</div>
      <div class="detail-field panel-notes-field">
        <label for="panelNotes">Property Notes</label>
        <textarea id="panelNotes" data-bind="notes" rows="5">${escapeHtml(parcel.notes || "")}</textarea>
      </div>
      <div class="detail-grid snapshot-grid panel-followup-grid">
        <div class="detail-field">
          <label for="panelPriority">Priority</label>
          ${renderSelect("panelPriority", "priority", PRIORITIES, parcel.priority || "Normal")}
        </div>
        <div class="detail-field">
          <label for="panelNextDue">Follow-Up Date</label>
          <input id="panelNextDue" type="date" data-bind="nextActionDue" value="${escapeAttr(parcel.nextActionDue || "")}">
        </div>
        <div class="detail-field">
          <label for="lastContacted">Last Contacted</label>
          <input id="lastContacted" type="date" data-bind="lastContacted" value="${escapeAttr(parcel.lastContacted || "")}">
        </div>
        ${textField("Next Step", "nextAction", parcel.nextAction, "wide")}
      </div>

      <details open>
        <summary>Follow-Ups</summary>
        <div class="action-form">
          <input id="actionText" type="text" placeholder="Next step">
          <input id="actionDue" type="date">
          <button class="primary-btn" data-action="add-action" type="button">Add Follow-Up</button>
        </div>
        <div class="action-list">
          ${renderActions(parcel)}
        </div>
      </details>

      <details open>
        <summary>Needs Attention</summary>
        <div class="attention-form">
          <input id="attentionText" type="text" placeholder="Example: Owner wants Gregg to call">
          <button class="primary-btn" data-action="add-attention" type="button">Notify</button>
        </div>
        <div class="attention-list">
          ${renderAttentionItems(parcel)}
        </div>
      </details>

      <details open>
        <summary>Activity Log</summary>
        <div class="activity-form">
          <input id="activityDate" type="date" value="${todayIso()}">
          <select id="activityType">
            <option>Call</option>
            <option>Email</option>
            <option>Text</option>
            <option>Meeting</option>
            <option>Research</option>
            <option>Other</option>
          </select>
          <textarea id="activityText" rows="3" placeholder="What happened?"></textarea>
          <button class="primary-btn" data-action="add-activity" type="button">Add Activity</button>
        </div>
        <div class="activity-list">
          ${renderActivity(parcel)}
        </div>
      </details>

      <details open>
        <summary>Owner And Contact</summary>
        <div class="detail-grid">
          ${textField("Owner Name", "owner.name", parcel.owner.name, "wide")}
          ${textField("Mailing Address", "owner.mailingAddress", parcel.owner.mailingAddress, "wide")}
          ${textField("Mailing City", "owner.mailingCity", parcel.owner.mailingCity)}
          ${textField("Mailing State", "owner.mailingState", parcel.owner.mailingState)}
          ${textField("Mailing Zip", "owner.mailingZip", parcel.owner.mailingZip)}
          ${textField("Contact Name", "contact.name", parcel.contact.name)}
          ${textareaField("Phones", "contact.phones", phones)}
          ${textareaField("Emails", "contact.emails", emails)}
        </div>
      </details>

      <div class="section-title property-reference-title">Property Info</div>
      <div class="metric-row">
        <div class="metric"><strong>${formatNumber(parcel.acres, 2)}</strong><span>Acres</span></div>
        <div class="metric"><strong>${formatMoney(parcel.assessedValue)}</strong><span>Assessed</span></div>
        <div class="metric"><strong>${formatMoney(parcel.taxes)}</strong><span>Taxes</span></div>
      </div>
      <div class="detail-grid snapshot-grid">
        ${numberField("Acres", "acres", parcel.acres, "0.01")}
        ${numberField("Assessed Value", "assessedValue", parcel.assessedValue, "1")}
        ${numberField("Taxes", "taxes", parcel.taxes, "1")}
        ${textField("Zoning", "zoning", parcel.zoning)}
        ${textField("Opp Zone", "oppZone", parcel.oppZone)}
        ${textField("Type", "type", parcel.type)}
        ${textField("Crexi Link", "crexiLink", parcel.crexiLink, "wide")}
      </div>

      ${renderPinActions(parcel)}

      <details>
        <summary>Property</summary>
        <div class="detail-grid">
          ${textField("Display Address", "displayAddress", parcel.displayAddress, "wide")}
          ${textField("Address Line", "addressLine", parcel.addressLine)}
          ${textField("City", "city", parcel.city)}
          ${textField("Zip", "zip", parcel.zip)}
          ${textField("State", "state", parcel.state)}
          ${textField("Category", "category", parcel.category)}
          ${numberField("Latitude", "lat", parcel.lat, "0.000001")}
          ${numberField("Longitude", "lng", parcel.lng, "0.000001")}
          ${textField("Sale Date", "saleDate", parcel.saleDate)}
          ${numberField("Sold Price", "soldPrice", parcel.soldPrice, "1")}
        </div>
      </details>

      ${renderExtraDetails(parcel)}

      <details>
        <summary>Documents</summary>
        <div class="doc-form">
          <input id="docTitle" type="text" placeholder="Document name">
          <input id="docUrl" type="url" placeholder="https://">
          <button class="primary-btn" data-action="add-document" type="button">Add Link</button>
        </div>
        <div class="doc-list">
          ${renderDocuments(parcel)}
        </div>
      </details>
    </div>
  `;
}

function renderPinActions(parcel) {
  return `<div class="pin-actions">
    <button class="ghost-btn" data-action="move-pin" type="button">Move Pin</button>
    <button class="danger-btn" data-action="${parcel.archived ? "unarchive" : "archive"}" type="button">
      ${parcel.archived ? "Restore Pin" : "Archive Pin"}
    </button>
    <button class="danger-btn strong-danger" data-action="delete-pin" type="button">Delete Pin</button>
  </div>`;
}

function textField(label, bind, value, extraClass = "") {
  return `<div class="detail-field ${extraClass}">
    <label>${escapeHtml(label)}</label>
    <input type="text" data-bind="${escapeAttr(bind)}" value="${escapeAttr(value || "")}">
  </div>`;
}

function numberField(label, bind, value, step = "1") {
  return `<div class="detail-field">
    <label>${escapeHtml(label)}</label>
    <input type="number" step="${escapeAttr(step)}" data-bind="${escapeAttr(bind)}" value="${escapeAttr(value ?? "")}">
  </div>`;
}

function renderSelect(id, bind, options, currentValue) {
  return `<select id="${escapeAttr(id)}" data-bind="${escapeAttr(bind)}">
    ${options
      .map((option) => {
        const selected = option === currentValue ? "selected" : "";
        return `<option value="${escapeAttr(option)}" ${selected}>${escapeHtml(option)}</option>`;
      })
      .join("")}
  </select>`;
}

function textareaField(label, bind, value) {
  return `<div class="detail-field wide">
    <label>${escapeHtml(label)}</label>
    <textarea rows="4" data-bind="${escapeAttr(bind)}">${escapeHtml(value || "")}</textarea>
  </div>`;
}

function renderStatusSelect(currentStatus) {
  return `<select id="panelStatus" class="status-select" data-bind="status">
    ${STATUSES.map((status) => {
      const selected = status.name === currentStatus ? "selected" : "";
      return `<option value="${escapeAttr(status.name)}" ${selected}>${escapeHtml(status.name)}</option>`;
    }).join("")}
  </select>`;
}

function renderStatusChoices(currentStatus) {
  return `<div class="panel-status-control status-button-control">
    <label>Deal Status</label>
    <div class="status-grid">
      ${STATUSES.map((status) => {
        const active = status.name === currentStatus ? "active" : "";
        return `<button class="status-choice ${active}" data-action="set-status" data-status="${escapeAttr(status.name)}" style="--status-color:${status.color}" type="button">
          ${escapeHtml(status.name)}
        </button>`;
      }).join("")}
    </div>
  </div>`;
}

function renderActivity(parcel) {
  if (!parcel.activity.length) {
    return `<div class="activity-item"><p>No activity yet.</p></div>`;
  }
  return [...parcel.activity]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((entry) => {
      return `<div class="activity-item">
        <time>${escapeHtml(formatDateTime(entry.at))}</time>
        <strong>${escapeHtml(entry.type || "Activity")}</strong>
        <p>${escapeHtml(entry.text)}</p>
        <button class="mini-link" data-action="remove-activity" data-activity-id="${escapeAttr(entry.id)}" type="button">Remove</button>
      </div>`;
    })
    .join("");
}

function renderAttentionItems(parcel) {
  const openItems = getOpenAttentionItems(parcel);
  if (!openItems.length) {
    return `<div class="attention-item empty"><p>No open notifications.</p></div>`;
  }
  return openItems
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((item) => {
      return `<div class="attention-item">
        <p>${escapeHtml(item.text)}</p>
        <span>${escapeHtml(formatDateTime(item.createdAt))}${item.createdBy ? ` by ${escapeHtml(item.createdBy)}` : ""}</span>
        <button class="mini-link" data-action="resolve-attention" data-attention-id="${escapeAttr(item.id)}" type="button">Clear</button>
      </div>`;
    })
    .join("");
}

function renderActions(parcel) {
  if (!parcel.actions.length) {
    return `<div class="action-item empty"><p>No open action items.</p></div>`;
  }
  return [...parcel.actions]
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31"));
    })
    .map((action) => {
      const dueClass = getDueClass(action);
      return `<div class="action-item ${action.done ? "done" : ""}">
        <label>
          <input type="checkbox" data-action="toggle-action" data-action-id="${escapeAttr(action.id)}" ${action.done ? "checked" : ""}>
          <span>
            <strong>${escapeHtml(action.text)}</strong>
            <em class="${dueClass}">
              ${action.dueDate ? escapeHtml(formatShortDate(action.dueDate)) : "No due date"}
              ${action.assignedTo ? ` · ${escapeHtml(action.assignedTo)}` : ""}
              ${action.priority ? ` · ${escapeHtml(action.priority)}` : ""}
            </em>
          </span>
        </label>
        <button class="mini-link" data-action="remove-action" data-action-id="${escapeAttr(action.id)}" type="button">Remove</button>
      </div>`;
    })
    .join("");
}

function renderExtraDetails(parcel) {
  const entries = Object.entries(parcel.extraFields || {}).filter(([, value]) => value !== "" && value !== null && value !== undefined);
  if (!entries.length) return "";
  return `<details>
    <summary>Additional Data</summary>
    <div class="extra-grid">
      ${entries
        .map(([label, value]) => {
          return `<div class="extra-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
        })
        .join("")}
    </div>
  </details>`;
}

function renderDocuments(parcel) {
  if (!parcel.documents.length) {
    return `<div class="doc-item"><p>No document links yet.</p></div>`;
  }
  return [...parcel.documents]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((doc) => {
      return `<div class="doc-item">
        <span>${escapeHtml(formatDateTime(doc.at))}</span>
        <a href="${escapeAttr(doc.url)}" target="_blank" rel="noreferrer">${escapeHtml(doc.title || doc.url)}</a>
        <button class="mini-link" data-action="remove-document" data-document-id="${escapeAttr(doc.id)}" type="button">Remove</button>
      </div>`;
    })
    .join("");
}

function handlePanelClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const parcel = getSelectedParcel();
  if (!parcel && target.dataset.action !== "close-panel") return;

  switch (target.dataset.action) {
    case "close-panel":
      state.selectedId = null;
      renderAll();
      break;
    case "set-status":
      setParcelStatus(parcel, target.dataset.status);
      break;
    case "add-activity":
      addActivity(parcel);
      break;
    case "add-action":
      addAction(parcel);
      break;
    case "add-attention":
      addAttentionItem(parcel);
      break;
    case "add-document":
      addDocument(parcel);
      break;
    case "remove-activity":
      removeActivity(parcel, target.dataset.activityId);
      break;
    case "toggle-action":
      toggleAction(parcel, target.dataset.actionId, target.checked);
      break;
    case "remove-action":
      removeAction(parcel, target.dataset.actionId);
      break;
    case "resolve-attention":
      resolveAttentionItem(parcel, target.dataset.attentionId);
      break;
    case "remove-document":
      removeDocument(parcel, target.dataset.documentId);
      break;
    case "move-pin":
      startExistingPinPlacement(parcel);
      break;
    case "archive":
      updateParcel(parcel.id, { archived: true, updatedAt: new Date().toISOString() });
      state.selectedId = null;
      renderAll();
      toast("Pin archived");
      break;
    case "unarchive":
      updateParcel(parcel.id, { archived: false, updatedAt: new Date().toISOString() });
      renderAll();
      toast("Pin restored");
      break;
    case "delete-pin":
      deleteParcel(parcel);
      break;
  }
}

function handlePanelInput(event) {
  const input = event.target.closest("[data-bind]");
  if (!input) return;
  const parcel = getSelectedParcel();
  if (!parcel) return;
  const path = input.dataset.bind;
  let value = input.value;

  if (input.type === "number") {
    value = input.value === "" ? null : Number(input.value);
  }
  if ((path === "lat" || path === "lng") && !isValidCoordinateEdit(parcel, path, value)) {
    setSync("Coordinate not saved");
    toast("Coordinate looks wrong. Use decimals like 27.946707 and -82.452401.");
    return;
  }
  if (path === "contact.phones" || path === "contact.emails") {
    value = input.value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  setPath(parcel, path, value);
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  if (path === "type" && !parcel.category) parcel.category = value || "Land";
  if (path === "status") {
    persistNow();
    renderAll();
    return;
  }
  persistSoon();
  refreshSelectedMarker();
  renderWorklist();
}

function setParcelStatus(parcel, status) {
  const nextStatus = normalizeStatus(status);
  if (parcel.status === nextStatus) return;
  parcel.status = nextStatus;
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
}

function addActivity(parcel) {
  const input = document.getElementById("activityText");
  const dateInput = document.getElementById("activityDate");
  const typeInput = document.getElementById("activityType");
  const text = input.value.trim();
  if (!text) return;
  const at = dateInput.value ? `${dateInput.value}T12:00:00` : new Date().toISOString();
  parcel.activity.push({
    id: makeId(`${parcel.id}|activity|${Date.now()}|${text}`),
    type: typeInput.value || "Activity",
    text,
    at,
  });
  parcel.lastContacted = dateInput.value || parcel.lastContacted;
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderPanel();
  toast("Activity added");
}

function removeActivity(parcel, activityId) {
  parcel.activity = parcel.activity.filter((entry) => entry.id !== activityId);
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderPanel();
  toast("Activity removed");
}

function addAttentionItem(parcel) {
  const input = document.getElementById("attentionText");
  const text = input.value.trim();
  if (!text) return;
  parcel.attentionItems = Array.isArray(parcel.attentionItems) ? parcel.attentionItems : [];
  parcel.attentionItems.push({
    id: makeId(`${parcel.id}|attention|${Date.now()}|${text}`),
    text,
    createdAt: new Date().toISOString(),
    createdBy: getCurrentUserLabel(),
    resolvedAt: "",
    resolvedBy: "",
  });
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
  toast("Notification added");
}

function resolveAttentionItem(parcel, attentionId) {
  const item = (parcel.attentionItems || []).find((entry) => entry.id === attentionId);
  if (!item) return;
  item.resolvedAt = new Date().toISOString();
  item.resolvedBy = getCurrentUserLabel();
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
  toast("Notification cleared");
}

function addAction(parcel) {
  const text = document.getElementById("actionText").value.trim();
  if (!text) return;
  const dueDate = document.getElementById("actionDue").value;
  parcel.actions.push({
    id: makeId(`${parcel.id}|action|${Date.now()}|${text}`),
    text,
    dueDate,
    assignedTo: "",
    priority: "Normal",
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: "",
  });
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
  toast("Action item added");
}

function toggleAction(parcel, actionId, done) {
  const action = parcel.actions.find((item) => item.id === actionId);
  if (!action) return;
  action.done = Boolean(done);
  action.completedAt = done ? new Date().toISOString() : "";
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
}

function removeAction(parcel, actionId) {
  parcel.actions = parcel.actions.filter((item) => item.id !== actionId);
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderAll();
  toast("Action item removed");
}

function addDocument(parcel) {
  const titleInput = document.getElementById("docTitle");
  const urlInput = document.getElementById("docUrl");
  const title = titleInput.value.trim();
  const url = urlInput.value.trim();
  if (!url) return;
  parcel.documents.push({
    id: makeId(`${parcel.id}|doc|${Date.now()}|${url}`),
    title: title || url,
    url,
    at: new Date().toISOString(),
  });
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderPanel();
  toast("Document link added");
}

function removeDocument(parcel, documentId) {
  parcel.documents = parcel.documents.filter((doc) => doc.id !== documentId);
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  persistNow();
  renderPanel();
  toast("Document link removed");
}

function deleteParcel(parcel) {
  const label = parcel.displayAddress || "this pin";
  const confirmed = window.confirm(`Delete ${label} from the tracker? This removes it from the map and normal views.`);
  if (!confirmed) return;
  parcel.deleted = true;
  parcel.archived = false;
  parcel.deletedAt = new Date().toISOString();
  parcel.deletedBy = getCurrentUserLabel();
  parcel.updatedAt = new Date().toISOString();
  markParcelDirty(parcel);
  state.selectedId = null;
  persistNow();
  renderAll();
  toast("Pin deleted");
}

function selectParcel(id) {
  state.selectedId = id;
  renderAll();
}

function getSelectedParcel() {
  return state.parcels.find((parcel) => parcel.id === state.selectedId) || null;
}

function updateParcel(id, patch) {
  const parcel = state.parcels.find((item) => item.id === id);
  if (!parcel) return;
  Object.assign(parcel, patch, { updatedAt: new Date().toISOString() });
  markParcelDirty(parcel);
  persistNow();
}

function refreshSelectedMarker() {
  const parcel = getSelectedParcel();
  if (!parcel) return;
  const marker = markers.get(parcel.id);
  if (marker) {
    marker.setTooltipContent(makeTooltip(parcel));
    marker.setIcon(makeMarkerIcon(parcel));
  }
  renderSummaryBar();
  renderStatusControls();
}

function makeMarkerIcon(parcel) {
  const color = getStatus(parcel.status).color;
  const selected = parcel.id === state.selectedId ? "selected" : "";
  const archived = parcel.archived ? "archived" : "";
  return L.divIcon({
    className: "marker-shell",
    html: `<div class="pin-icon ${selected} ${archived}" style="--pin-color:${color}"></div>`,
    iconSize: parcel.id === state.selectedId ? [36, 42] : [28, 36],
    iconAnchor: parcel.id === state.selectedId ? [18, 42] : [14, 36],
  });
}

function makeTooltip(parcel) {
  return `<div class="map-tooltip">
    <strong>${escapeHtml(parcel.displayAddress)}</strong>
    <span>${escapeHtml(parcel.status)} | ${escapeHtml(parcel.owner.name || "Unknown Owner")}</span>
  </div>`;
}

function makeSalesCompPopup(comp) {
  return `<div class="comp-popup-card">
    <strong>${escapeHtml(comp.address)}</strong>
    <span>${escapeHtml(comp.city)}, ${escapeHtml(comp.state || "FL")}</span>
    <dl>
      <dt>Sale Amount</dt><dd>${escapeHtml(formatMoney(comp.saleAmount))}</dd>
      <dt>Sale Date</dt><dd>${escapeHtml(comp.saleDate || "")}</dd>
      <dt>Acres</dt><dd>${escapeHtml(formatNumber(comp.acres, 2))}</dd>
      <dt>Price / Acre</dt><dd>${escapeHtml(formatMoney(comp.pricePerAcre))}</dd>
    </dl>
  </div>`;
}

function getVisibleParcels() {
  return filteredBaseParcels().filter((parcel) => {
    if (state.activeStatus !== "all" && parcel.status !== state.activeStatus) return false;
    return matchesSearch(parcel);
  });
}

function getPipelineParcels() {
  return filteredBaseParcels().filter((parcel) => {
    return matchesSearch(parcel);
  });
}

function filteredBaseParcels() {
  return state.parcels.filter((parcel) => !parcel.deleted && (state.showArchived || !parcel.archived));
}

function matchesSearch(parcel) {
  if (!state.search) return true;
  const haystack = [
    parcel.displayAddress,
    parcel.addressLine,
    parcel.city,
    parcel.type,
    parcel.zoning,
    parcel.owner.name,
    parcel.contact.name,
    parcel.notes,
    ...(parcel.contact.phones || []),
    ...(parcel.contact.emails || []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.search);
}

function getMappableParcels(parcels) {
  return parcels.filter(hasUsableCoordinates);
}

function hasUsableCoordinates(parcel) {
  return hasUsableCoordinateValues(parcel.lat, parcel.lng);
}

function hasUsableCoordinateValues(latValue, lngValue) {
  const lat = Number(latValue);
  const lng = Number(lngValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function isValidCoordinateEdit(parcel, path, value) {
  const lat = path === "lat" ? value : parcel.lat;
  const lng = path === "lng" ? value : parcel.lng;
  return hasUsableCoordinateValues(lat, lng);
}

function getNextAction(parcel) {
  return [...(parcel.actions || [])]
    .filter((action) => !action.done)
    .sort((a, b) => String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31")))[0];
}

function getDueClass(action) {
  if (action.done || !action.dueDate) return "";
  const today = todayIso();
  if (action.dueDate < today) return "overdue";
  if (action.dueDate === today) return "due-today";
  return "";
}

function getCounts() {
  const counts = {};
  filteredBaseParcels().forEach((parcel) => {
    counts[parcel.status] = (counts[parcel.status] || 0) + 1;
  });
  return counts;
}

function getOpenNotifications() {
  return filteredBaseParcels()
    .flatMap((parcel) =>
      getOpenAttentionItems(parcel).map((attention) => ({
        parcel,
        attention,
      }))
    )
    .sort((a, b) => String(b.attention.createdAt).localeCompare(String(a.attention.createdAt)));
}

function getOpenAttentionItems(parcel) {
  return (parcel.attentionItems || []).filter((item) => !item.resolvedAt);
}

function getCurrentUserLabel() {
  return state.currentUser || "Signed In";
}

function getStatus(name) {
  return STATUSES.find((status) => status.name === name) || STATUSES[0];
}

function setLayerMode(mode) {
  state.layerMode = mode;
  els.satelliteBtn.classList.toggle("active", mode === "satellite");
  els.roadBtn.classList.toggle("active", mode === "road");
  if (!map) return;
  if (mode === "satellite") {
    roadLayer.remove();
    satelliteLayer.addTo(map);
  } else {
    satelliteLayer.remove();
    roadLayer.addTo(map);
  }
}

function setFocusMode(on) {
  state.focusMode = Boolean(on);
  document.body.classList.toggle("focus-mode", state.focusMode);
  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 180);
}

function openParcelModal() {
  els.parcelForm.reset();
  clearNewPinPreview();
  state.placementMode = null;
  document.getElementById("newType").value = "Land";
  document.getElementById("newStatus").value = "Not Started";
  document.getElementById("newState").value = "FL";
  setGeocodeResult("");
  els.parcelModal.showModal();
  document.getElementById("newAddress").focus();
}

function closeParcelModal() {
  clearNewPinPreview();
  if (state.placementMode?.type === "new") state.placementMode = null;
  els.parcelModal.close();
}

async function geocodeNewAddress() {
  const address = document.getElementById("newAddress").value.trim();
  const city = document.getElementById("newCity").value.trim();
  const stateName = document.getElementById("newState").value.trim() || "FL";
  const zip = document.getElementById("newZip").value.trim();
  const result = document.getElementById("geocodeResult");
  if (!address) {
    setGeocodeResult("Enter an address first.", "error");
    return;
  }
  setGeocodeResult("Locating");

  try {
    const query = [address, city, stateName, zip].filter(Boolean).join(", ");
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us&q=${encodeURIComponent(
      query
    )}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.length) {
      setGeocodeResult("Not found. Try adding city and zip, or use Map Center.", "error");
      return;
    }
    renderGeocodeCandidates(data);
  } catch {
    setGeocodeResult("Geocoding unavailable. Use Map Center or enter latitude/longitude manually.", "error");
  }
}

function renderGeocodeCandidates(results) {
  const result = document.getElementById("geocodeResult");
  result.className = "field-note geo-results ok";
  result.innerHTML = `
    <strong>Select the correct match:</strong>
    ${results
      .map((item, index) => {
        const label = item.display_name.split(",").slice(0, 5).join(",");
        return `<button class="geo-candidate" data-geo-index="${index}" type="button">${escapeHtml(label)}</button>`;
      })
      .join("")}
  `;
  result.querySelectorAll("[data-geo-index]").forEach((button) => {
    button.addEventListener("click", () => applyGeocodeResult(results[Number(button.dataset.geoIndex)]));
  });
  applyGeocodeResult(results[0], false);
}

function applyGeocodeResult(item, announce = true) {
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  setNewPinCoordinates(lat, lng);
  const address = item.address || {};
  if (!document.getElementById("newCity").value && (address.city || address.town || address.village)) {
    document.getElementById("newCity").value = address.city || address.town || address.village;
  }
  if (!document.getElementById("newZip").value && address.postcode) {
    document.getElementById("newZip").value = address.postcode;
  }
  if (map) {
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
  }
  showNewPinPreview(lat, lng, item.display_name);
  if (announce) {
    toast("Location selected");
  }
}

function setGeocodeResult(message, tone = "") {
  const result = document.getElementById("geocodeResult");
  result.className = `field-note geo-results ${tone}`.trim();
  result.textContent = message;
}

function useMapCenterForNewPin() {
  if (!map) return;
  const center = map.getCenter();
  setNewPinCoordinates(center.lat, center.lng);
  showNewPinPreview(center.lat, center.lng, "Manual map center");
  setGeocodeResult("Coordinates set from the current map center.", "ok");
}

function startNewPinPlacement() {
  state.placementMode = { type: "new" };
  setGeocodeResult("Click the exact location on the map. The form will reopen after you place it.", "ok");
  els.parcelModal.close();
  toast("Click the map where this pin should go");
}

function setNewPinCoordinates(lat, lng) {
  document.getElementById("newLat").value = Number(lat).toFixed(6);
  document.getElementById("newLng").value = Number(lng).toFixed(6);
}

function refreshNewPinPreview() {
  const lat = Number(document.getElementById("newLat").value);
  const lng = Number(document.getElementById("newLng").value);
  if (hasUsableCoordinateValues(lat, lng)) {
    showNewPinPreview(lat, lng, "New pin preview");
  }
}

function showNewPinPreview(lat, lng, label = "New pin preview") {
  if (!map || !hasUsableCoordinateValues(lat, lng)) return;
  clearNewPinPreview();
  const status = document.getElementById("newStatus")?.value || "Not Started";
  const color = getStatus(status).color;
  newPinPreviewMarker = L.marker([Number(lat), Number(lng)], {
    icon: L.divIcon({
      className: "marker-shell",
      html: `<div class="pin-icon preview" style="--pin-color:${color}"></div>`,
      iconSize: [32, 40],
      iconAnchor: [16, 40],
    }),
    keyboard: false,
  });
  newPinPreviewMarker.bindTooltip(`<div class="map-tooltip"><strong>${escapeHtml(label)}</strong><span>New pin preview</span></div>`, {
    direction: "top",
    offset: [0, -30],
    opacity: 1,
    className: "leaflet-tooltip",
  });
  newPinPreviewMarker.addTo(map);
}

function clearNewPinPreview() {
  if (!newPinPreviewMarker) return;
  newPinPreviewMarker.remove();
  newPinPreviewMarker = null;
}

function startExistingPinPlacement(parcel) {
  state.placementMode = { type: "existing", parcelId: parcel.id };
  toast("Click the correct spot on the map to move this pin");
}

function handleMapClick(event) {
  if (!state.placementMode) return;
  const lat = event.latlng.lat;
  const lng = event.latlng.lng;
  if (state.placementMode.type === "new") {
    setNewPinCoordinates(lat, lng);
    showNewPinPreview(lat, lng, "Manually placed pin");
    setGeocodeResult("Pin placed manually. Click Add Pin when ready.", "ok");
    state.placementMode = null;
    els.parcelModal.showModal();
    return;
  }
  if (state.placementMode.type === "existing") {
    const parcel = state.parcels.find((item) => item.id === state.placementMode.parcelId);
    state.placementMode = null;
    if (!parcel) return;
    parcel.lat = Number(lat.toFixed(6));
    parcel.lng = Number(lng.toFixed(6));
    parcel.updatedAt = new Date().toISOString();
    markParcelDirty(parcel);
    persistNow();
    renderAll();
    toast("Pin moved");
  }
}

function addParcelFromForm(event) {
  event.preventDefault();
  const form = new FormData(els.parcelForm);
  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const result = document.getElementById("geocodeResult");
    result.className = "field-note error";
    result.textContent = "Latitude and longitude are required.";
    return;
  }
  if (!hasUsableCoordinateValues(lat, lng)) {
    const result = document.getElementById("geocodeResult");
    result.className = "field-note error";
    result.textContent = "Latitude/longitude look wrong. Use decimals, like 27.946707 and -82.452401.";
    return;
  }

  const now = new Date().toISOString();
  const address = String(form.get("address") || "Unknown Address").trim();
  const city = String(form.get("city") || "").trim();
  const stateName = String(form.get("state") || "FL").trim() || "FL";
  const zip = String(form.get("zip") || "").trim();
  const displayAddress = buildDisplayAddress(address, city, zip, stateName);
  const parcel = normalizeParcel({
    id: makeId(`${address}|${lat}|${lng}|${now}`),
    source: { file: "Manual", sheet: "Manual", row: "" },
    status: String(form.get("status") || "Not Started"),
    category: String(form.get("type") || "Land").trim() || "Land",
    priority: "Normal",
    nextAction: "",
    nextActionDue: "",
    displayAddress,
    addressLine: address,
    city,
    state: stateName,
    zip,
    lat,
    lng,
    type: String(form.get("type") || "Land").trim() || "Land",
    zoning: String(form.get("zoning") || "").trim(),
    oppZone: "No",
    acres: numericOrNull(form.get("acres")),
    assessedValue: numericOrNull(form.get("assessedValue")),
    taxes: numericOrNull(form.get("taxes")),
    saleDate: String(form.get("saleDate") || "").trim(),
    soldPrice: numericOrNull(form.get("soldPrice")),
    owner: { name: String(form.get("owner") || "").trim() },
    contact: {
      name: String(form.get("contact") || "").trim(),
      phones: String(form.get("phone") || "").trim() ? [String(form.get("phone")).trim()] : [],
      emails: String(form.get("email") || "").trim() ? [String(form.get("email")).trim()] : [],
    },
    notes: String(form.get("notes") || "").trim(),
    activity: [],
    comments: [],
    actions: [],
    attentionItems: [],
    lastContacted: "",
    crexiLink: String(form.get("crexiLink") || "").trim(),
    documents: [],
    extraFields: {},
    archived: false,
    deleted: false,
    createdAt: now,
    updatedAt: now,
  });

  state.parcels.push(parcel);
  state.selectedId = parcel.id;
  markParcelDirty(parcel);
  persistNow();
  clearNewPinPreview();
  closeParcelModal();
  renderAll();
  map.setView([lat, lng], Math.max(map.getZoom(), 15));
  toast("Pin added");
}

function openImportModal() {
  state.pendingImport = [];
  els.importFile.value = "";
  els.importResult.textContent = "";
  els.importPreview.innerHTML = "";
  els.commitImportBtn.disabled = true;
  els.importModal.showModal();
}

function closeImportModal() {
  els.importModal.close();
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  els.importResult.className = "field-note";
  els.importResult.textContent = "Reading file";
  els.importPreview.innerHTML = "";
  els.commitImportBtn.disabled = true;

  try {
    const imported = await readImportFile(file);
    const preview = previewImport(imported);
    state.pendingImport = preview.toAdd;
    els.importResult.className = "field-note ok";
    els.importResult.textContent = `${preview.toAdd.length} new parcel(s) ready`;
    els.importPreview.innerHTML = `
      <div class="import-stat"><strong>${preview.toAdd.length}</strong> new parcel(s)</div>
      <div class="import-stat"><strong>${preview.duplicates}</strong> already in tracker</div>
      <div class="import-stat"><strong>${preview.changedData}</strong> possible existing updates</div>
      <div class="import-stat"><strong>${preview.missingCoordinates}</strong> missing coordinates</div>
    `;
    els.commitImportBtn.disabled = preview.toAdd.length === 0;
  } catch (error) {
    console.error(error);
    els.importResult.className = "field-note error";
    els.importResult.textContent = error.message || "Import failed";
  }
}

async function readImportFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".json")) {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("JSON import must be a parcel array.");
    return data.map(normalizeParcel);
  }
  if (lower.endsWith(".csv")) {
    return normalizeImportedRows(parseCsv(await file.text()), file.name);
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    if (!window.XLSX) {
      throw new Error("Excel parser did not load. Save the first tab as CSV and import that file.");
    }
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    return normalizeImportedRows(rows, file.name);
  }
  throw new Error("Use an Excel, CSV, or tracker JSON file.");
}

function normalizeImportedRows(rows, sourceName) {
  const headerIndex = rows.findIndex((row) => {
    const text = row.map((cell) => String(cell).trim().toLowerCase()).join("|");
    return text.includes("link") && text.includes("lat") && text.includes("long");
  });
  if (headerIndex < 0) throw new Error("Could not find a header row with Link, Lat, and Long.");

  const headers = rows[headerIndex].map(textValue);
  const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell ?? "").trim()));
  const parcels = [];
  dataRows.forEach((row, index) => {
    const parcel = parcelFromImportRow(row, headers, sourceName, headerIndex + index + 2);
    if (parcel) parcels.push(parcel);
  });
  return parcels;
}

function parcelFromImportRow(row, headers, sourceName, sourceRow) {
  const cell = (index) => row[index] ?? "";
  const lat = numericOrNull(cell(11));
  const lng = numericOrNull(cell(12));
  const address = textValue(cell(2));
  const city = textValue(cell(3));
  const zip = textValue(cell(4));
  const ownerName = textValue(cell(15));
  const link = textValue(cell(0));

  return normalizeParcel({
    id: makeId(link || `${address}|${city}|${zip}|${lat}|${lng}|${ownerName}`),
    source: { file: sourceName, sheet: "First tab", row: sourceRow },
    status: "Not Started",
    category: textValue(cell(1)) || "Land",
    priority: "Normal",
    nextAction: "",
    nextActionDue: "",
    displayAddress: buildDisplayAddress(address, city, zip),
    addressLine: address,
    city,
    state: "FL",
    zip,
    lat,
    lng,
    type: textValue(cell(1)) || "Land",
    zoning: textValue(cell(8)),
    oppZone: textValue(cell(9)) || "No",
    acres: numericOrNull(cell(10)),
    assessedValue: numericOrNull(cell(13)),
    taxes: numericOrNull(cell(14)),
    saleDate: dateValue(cell(6)),
    soldPrice: numericOrNull(cell(7)),
    owner: {
      name: ownerName,
      mailingAddress: textValue(cell(16)),
      mailingCity: textValue(cell(17)),
      mailingState: textValue(cell(18)),
      mailingZip: textValue(cell(19)),
    },
    contact: {
      name: textValue(cell(20)),
      phones: [cell(21), cell(22), cell(23), cell(24), cell(25)].map(textValue).filter(Boolean),
      emails: [cell(26), cell(27), cell(28), cell(29), cell(30)].map(textValue).filter(Boolean),
    },
    notes: textValue(cell(5)),
    activity: [],
    comments: [],
    actions: [],
    attentionItems: [],
    lastContacted: "",
    crexiLink: link,
    documents: [],
    extraFields: extraFieldsFromRow(row, headers),
    archived: false,
    deleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function extraFieldsFromRow(row, headers) {
  const known = new Set([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  ]);
  const extra = {};
  headers.forEach((header, index) => {
    const value = textValue(row[index]);
    if (!header || !value || known.has(index)) return;
    extra[header] = value;
  });
  return extra;
}

function previewImport(imported) {
  const existingIds = new Set(state.parcels.map((parcel) => parcel.id));
  const existingById = new Map(state.parcels.map((parcel) => [parcel.id, parcel]));
  const existingByGeo = new Map(state.parcels.map((parcel) => [geoKey(parcel), parcel]).filter(([key]) => key));
  const existingGeo = new Set(existingByGeo.keys());
  const toAdd = [];
  let duplicates = 0;
  let changedData = 0;
  let missingCoordinates = 0;

  imported.forEach((parcel) => {
    if (!Number.isFinite(parcel.lat) || !Number.isFinite(parcel.lng)) {
      missingCoordinates += 1;
      return;
    }
    const key = geoKey(parcel);
    if (existingIds.has(parcel.id) || existingGeo.has(key)) {
      duplicates += 1;
      const existing = existingById.get(parcel.id) || existingByGeo.get(key);
      if (existing && hasMeaningfulImportChange(existing, parcel)) {
        changedData += 1;
      }
      return;
    }
    toAdd.push(parcel);
    existingIds.add(parcel.id);
    existingGeo.add(key);
  });

  return { toAdd, duplicates, changedData, missingCoordinates };
}

function hasMeaningfulImportChange(existing, incoming) {
  const fields = ["displayAddress", "owner.name", "zoning", "oppZone", "acres", "assessedValue", "taxes", "type"];
  return fields.some((path) => String(getPath(existing, path) ?? "") !== String(getPath(incoming, path) ?? ""));
}

function commitImport() {
  if (!state.pendingImport.length) return;
  const count = state.pendingImport.length;
  markParcelsDirty(state.pendingImport);
  state.parcels.push(...state.pendingImport);
  state.pendingImport = [];
  persistNow();
  closeImportModal();
  renderAll();
  toast(`${count} parcel${count === 1 ? "" : "s"} added`);
}

function exportCsv() {
  const headers = [
    "ID",
    "Status",
    "Priority",
    "Follow-Up Date",
    "Next Step",
    "Display Address",
    "City",
    "Type",
    "Zoning",
    "Opp Zone",
    "Acres",
    "Assessed Value",
    "Taxes",
    "Owner",
    "Contact",
    "Phones",
    "Emails",
    "Last Contacted",
    "Property Notes",
    "Activity Log",
    "Follow-Ups",
    "Documents",
    "Additional Data",
    "Archived",
    "Latitude",
    "Longitude",
    "Crexi Link",
  ];
  const rows = getVisibleParcels().map((parcel) => [
    parcel.id,
    parcel.status,
    parcel.priority,
    parcel.nextActionDue,
    parcel.nextAction,
    parcel.displayAddress,
    parcel.city,
    parcel.type,
    parcel.zoning,
    parcel.oppZone,
    parcel.acres,
    parcel.assessedValue,
    parcel.taxes,
    parcel.owner.name,
    parcel.contact.name,
    (parcel.contact.phones || []).join("; "),
    (parcel.contact.emails || []).join("; "),
    parcel.lastContacted,
    parcel.notes,
    (parcel.activity || []).map((item) => `${formatDateTime(item.at)} ${item.type || "Activity"}: ${item.text}`).join(" | "),
    (parcel.actions || [])
      .map((item) => `${item.done ? "Done" : "Open"}: ${item.text}${item.dueDate ? ` due ${item.dueDate}` : ""}`)
      .join(" | "),
    (parcel.documents || []).map((item) => `${item.title}: ${item.url}`).join(" | "),
    Object.entries(parcel.extraFields || {}).map(([key, value]) => `${key}: ${value}`).join(" | "),
    parcel.archived ? "Yes" : "No",
    parcel.lat,
    parcel.lng,
    parcel.crexiLink,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `pasco-site-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  toast(`Exported ${rows.length} parcel${rows.length === 1 ? "" : "s"}`);
}

function exportBackup() {
  const backup = {
    app: "Pasco Site Tracker",
    exportedAt: new Date().toISOString(),
    parcelCount: state.parcels.length,
    parcels: state.parcels,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `pasco-site-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  toast(`Backed up ${state.parcels.length} parcel${state.parcels.length === 1 ? "" : "s"}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;
  while (parts.length > 1) {
    const key = parts.shift();
    if (!target[key]) target[key] = {};
    target = target[key];
  }
  target[parts[0]] = value;
}

function getPath(object, path) {
  return path.split(".").reduce((target, key) => (target ? target[key] : undefined), object);
}

function buildDisplayAddress(address, city, zip, stateName = "FL") {
  const pieces = [];
  if (address) pieces.push(address);
  if (city) pieces.push(city);
  if (zip || stateName) pieces.push([stateName, zip].filter(Boolean).join(" "));
  return pieces.length ? pieces.join(", ") : "Unknown Address";
}

function geoKey(parcel) {
  if (!Number.isFinite(parcel.lat) || !Number.isFinite(parcel.lng)) return "";
  return `${Number(parcel.lat).toFixed(5)}|${Number(parcel.lng).toFixed(5)}`;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function dateValue(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  return textValue(value).split(" ")[0];
}

function makeId(seed) {
  let hash = 2166136261;
  const input = String(seed || `${Date.now()}|${Math.random()}`);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `pst_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function setSync(text) {
  els.syncState.textContent = text;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}
