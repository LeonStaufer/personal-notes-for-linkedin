// DOM elements
const searchInput = document.getElementById("searchInput");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const fileInput = document.getElementById("fileInput");
const refreshBtn = document.getElementById("refreshBtn");
const notesTableBody = document.getElementById("notesTableBody");
const withNotesCountEl = document.getElementById("withNotesCount");
const emptyState = document.getElementById("emptyState");
const loadingState = document.getElementById("loadingState");
const tableContainer = document.getElementById("tableContainer");

// State
let allNotes = [];
let filteredNotes = [];
let sortColumn = "username";
let sortDirection = "asc";
const QUOTA_BYTES_PER_ITEM = 8192;
const encoder = new TextEncoder();

function parseStoredTimestamp(value) {
    if (typeof value !== "string") return "";
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function formatTimestamp(value) {
    if (!value) return "";
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return "";
    return new Date(parsed).toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

// ---- File Sync ----

function openSyncDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("notes-file-sync", 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore("handles");
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

async function getStoredHandle() {
    const db = await openSyncDb();
    return new Promise(resolve => {
        const tx = db.transaction("handles", "readonly");
        tx.objectStore("handles").get("syncFile").onsuccess = e => resolve(e.target.result ?? null);
    });
}

async function setStoredHandle(handle) {
    const db = await openSyncDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(handle, "syncFile");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function clearStoredHandle() {
    const db = await openSyncDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").delete("syncFile");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function syncToFile(handle) {
    const data = await browserAPI.storage.sync.get(null);
    const json = JSON.stringify(
        { version: "1.0", syncDate: new Date().toISOString(), notes: data },
        null,
        2
    );
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
}

function updateSyncUI(state, fileName, lastSynced) {
    const setSyncFileBtn = document.getElementById("setSyncFileBtn");
    const syncStatus = document.getElementById("syncStatus");
    const removeSyncBtn = document.getElementById("removeSyncBtn");

    syncStatus.className = "sync-status";

    switch (state) {
        case "idle":
            setSyncFileBtn.style.display = "";
            removeSyncBtn.style.display = "none";
            syncStatus.textContent = "";
            break;
        case "synced": {
            setSyncFileBtn.style.display = "none";
            removeSyncBtn.style.display = "";
            syncStatus.classList.add("synced");
            const timeStr = lastSynced ? ` (last synced ${lastSynced})` : "";
            syncStatus.textContent = `● Syncing to: ${fileName}${timeStr}`;
            break;
        }
        case "needs-auth": {
            setSyncFileBtn.style.display = "none";
            removeSyncBtn.style.display = "";
            syncStatus.textContent = "";

            const reauthorizeBtn = document.createElement("button");
            reauthorizeBtn.id = "reauthorizeBtn";
            reauthorizeBtn.className = "btn btn-secondary";
            reauthorizeBtn.textContent = "Re-authorize sync";
            reauthorizeBtn.addEventListener("click", handleReauthorize);

            const fileNameEl = document.createElement("span");
            fileNameEl.className = "sync-file-name";
            fileNameEl.textContent = fileName;

            syncStatus.appendChild(reauthorizeBtn);
            syncStatus.appendChild(fileNameEl);
            break;
        }
        case "error":
            syncStatus.classList.add("error");
            syncStatus.textContent = "Sync error — check file permissions";
            break;
    }
}

async function initFileSync() {
    const syncSection = document.getElementById("syncSection");
    const syncFallback = document.getElementById("syncFallback");
    const setSyncFileBtn = document.getElementById("setSyncFileBtn");
    const removeSyncBtn = document.getElementById("removeSyncBtn");

    if (!("showSaveFilePicker" in window)) {
        syncFallback.style.display = "";
        return;
    }

    syncSection.style.display = "";
    setSyncFileBtn.addEventListener("click", handleSetSyncFile);
    removeSyncBtn.addEventListener("click", handleRemoveSync);

    let handle;
    try {
        handle = await getStoredHandle();
    } catch (e) {
        _error(`IndexedDB error: ${e}`);
        return;
    }

    if (!handle) {
        updateSyncUI("idle");
        return;
    }

    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
        try {
            await syncToFile(handle);
            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            updateSyncUI("synced", handle.name, time);
            // Clear any pending sync flag since we just synced
            browserAPI.storage.local.remove("pendingSync");
        } catch (e) {
            _error(`Sync error on load: ${e}`);
            updateSyncUI("error");
        }
    } else {
        // Check if there was a pending sync from the background worker
        const { pendingSync } = await browserAPI.storage.local.get("pendingSync");
        updateSyncUI("needs-auth", handle.name);
        if (pendingSync) {
            showToast("Notes were saved while sync was unauthorized — please re-authorize");
        }
    }

    // Listen for storage changes while viewer tab is open
    browserAPI.storage.onChanged.addListener(async (changes, area) => {
        if (area !== "sync") return;
        let h;
        try {
            h = await getStoredHandle();
        } catch (e) {
            return;
        }
        if (!h) return;
        const p = await h.queryPermission({ mode: "readwrite" });
        if (p !== "granted") return;
        try {
            await syncToFile(h);
            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            updateSyncUI("synced", h.name, time);
        } catch (e) {
            _error(`Sync error on storage change: ${e}`);
        }
    });
}

async function handleSetSyncFile() {
    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: "linkedin-notes.json",
            types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
        });
        await setStoredHandle(handle);
        await syncToFile(handle);
        const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        updateSyncUI("synced", handle.name, time);
        showToast("Sync file set — notes will update automatically");
    } catch (e) {
        if (e.name !== "AbortError") {
            _error(`Failed to set sync file: ${e}`);
            showToast("Failed to set sync file", true);
        }
    }
}

