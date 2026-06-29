// Browser API compatibility
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// Handle extension icon click
browserAPI.action.onClicked.addListener(() => {
    // Open the notes viewer page in a new tab
    browserAPI.tabs.create({
        url: browserAPI.runtime.getURL("pages/notes-viewer.html")
    });
});

// ---- File Sync (IndexedDB helpers) ----
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

// Keys that live alongside notes in storage.local but are not note entries.
const RESERVED_KEYS = new Set(["pendingSync", "__storageMode"]);

// Sync all notes to the stored file handle (best-effort, called from background).
// Mirrors whichever storage area is currently active (sync or local).
browserAPI.storage.onChanged.addListener(async (changes, area) => {
    // Determine the active notes area; only react to changes in that area.
    const { __storageMode } = await browserAPI.storage.local.get("__storageMode");
    const mode = __storageMode === "local" ? "local" : "sync";
    if (area !== mode) return;
    let handle;
    try {
        handle = await getStoredHandle();
    } catch (e) {
        return;
    }
    if (!handle) return;
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
            const data = await browserAPI.storage[mode].get(null);
            for (const k of RESERVED_KEYS) delete data[k];
            const json = JSON.stringify(
                { version: "1.0", syncDate: new Date().toISOString(), notes: data },
                null,
                2
            );
            const writable = await handle.createWritable();
            await writable.write(json);
            await writable.close();
        } else {
            browserAPI.storage.local.set({ pendingSync: true });
        }
    } catch (e) {
        // Permission lapsed or write failed — flag for next viewer open
        browserAPI.storage.local.set({ pendingSync: true });
    }
});
