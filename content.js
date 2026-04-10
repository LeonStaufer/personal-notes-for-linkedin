_log("Loaded!");

if (navigator.storage?.persist) {
    navigator.storage.persist().then((granted) => {
        if (granted) {
            _log("Storage will not be cleared except by explicit user action");
        } else {
            _warn("Storage may be cleared by the UA under storage pressure.");
        }
    }).catch((error) => {
        _warn(`Could not request persistent storage: ${error}`);
    });
} else {
    _log("Persistent storage API not available");
}

let lastUrl = "";
let injecting = false; // true while injection is in progress; prevents concurrent attempts
let debounceTimer = null;
let initialized = false;

async function handlePageState() {
    const currentUrl = window.location.href;

    if (currentUrl !== lastUrl) {
        _log(`Page changed from ${lastUrl} to ${currentUrl}`);
        lastUrl = currentUrl;
        removeNotesSection();
        injecting = false;  
    }

    _log(`handlePageState — URL: ${currentUrl}`);
    if (!isLinkedInProfileUrl(currentUrl)) {
        _log("Not a profile page, skipping");
        return;
    }
    // Already in DOM — nothing to do
    if (document.getElementById("personal-notes-notes-container")) {
        _log("Notes section already in DOM, skipping");
        return;
    }
    // Injection already in progress — wait for it
    if (injecting) {
        _log("Injection already in progress, skipping");
        return;
    }

    const { header, injectionTarget } = findProfileElements();
    if (!header || !injectionTarget) {
        _log("Topcard not found in DOM yet — waiting for mutation");
        return;
    }
    _log(`Topcard found: componentkey="${header.getAttribute("componentkey")}"`);

    injecting = true;
    try {
        const profile = await extractProfile(currentUrl, header);
        if (!profile) {
            _log("extractProfile returned null — no storage key available, aborting");
            injecting = false;
            return;
        }
        _log(`Profile extracted: username="${profile.username}", memberId="${profile.memberId}", name="${profile.name}"`);

        // Re-check: LinkedIn may have re-rendered while we awaited extractProfile
        if (!injectionTarget.isConnected) {
            _log("Injection target disconnected during extractProfile — retrying in 300ms");
            injecting = false;
            debounceTimer = setTimeout(handlePageState, 300);
            return;
        }
        if (document.getElementById("personal-notes-notes-container")) {
            _log("Notes section appeared during extractProfile — skipping duplicate injection");
            injecting = false;
            return;
        }

        await injectNotesSection(injectionTarget, profile);
    } finally {
        injecting = false;
    }
}

function findProfileElements() {
    // LinkedIn SDUI uses componentkey attribute on sections.
    // Format: "com.linkedin.sdui.profile.card.ref{encodedMemberId}Topcard"
    // Use the last match — during SPA nav LinkedIn may leave a stale topcard in the DOM briefly.
    const topcards = document.querySelectorAll("[componentkey$=\"Topcard\"]");
    if (!topcards.length) return { header: null, injectionTarget: null };
    const topcard = topcards[topcards.length - 1];
    return { header: topcard, injectionTarget: topcard };
}

function isLinkedInProfileUrl(url) {
    try {
        const parsed = new URL(url);
        const isLinkedIn = parsed.hostname === "linkedin.com" || parsed.hostname.endsWith(".linkedin.com");
        return isLinkedIn && /^\/in\/[^/]+(?:\/.*)?$/.test(parsed.pathname);
    } catch (error) {
        _warn(`Unable to parse current URL: ${error}`);
        return false;
    }
}

function getProfileUsername(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.split("/")[2] || "") || null;
    } catch (error) {
        _warn(`Unable to extract profile username: ${error}`);
        return null;
    }
}