async function handleRemoveSync() {
    if (!confirm("Remove sync file? Notes will no longer sync automatically.")) return;
    await clearStoredHandle();
    await browserAPI.storage.local.remove("pendingSync");
    updateSyncUI("idle");
    showToast("Sync file removed");
}

async function handleReauthorize() {
    const handle = await getStoredHandle();
    if (!handle) return;
    try {
        const perm = await handle.requestPermission({ mode: "readwrite" });
        if (perm === "granted") {
            await syncToFile(handle);
            await browserAPI.storage.local.remove("pendingSync");
            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            updateSyncUI("synced", handle.name, time);
            showToast("Sync re-authorized");
        }
    } catch (e) {
        _error(`Re-authorize failed: ${e}`);
        showToast("Re-authorization failed", true);
    }
}

// ---- End File Sync ----

// Initialize
async function init() {
    await loadNotes();
    setupEventListeners();
    initFileSync();
}

// Setup event listeners
function setupEventListeners() {
    searchInput.addEventListener("input", handleSearch);
    exportBtn.addEventListener("click", exportNotes);
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", handleFileSelect);
    refreshBtn.addEventListener("click", handleRefresh);

    // Sort headers
    document.querySelectorAll(".sortable").forEach(header => {
        header.addEventListener("click", () => {
            const column = header.dataset.sort;
            handleSort(column);
        });
    });
}

// Load notes from storage
async function loadNotes() {
    showLoading(true);

    try {
        const data = await browserAPI.storage.sync.get(null);

        allNotes = Object.entries(data)
            .filter(([, v]) => v && typeof v === "object" && "notes" in v)
            .map(([memberId, value]) => ({
                memberId,
                username: typeof value.username === "string" && value.username ? value.username : "Unknown",
                name: typeof value.name === "string" ? value.name : "",
                notes: typeof value.notes === "string" ? value.notes : "",
                createdAt: parseStoredTimestamp(value.createdAt),
                updatedAt: parseStoredTimestamp(value.updatedAt)
            }));

        filteredNotes = [...allNotes];
        updateStats();
        sortNotes();
        renderTable();

        showLoading(false);
    } catch (error) {
        _error(`Error loading notes: ${error}`);
        showLoading(false);
    }
}

// Update statistics
function updateStats() {
    const withNotes = allNotes.filter(note => note.notes.trim() !== "").length;
    withNotesCountEl.textContent = withNotes;
}

// Handle search
function handleSearch() {
    const query = searchInput.value.toLowerCase().trim();

    if (!query) {
        filteredNotes = [...allNotes];
    } else {
        filteredNotes = allNotes.filter(note =>
            note.username.toLowerCase().includes(query) ||
            note.name.toLowerCase().includes(query) ||
            note.notes.toLowerCase().includes(query)
        );
    }

    sortNotes();
    renderTable();
}

