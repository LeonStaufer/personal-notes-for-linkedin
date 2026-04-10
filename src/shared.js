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
