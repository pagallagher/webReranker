const MODE_KEY = 'webreranker_mode';
const MODE_REORDER = 'reorder';
const MODE_HIDE_LOW = 'hide_low';
const STATUS_KEY = 'webreranker_status';

function getMode() {
  return new Promise((resolve) => {
    chrome.storage.local.get([MODE_KEY], (items) => {
      const mode = items && items[MODE_KEY];
      if (mode === MODE_HIDE_LOW || mode === MODE_REORDER) {
        resolve(mode);
      } else {
        resolve(MODE_REORDER);
      }
    });
  });
}

function setMode(mode) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [MODE_KEY]: mode }, () => resolve());
  });
}

function selectRadio(mode) {
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function formatStatusTime(isoTimestamp) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderStatus(status) {
  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  if (!statusText || !statusMeta) return;

  if (!status || typeof status !== 'object') {
    statusText.textContent = 'No status yet.';
    statusMeta.textContent = '';
    return;
  }

  statusText.textContent = status.text || 'No status yet.';

  const parts = [];
  const timeText = formatStatusTime(status.timestamp);
  if (timeText) parts.push(`Updated ${timeText}`);
  if (status.url) parts.push(status.url);
  statusMeta.textContent = parts.join(' | ');
}

function getStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STATUS_KEY], (items) => {
      resolve(items ? items[STATUS_KEY] : null);
    });
  });
}

function watchStatusChanges() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STATUS_KEY]) return;
    renderStatus(changes[STATUS_KEY].newValue || null);
  });
}

async function init() {
  const currentMode = await getMode();
  selectRadio(currentMode);
  const currentStatus = await getStatus();
  renderStatus(currentStatus);
  watchStatusChanges();

  const radios = document.querySelectorAll('input[name="mode"]');
  radios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      await setMode(radio.value);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