// Export notes to JSON file
async function exportNotes() {
    try {
        const data = await browserAPI.storage.sync.get(null);

        if (Object.keys(data).length === 0) {
            showToast("No notes to export", true);
            return;
        }

        // Create export object with metadata
        const exportData = {
            version: "1.0",
            exportDate: new Date().toISOString(),
            notes: data
        };

        // Convert to JSON
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: "application/json" });

        // Create download link
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `linkedin-notes-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Successfully exported ${Object.keys(data).length} note(s)`);
    } catch (error) {
        showToast("Failed to export notes", true);
        _error(`Export error: ${error}`);
    }
}

// Import notes from JSON file
async function importNotes(file) {
    try {
        const text = await file.text();
        let importData;

        try {
            importData = JSON.parse(text);
        } catch (error) {
            showToast("Invalid JSON file", true);
            return;
        }

        const notesData = importData.notes;
        if (typeof notesData !== "object" || notesData === null) {
            showToast("Invalid file format", true);
            return;
        }

        const validNotes = [];
        let skippedNotes = 0;

        for (const [key, value] of Object.entries(notesData)) {
            if (!isValidStorageKey(key) || !value || typeof value !== "object") {
                skippedNotes += 1;
                continue;
            }

            const note = {
                notes: typeof value.notes === "string" ? value.notes : "",
                username: typeof value.username === "string" ? value.username : "",
                memberId: typeof value.memberId === "string" && value.memberId ? value.memberId : key,
                name: typeof value.name === "string" ? value.name : "",
                createdAt: parseStoredTimestamp(value.createdAt),
                updatedAt: parseStoredTimestamp(value.updatedAt)
            };

            if (!note.createdAt && note.updatedAt) {
                note.createdAt = note.updatedAt;
            }
            if (!note.updatedAt && note.createdAt) {
                note.updatedAt = note.createdAt;
            }

            if (!note.notes && !note.username && !note.name) {
                skippedNotes += 1;
                continue;
            }

            if (getStorageItemBytes(key, note) > QUOTA_BYTES_PER_ITEM) {
                skippedNotes += 1;
                continue;
            }

            validNotes.push([key, note]);
        }

        if (validNotes.length === 0) {
            showToast("No valid notes found in file", true);
            return;
        }

        // Ask for confirmation
        const skippedText = skippedNotes ? ` ${skippedNotes} invalid or oversized item(s) will be skipped.` : "";
        const confirmMessage = `Import ${validNotes.length} note(s)? This will merge with existing notes and overwrite duplicates.${skippedText}`;
        if (!confirm(confirmMessage)) {
            showToast("Import cancelled");
            return;
        }

        // Import the notes
        await browserAPI.storage.sync.set(Object.fromEntries(validNotes));

        const skippedToast = skippedNotes ? ` (${skippedNotes} skipped)` : "";
        showToast(`Successfully imported ${validNotes.length} note(s)${skippedToast}`);
        await loadNotes();
    } catch (error) {
        showToast("Failed to import notes", true);
        _error(`Import error: ${error}`);
    }
}

// Handle file selection
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        importNotes(file);
    }
    // Reset file input so the same file can be imported again
    fileInput.value = "";
}

// Handle refresh
async function handleRefresh() {
    refreshBtn.disabled = true;
    await loadNotes();
    setTimeout(() => {
        refreshBtn.disabled = false;
    }, 1000);
}

// Handle sorting
function handleSort(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
        sortColumn = column;
        sortDirection = "asc";
    }

    sortNotes();
    renderTable();
    updateSortIndicators();
}

// Sort notes
function sortNotes() {
    filteredNotes.sort((a, b) => {
        let aVal = a[sortColumn] || "";
        let bVal = b[sortColumn] || "";

        if (typeof aVal === "string") {
            aVal = aVal.toLowerCase();
            bVal = bVal.toLowerCase();
        }

        if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
        if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
        return 0;
    });
}

// Update sort indicators
function updateSortIndicators() {
    document.querySelectorAll(".sortable").forEach(header => {
        const indicator = header.querySelector(".sort-indicator");
        if (header.dataset.sort === sortColumn) {
            indicator.textContent = sortDirection === "asc" ? "▲" : "▼";
            header.classList.add("active");
        } else {
            indicator.textContent = "";
            header.classList.remove("active");
        }
    });
}