async function extractProfile(url, header) {
    const username = getProfileUsername(url);

    // Extract person's name
    const name =
        header.querySelector("h1")?.textContent.trim() ||
        document.title.replace(/\s*\|\s*LinkedIn.*/, "").trim() ||
        null;

    // Extract encoded ID from componentkey
    const componentKey = header.getAttribute("componentkey");
    const encodedId = componentKey?.match(/sdui\.profile\.card\.ref(.+?)Topcard$/)?.[1];
    _log(`extractProfile — username: "${username}", name: "${name}", encodedId: "${encodedId}"`);

    let memberId = null;

    // Count URNs in scripts that contain the encoded topcard ID. A broad script scan can
    // include suggestions and other members, so only use it when it has a single candidate.
    {
        const filteredCounts = {};
        const allCounts = {};
        for (const script of document.querySelectorAll("script")) {
            const text = script.textContent;
            const hasEncodedId = encodedId && text.includes(encodedId);
            for (const m of text.matchAll(/urn:li:member:(\d+)/g)) {
                allCounts[m[1]] = (allCounts[m[1]] || 0) + 1;
                if (hasEncodedId) filteredCounts[m[1]] = (filteredCounts[m[1]] || 0) + 1;
            }
        }
        const filtered = Object.entries(filteredCounts).sort((a, b) => b[1] - a[1]);
        const all = Object.entries(allCounts).sort((a, b) => b[1] - a[1]);

        if (filtered.length) {
            memberId = filtered[0][0];
            _log(`Member ID from script URN scan: ${memberId} (filtered by encodedId, top count: ${filtered[0][1]})`);
        } else if (!encodedId && all.length === 1) {
            memberId = all[0][0];
            _log(`Member ID from script URN scan: ${memberId} (single unfiltered candidate, count: ${all[0][1]})`);
        } else if (!encodedId && all.length > 1) {
            _log(`Ambiguous unfiltered member URNs found (${all.length} candidates) — not using script scan`);
        } else {
            _log("No filtered urn:li:member URNs found in scripts");
        }
    }

    // Step 3: Encoded componentkey ID (not numeric, not backward-compatible)
    if (!memberId && encodedId) {
        memberId = encodedId;
        _log(`Falling back to encodedId as memberId: ${memberId}`);
    }

    // Step 4: URL username as final key fallback
    const storageKey = memberId || username;

    if (!storageKey) {
        _warn("Could not determine any storage key — aborting injection");
        return null;
    }
    _log(`Storage key resolved: "${storageKey}" (via ${memberId ? "memberId" : "username fallback"})`);

    return { username, memberId: storageKey, name };
}

function init() {
    if (initialized) {
        _log("init() already ran — skipping");
        return;
    }
    initialized = true;

    _log(`init() called — readyState: ${document.readyState}`);

    if (!document.body) {
        _log("document.body not available yet — retrying init after DOMContentLoaded");
        initialized = false;
        document.addEventListener("DOMContentLoaded", init, { once: true });
        return;
    }

    // Watch DOM mutations for React rendering completing after SPA nav
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handlePageState, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    _log("MutationObserver attached to document.body");

    // Intercept history changes so we detect LinkedIn SPA navigation immediately
    const origPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
        _log("history.pushState intercepted");
        origPushState(...args);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handlePageState, 300);
    };

    const origReplaceState = history.replaceState.bind(history);
    history.replaceState = function (...args) {
        _log("history.replaceState intercepted");
        origReplaceState(...args);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handlePageState, 300);
    };

    // Also handle browser back/forward
    window.addEventListener("popstate", () => {
        _log("popstate event fired");
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handlePageState, 300);
    });

    handlePageState(); // also run immediately for direct page loads
}

document.addEventListener("DOMContentLoaded", () => {
    _log("DOMContentLoaded fired");
    init();
});
// also run now in case DOMContentLoaded already fired
if (document.readyState !== "loading") {
    _log(`DOMContentLoaded already past (readyState: ${document.readyState}) — calling init() immediately`);
    init();
}

