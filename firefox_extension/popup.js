const MODE_KEY = 'webreranker_mode';
const MODE_REORDER = 'reorder';
const MODE_HIDE_LOW = 'hide_low';

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

async function init() {
  const currentMode = await getMode();
  selectRadio(currentMode);

  const radios = document.querySelectorAll('input[name="mode"]');
  radios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      await setMode(radio.value);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
