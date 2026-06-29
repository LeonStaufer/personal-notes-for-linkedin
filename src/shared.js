// Browser API compatibility - use browser namespace if available (Firefox), otherwise chrome (Chrome/Edge)
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// Set to true to enable verbose logging during development
const DEBUG = false;

function _log(message) {
    if (DEBUG && !browserAPI.runtime.getManifest().update_url) console.log("Personal Notes for LinkedIn:", message);
}

function _warn(message) {
    console.warn("Personal Notes for LinkedIn:", message);
}

function _error(message) {
    console.error("Personal Notes for LinkedIn:", message);
}

// ---- Storage mode (sync vs local) ----
// Notes live in either storage.sync (syncs across devices, ~100KB / 512-item cap)
// or storage.local (this device only, much larger). The active mode is recorded in
// storage.local under STORAGE_MODE_KEY so every context — content script, background
// worker, viewer — agrees on where the notes currently live. Default is "sync".
const STORAGE_MODE_KEY = "__storageMode";

// Bookkeeping keys that may sit alongside notes in storage.local and must never be
// treated as note entries.
const RESERVED_KEYS = new Set(["pendingSync", STORAGE_MODE_KEY]);

// Sync-storage quotas (per chrome.storage.sync limits). Only enforced in sync mode.
const SYNC_QUOTA_BYTES = 102400;
const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const SYNC_MAX_ITEMS = 512;

async function getStorageMode() {
    try {
        const { [STORAGE_MODE_KEY]: mode } = await browserAPI.storage.local.get(STORAGE_MODE_KEY);
        return mode === "local" ? "local" : "sync";
    } catch (e) {
        return "sync";
    }
}

async function setStorageMode(mode) {
    await browserAPI.storage.local.set({ [STORAGE_MODE_KEY]: mode === "local" ? "local" : "sync" });
}

function notesAreaForMode(mode) {
    return mode === "local" ? browserAPI.storage.local : browserAPI.storage.sync;
}

// Read all note entries from the currently-active area, excluding bookkeeping keys.
async function getAllNotes() {
    const mode = await getStorageMode();
    const data = await notesAreaForMode(mode).get(null);
    for (const k of RESERVED_KEYS) delete data[k];
    return data;
}

// Write note entries to the currently-active area.
async function setNotes(obj) {
    const mode = await getStorageMode();
    await notesAreaForMode(mode).set(obj);
}

// Remove note entries (by key or array of keys) from the currently-active area.
async function removeNotes(keys) {
    const mode = await getStorageMode();
    await notesAreaForMode(mode).remove(keys);
}

// Byte size of a single entry as storage.sync measures it (key + JSON value).
function noteEntryBytes(key, value) {
    return new TextEncoder().encode(key + JSON.stringify(value)).length;
}