// Function to inject the notes section into the LinkedIn profile
async function injectNotesSection(injectionTarget, profile) {
    // Create a container for notes
    const notesContainer = document.createElement("section");
    notesContainer.id = "personal-notes-notes-container";

    // Per-item quota: key (36 bytes UUID) + JSON-encoded value must stay under 8192 bytes
    const QUOTA_BYTES_PER_ITEM = 8192;
    const encoder = new TextEncoder();
    function getItemBytes(notesText) {
        return encoder.encode(
            "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" +
            JSON.stringify({ notes: notesText, username: profile.username, memberId: profile.memberId, name: profile.name })
        ).length;
    }

    // Textarea for editing notes
    const notesInput = document.createElement("textarea");
    notesInput.id = "personal-notes-textarea";
    notesInput.placeholder = "Add your notes here...";
    notesInput.maxLength = 8192;
    notesInput.value = (await getNotes(profile)) || "";

    // Error message element (storage full, etc.)
    const statusEl = document.createElement("div");
    statusEl.id = "personal-notes-status";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");

    function updateStatus(message) {
        statusEl.textContent = message ?? "";
    }

    function isOverLimit(text) {
        return getItemBytes(text) > QUOTA_BYTES_PER_ITEM;
    }

    // Save button
    const saveButton = document.createElement("button");
    saveButton.id = "personal-notes-save-btn";

    function setButtonState(enabled) {
        saveButton.textContent = "Save Notes";
        saveButton.disabled = !enabled;
    }

    setButtonState(false);

    let initialText = notesInput.value;

    notesInput.addEventListener("input", () => {
        const overLimit = isOverLimit(notesInput.value);
        setButtonState(!overLimit && notesInput.value !== initialText);
        if (overLimit) updateStatus(`Note too long — trim to under ${(QUOTA_BYTES_PER_ITEM / 1024).toFixed(0)} KB`);
        else updateStatus(null);
    });

    saveButton.addEventListener("click", async () => {
        if (isOverLimit(notesInput.value)) {
            updateStatus(`Note too long — trim to under ${(QUOTA_BYTES_PER_ITEM / 1024).toFixed(0)} KB`);
            return;
        }

        const result = await saveNotes(profile, notesInput.value);
        if (result.ok) {
            initialText = notesInput.value;
            setButtonState(false);
            updateStatus(null);
        } else {
            updateStatus(result.error);
        }
    });

    // Add the input, counter, and button to the container
    notesContainer.appendChild(notesInput);
    notesContainer.appendChild(statusEl);
    notesContainer.appendChild(saveButton);

    // Inject the notes container after the injection target
    injectionTarget.insertAdjacentElement("afterend", notesContainer);

    _log("Successfully injected notes section");
}

// Function to remove the notes section from the LinkedIn profile
function removeNotesSection() {
    const notesContainer = document.getElementById("personal-notes-notes-container");
    if (notesContainer) {
        notesContainer.remove();
        _log("Removed notes section");
    }
}

// Find an existing stored entry matching the given profile.
// Returns { key, entry } for the best match, or null if none found.
// Match priority: exact memberId field → exact username field → fuzzy username.
async function findEntry(profile) {
    const all = await browserAPI.storage.sync.get(null);
    const normalize = s => s?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    const currentNorm = normalize(profile.username);

    let fuzzyUsernameMatch = null;

    for (const [key, entry] of Object.entries(all)) {
        if (typeof entry !== "object" || entry === null) continue;

        // 1. Exact memberId
        if (profile.memberId && entry.memberId === profile.memberId)
            return { key, entry };

        // 2. Exact username
        if (profile.username && entry.username === profile.username)
            return { key, entry };

        // 3. Fuzzy username (keep first match, checked after full scan loses to exact above)
        if (!fuzzyUsernameMatch && currentNorm && entry.username &&
            normalize(entry.username) === currentNorm)
            fuzzyUsernameMatch = { key, entry };
    }

    return fuzzyUsernameMatch ?? null;
}

// Retrieve notes from storage
async function getNotes(profile) {
    try {
        const result = await findEntry(profile);
        if (!result) {
            _log(`No notes found for ${profile.username}`);
            return null;
        }
        return result.entry.notes;
    } catch (error) {
        _error(`Failed to get notes for ${profile.username} with error: ${error}`);
        return null;
    }
}

// Save notes to storage, updating an existing entry in place or creating a new one with a UUID key.
// Returns { ok: true } on success or { ok: false, error: string } on failure.
async function saveNotes(profile, notes) {
    try {
        const existing = await findEntry(profile);

        if (notes.length === 0) {
            if (existing?.key) {
                await browserAPI.storage.sync.remove(existing.key);
                _log(`Empty note removed for ${profile.username} (key: ${existing.key})`);
            }
            return { ok: true };
        }

        const key = existing?.key ?? crypto.randomUUID();
        await browserAPI.storage.sync.set({
            [key]: { notes, username: profile.username, memberId: profile.memberId, name: profile.name },
        });
        _log(`Note for ${profile.username} saved (key: ${key})`);
        return { ok: true };
    } catch (error) {
        if (error.name === "QuotaExceededError" || error.message?.includes("QuotaExceeded") || error.message?.includes("quota")) {
            _error(`Quota exceeded saving note for ${profile.username}: ${error}`);
            return { ok: false, error: "Storage full — delete some notes to free up space." };
        }
        _error(`Failed to save note for ${profile.username} with error: ${error}`);
        return { ok: false, error: "Failed to save note." };
    }
}