// Render table
function renderTable() {
    if (filteredNotes.length === 0) {
        showEmptyState(true);
        return;
    }

    showEmptyState(false);
    notesTableBody.textContent = "";

    const fragment = document.createDocumentFragment();
    filteredNotes.forEach(note => {
        fragment.appendChild(createNoteRow(note));
    });
    notesTableBody.appendChild(fragment);

    updateSortIndicators();
}

function createNoteRow(note) {
    const row = document.createElement("tr");

    const usernameCell = document.createElement("td");
    usernameCell.className = "username-cell";
    if (note.username && note.username !== "Unknown") {
        const link = document.createElement("a");
        link.href = `https://www.linkedin.com/in/${encodeURIComponent(note.username)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "profile-link";
        link.textContent = note.username;
        usernameCell.appendChild(link);
    } else {
        usernameCell.appendChild(createEmptyNote("Unknown"));
    }

    const nameCell = document.createElement("td");
    nameCell.className = "name-cell";
    nameCell.appendChild(note.name ? document.createTextNode(note.name) : createEmptyNote("-"));

    const notesCell = document.createElement("td");
    notesCell.className = "notes-cell";
    const notesContent = document.createElement("div");
    notesContent.className = "notes-content";
    notesContent.appendChild(note.notes ? document.createTextNode(note.notes) : createEmptyNote("No notes"));
    const noteMeta = document.createElement("div");
    noteMeta.className = "note-meta";
    noteMeta.appendChild(document.createTextNode(`Added ${formatTimestamp(note.createdAt) || "Unknown"}`));
    noteMeta.appendChild(document.createTextNode(" • "));
    noteMeta.appendChild(document.createTextNode(`Updated ${formatTimestamp(note.updatedAt) || "Unknown"}`));
    notesCell.appendChild(notesContent);
    notesCell.appendChild(noteMeta);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions-cell";
    actionsCell.appendChild(createActionButton("Open Profile", "Open profile", "🔗", () => openProfile(note.username)));
    actionsCell.appendChild(createActionButton("Copy Notes", "Copy notes", "📋", () => copyNotes(note.notes)));
    actionsCell.appendChild(createActionButton("Delete", "Delete note", "🗑️", () => deleteNote(note.memberId, note.username)));

    row.appendChild(usernameCell);
    row.appendChild(nameCell);
    row.appendChild(notesCell);
    row.appendChild(actionsCell);
    return row;
}

function createEmptyNote(text) {
    const span = document.createElement("span");
    span.className = "empty-note";
    span.textContent = text;
    return span;
}

function createActionButton(title, ariaLabel, icon, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = title === "Delete" ? "btn-icon btn-delete delete" : "btn-icon";
    button.title = title;
    button.setAttribute("aria-label", ariaLabel);
    button.textContent = icon;
    button.addEventListener("click", onClick);
    return button;
}

// Show/hide loading state
function showLoading(show) {
    loadingState.style.display = show ? "flex" : "none";
    tableContainer.style.display = show ? "none" : "block";
}

// Show/hide empty state
function showEmptyState(show) {
    emptyState.style.display = show ? "flex" : "none";
    tableContainer.style.display = show ? "none" : "block";
}

// Open LinkedIn profile
function openProfile(username) {
    if (!username || username === "Unknown") {
        showToast("Profile URL not available", true);
        return;
    }
    window.open(`https://www.linkedin.com/in/${encodeURIComponent(username)}`, "_blank", "noopener");
}

// Copy notes to clipboard
async function copyNotes(notes) {
    try {
        await navigator.clipboard.writeText(notes);
        showToast("Notes copied to clipboard!");
    } catch (error) {
        _error(`Failed to copy notes: ${error}`);
        showToast("Failed to copy notes", true);
    }
}

// Delete a note
async function deleteNote(memberId, username) {
    if (!confirm(`Delete notes for ${username}?`)) {
        return;
    }

    try {
        await browserAPI.storage.sync.remove(memberId);
        showToast(`Notes for ${username} deleted`);
        await loadNotes();
    } catch (error) {
        _error(`Error deleting note: ${error}`);
        showToast("Failed to delete note", true);
    }
}

// Show toast notification
function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "error" : "success"}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("show");
    }, 10);

    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

function getStorageItemBytes(key, value) {
    return encoder.encode(key + JSON.stringify(value)).length;
}

function isValidStorageKey(key) {
    return typeof key === "string" && key.length > 0;
}

// Initialize on load
init();
