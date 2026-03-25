// ─────────────────────────────────────────────
//  API (Cloudflare Pages Functions)
// ─────────────────────────────────────────────
const API_BASE = '/api';

// Module namespaces keep the bundle single-file while making the code
// read like small, focused subsystems.
const Status = {};
const Utils = {};
const Api = {};
const Store = {};
const View = {};
const Actions = {};
const Zoom = {};
const Startup = {};

// ─────────────────────────────────────────────
//  API wrappers
// ─────────────────────────────────────────────
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (err) {
    if (!navigator.onLine) Status.showOffline();
    throw err;
  }

  Status.hideOffline();

  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (!res.ok) {
    const message = data && typeof data === 'object' && data.error
      ? data.error
      : (typeof data === 'string' && data.trim() ? data : `HTTP ${res.status}`);
    throw new Error(message);
  }

  if (text && !contentType.includes('application/json') && typeof data !== 'object') {
    throw new Error('Du skal logge ind igen.');
  }

  return data;
}

// ─────────────────────────────────────────────
//  Database functions
// ─────────────────────────────────────────────
async function getReports() {
  const data = await api('/bootstrap');
  return data.reports ?? [];
}

async function createReport(id) {
  return api('/reports', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

async function updateReport(id, fields) {
  await api(`/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

async function deleteReport(id) {
  await api(`/reports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

async function getInstruments(reportId) {
  const data = await api(`/reports/${encodeURIComponent(reportId)}/instruments`);
  return data.instruments ?? [];
}

async function createInstrument(id, reportId, position) {
  return api(`/reports/${encodeURIComponent(reportId)}/instruments`, {
    method: 'POST',
    body: JSON.stringify({ id, position }),
  });
}

async function updateInstrument(id, fields) {
  await api(`/instruments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

async function deleteInstrument(id) {
  await api(`/instruments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ─────────────────────────────────────────────
//  Image compression helper
// ─────────────────────────────────────────────
async function compressImage(file, maxSize = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > height && width > maxSize) {
        height = Math.round((height * maxSize) / width);
        width = maxSize;
      } else if (height > maxSize) {
        width = Math.round((width * maxSize) / height);
        height = maxSize;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1];
      URL.revokeObjectURL(img.src);
      resolve(base64);
    };
    img.onerror = () => reject(new Error('Kunne ikke indlæse billede'));
    img.src = URL.createObjectURL(file);
  });
}

// ─────────────────────────────────────────────
//  Sanitize helper (prevent XSS)
// ─────────────────────────────────────────────
function sanitize(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidBase64Photo(value) {
  if (value == null || value === '') return true;
  const text = String(value);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  try {
    const bytes = Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
    return bytes.length >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff
      && bytes[bytes.length - 1] === 0xd9;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────
//  Debounce helper
// ─────────────────────────────────────────────
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ─────────────────────────────────────────────
//  UUID helper
// ─────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─────────────────────────────────────────────
//  App state
// ─────────────────────────────────────────────
const state = {
  reports: [],
  currentReportId: null,
  instruments: {},   // keyed by reportId → array of instrument objects
  images: {},         // keyed by instrumentId → data URL (synced via DB)
  activeImageField: null,
  offline: false,
};

let uiBound = false;
const AUTO_REFRESH_INTERVAL_MS = 3000;
const DELETION_GRACE_MS = 15000;
let autoRefreshTimer = null;
let autoRefreshInFlight = false;
const deletedReportIds = new Map();
const deletedInstrumentIds = new Map();

// ─────────────────────────────────────────────
//  Cache, sync, and refresh
// ─────────────────────────────────────────────
function syncReportInstrumentCount(reportId) {
  const report = state.reports.find(r => r.id === reportId);
  if (!report) return 0;
  const count = (state.instruments[reportId] ?? []).length;
  report.instrument_count = count;
  return count;
}

function showSyncError(message) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'error';
}

function markRecentlyDeleted(map, id) {
  map.set(String(id), Date.now());
}

function pruneRecentDeletes(map) {
  const now = Date.now();
  for (const [id, deletedAt] of map.entries()) {
    if (now - deletedAt > DELETION_GRACE_MS) {
      map.delete(id);
    }
  }
}

function filterRecentlyDeleted(items, map) {
  pruneRecentDeletes(map);
  return items.filter(item => !map.has(String(item.id)));
}

function purgeReportState(reportId) {
  const instruments = state.instruments[reportId] ?? [];
  for (const inst of instruments) {
    delete state.images[inst.id];
  }

  delete state.instruments[reportId];
  state.reports = state.reports.filter(report => report.id !== reportId);

  if (state.currentReportId === reportId) {
    state.currentReportId = null;
    state.activeImageField = null;
  }
}

function purgeInstrumentState(reportId, instId) {
  const instruments = state.instruments[reportId];
  if (!instruments) return;

  state.instruments[reportId] = instruments.filter(inst => inst.id !== instId);
  delete state.images[instId];

  if (state.activeImageField === instId) {
    state.activeImageField = null;
  }

  syncReportInstrumentCount(reportId);
}

function isBlankInstrument(inst) {
  if (!inst) return false;
  const antal = (inst.antal ?? '1').trim();
  const nummer = (inst.nummer ?? '').trim();
  const hasPhoto = Boolean(inst.photo || state.images[inst.id]);
  return antal === '1' && !nummer && !hasPhoto;
}

function hasActiveTextEntry() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function canAutoRefresh() {
  return !state.offline && navigator.onLine && document.visibilityState === 'visible' && !hasActiveTextEntry();
}

async function autoRefreshFromServer() {
  if (autoRefreshInFlight || !canAutoRefresh()) return;
  autoRefreshInFlight = true;
  try {
    await refreshFromServer(state.currentReportId);
  } catch (err) {
    // The sync label already reflects the error; keep the UI quiet on background refreshes.
  } finally {
    autoRefreshInFlight = false;
  }
}

function startAutoRefreshLoop() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = window.setInterval(() => {
    autoRefreshFromServer();
  }, AUTO_REFRESH_INTERVAL_MS);
}

function pokeAutoRefresh() {
  window.setTimeout(() => {
    autoRefreshFromServer();
  }, 150);
}

async function refreshFromServer(selectedReportId = state.currentReportId) {
  try {
    const reports = Store.filterRecentlyDeleted(await Api.getReports(), deletedReportIds);
    state.reports = reports;
    state.instruments = {};
    state.images = {};
    state.activeImageField = null;

    const targetId = selectedReportId && reports.some(r => r.id === selectedReportId)
      ? selectedReportId
      : null;

    if (targetId) {
      const instruments = Store.filterRecentlyDeleted(await Api.getInstruments(targetId), deletedInstrumentIds);
      state.instruments[targetId] = instruments;

      for (const inst of instruments) {
        if (inst.photo && Utils.isValidBase64Photo(inst.photo)) {
          state.images[inst.id] = 'data:image/jpeg;base64,' + inst.photo;
        }
      }

      Store.syncReportInstrumentCount(targetId);
    }

    state.currentReportId = targetId;
    View.render();
  } catch (err) {
    Store.showSyncError('Synkronisering fejlede');
    throw err;
  }
}

function buildCollageNode(imageRows, cols) {
  if (!imageRows.length) {
    const empty = document.createElement('p');
    empty.style.fontSize = '12px';
    empty.style.color = '#bbb';
    empty.style.fontStyle = 'italic';
    empty.style.marginTop = '8px';
    empty.textContent = 'Ingen billeder tilføjet.';
    return empty;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'pp-collage';

  const title = document.createElement('div');
  title.className = 'pp-collage-title';
  title.textContent = `Billeder (${imageRows.length})`;

  const grid = document.createElement('div');
  grid.className = `pp-collage-grid cols-${cols}`;

  for (const inst of imageRows) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'pp-img-wrap';

    const frame = document.createElement('div');
    frame.className = 'pp-img-frame';

    const img = document.createElement('img');
    img.src = state.images[inst.id];
    img.alt = inst.nummer || 'instrument';
    frame.appendChild(img);

    const label = document.createElement('div');
    label.className = 'pp-img-label';
    const antal = (inst.antal || '1').trim() || '1';
    const nummer = (inst.nummer || '').trim() || 'Ukendt';
    label.textContent = `${antal} × ${nummer}`;

    imgWrap.appendChild(frame);
    imgWrap.appendChild(label);
    grid.appendChild(imgWrap);
  }

  wrapper.appendChild(title);
  wrapper.appendChild(grid);
  return wrapper;
}

// ─────────────────────────────────────────────
//  Render helpers
// ─────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('report-list');
  list.innerHTML = '';

  if (!state.reports.length) {
    list.innerHTML = '<div class="report-item" style="cursor:default; color: var(--hint); font-style: italic;">Ingen rapporter endnu</div>';
    return;
  }

  for (const r of state.reports) {
    const div = document.createElement('div');
    div.className = 'report-item' + (r.id === state.currentReportId ? ' active' : '');
    const idDiv = document.createElement('div');
    idDiv.className = 'bakke-id' + (r.bakke_id ? '' : ' empty');
    idDiv.textContent = r.bakke_id || 'Ingen bakke-ID';
    const navnDiv = document.createElement('div');
    navnDiv.className = 'bakke-navn';
    navnDiv.textContent = r.bakke_navn || '';
    const datoDiv = document.createElement('div');
    datoDiv.className = 'dato';
    const displayDate = r.dato
      ? new Date(r.dato + 'T12:00:00').toLocaleDateString('da-DK', { day: 'numeric', month: 'short' })
      : '—';
    const count = Number.isFinite(Number(r.instrument_count)) ? Number(r.instrument_count) : 0;
    datoDiv.textContent = `${displayDate} · ${count} instr.`;
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.setAttribute('data-id', r.id);
    delBtn.title = 'Slet rapport';
    delBtn.textContent = '×';
    div.appendChild(idDiv);
    div.appendChild(navnDiv);
    div.appendChild(datoDiv);
    div.appendChild(delBtn);
    div.addEventListener('click', e => {
      if (e.target.classList.contains('delete-btn')) {
        if (confirm('Slet denne rapport?')) Actions.deleteReportById(r.id);
      } else {
        Actions.selectReport(r.id).catch(err => Status.showError('Kunne ikke åbne rapport: ' + err.message));
      }
    });
    list.appendChild(div);
  }
}

function renderEditor() {
  const list = document.getElementById('instruments-list');
  list.innerHTML = '';

  if (!state.currentReportId) {
    document.getElementById('bakke-id').value = '';
    document.getElementById('bakke-navn').value = '';
    document.getElementById('dato').value = '';
    return;
  }

  const report = state.reports.find(r => r.id === state.currentReportId);
  if (!report) return;

  document.getElementById('bakke-id').value = report.bakke_id ?? '';
  document.getElementById('bakke-navn').value = report.bakke_navn ?? '';
  document.getElementById('dato').value = report.dato ?? '';

  const instruments = state.instruments[state.currentReportId] ?? [];
  for (const inst of instruments) {
    const div = document.createElement('div');
    div.className = 'instrument-row';
    div.setAttribute('data-inst-id', inst.id);

    const imgSlot = document.createElement('div');
    imgSlot.className = 'img-slot' + (state.activeImageField === inst.id ? ' active' : '');
    imgSlot.setAttribute('data-img-slot', inst.id);
    imgSlot.title = 'Klik for at aktivere, paste så et billede';
    if (state.images[inst.id]) {
      const img = document.createElement('img');
      img.src = state.images[inst.id];
      img.alt = 'billede';
      imgSlot.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'img-placeholder';
      span.appendChild(document.createTextNode('Klik +'));
      span.appendChild(document.createElement('br'));
      span.appendChild(document.createTextNode('Ctrl+V'));
      imgSlot.appendChild(span);
    }

    const instFields = document.createElement('div');
    instFields.className = 'inst-fields';
    const instRow = document.createElement('div');
    instRow.className = 'inst-row';
    const antalInput = document.createElement('input');
    antalInput.type = 'text';
    antalInput.name = 'antal';
    antalInput.value = inst.antal ?? '1';
    antalInput.placeholder = 'Antal';
    antalInput.setAttribute('data-inst-id', inst.id);
    const nummerInput = document.createElement('input');
    nummerInput.type = 'text';
    nummerInput.name = 'nummer';
    nummerInput.value = inst.nummer ?? '';
    nummerInput.placeholder = 'Instrument-nr.';
    nummerInput.setAttribute('data-inst-id', inst.id);
    instRow.appendChild(antalInput);
    instRow.appendChild(nummerInput);
    instFields.appendChild(instRow);

    const delBtn = document.createElement('button');
    delBtn.className = 'inst-delete';
    delBtn.setAttribute('data-inst-id', inst.id);
    delBtn.title = 'Fjern række';
    delBtn.textContent = '×';

    div.appendChild(imgSlot);
    div.appendChild(instFields);
    div.appendChild(delBtn);
    list.appendChild(div);
  }

  // Attach event listeners to instrument inputs
  const debouncedUpdateInst = Utils.debounce(Actions.updateInstrumentField, 400);
  list.querySelectorAll('input[name=antal]').forEach(el => {
    el.addEventListener('input', e => debouncedUpdateInst(el.getAttribute('data-inst-id'), 'antal', el.value));
  });
  list.querySelectorAll('input[name=nummer]').forEach(el => {
    el.addEventListener('input', e => debouncedUpdateInst(el.getAttribute('data-inst-id'), 'nummer', el.value));
  });
  list.querySelectorAll('.inst-delete').forEach(el => {
    el.addEventListener('click', e => {
      const id = e.target.getAttribute('data-inst-id');
      Actions.deleteInstrumentById(id);
    });
  });
  list.querySelectorAll('.img-slot').forEach(el => {
    el.addEventListener('click', e => {
      state.activeImageField = el.getAttribute('data-img-slot');
      // Update active styling
      list.querySelectorAll('.img-slot').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
    });
  });
}

function renderPrintPreview() {
  const page = document.getElementById('print-preview-inner');

  if (!state.currentReportId) {
    page.innerHTML = '<div id="print-placeholder">Vælg en rapport for at se forhåndsvisning&hellip;</div>';
    return;
  }

  const report = state.reports.find(r => r.id === state.currentReportId);
  const instruments = state.instruments[state.currentReportId] ?? [];
  const bakke = (report?.bakke_id || '').trim();
  const navn = (report?.bakke_navn || '').trim();
  const bakkeLabel = bakke + (navn ? ' - ' + navn : '');
  const dateLabel = report?.dato
    ? new Date(report.dato + 'T12:00:00').toLocaleDateString('da-DK', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })
    : '—';

  const rows = instruments.filter(x => (x.antal || '').trim() || (x.nummer || '').trim() || state.images[x.id]);
  const instCount = rows.length;
  const imageRows = rows.filter(i => state.images[i.id]);
  const imageCount = imageRows.length;

  if (!bakke && !rows.length) {
    page.innerHTML = '<div id="print-placeholder">Udfyld bakke-ID og tilføj instrumenter&hellip;</div>';
    return;
  }

  let cols = 1;
  if (imageCount >= 10) cols = 4;
  else if (imageCount >= 5) cols = 3;
  else if (imageCount >= 2) cols = 2;

  const tableRows = rows.map((inst, idx) => {
    const hasImg = state.images[inst.id];
    return `
      <tr>
        <td>${idx + 1}</td>
        <td class="nr">${sanitize(inst.nummer) || '—'}</td>
        <td class="center">${sanitize(inst.antal) || '1'}</td>
        <td class="${hasImg ? 'has-img' : 'no-img'}">${hasImg ? '&#10003;' : '—'}</td>
      </tr>
    `;
  }).join('');

  page.innerHTML = `
    <div class="pp-header">
      <div class="pp-left">
        <h2>Manglende instrumenter</h2>
        <div class="pp-bakke">Bakke: ${sanitize(bakkeLabel || '—')}</div>
      </div>
      <div class="pp-right">
        ${dateLabel}<br>
        ${instCount} instrument${instCount !== 1 ? 'er' : ''}
      </div>
    </div>
    <table class="pp-table">
      <colgroup>
        <col class="col-num">
        <col class="col-nr">
        <col class="col-antal">
        <col class="col-billede">
      </colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>Instrument-nr.</th>
          <th class="center">Antal</th>
          <th class="center">Billede</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div id="pp-collage-slot"></div>
  `;
  const collageSlot = page.querySelector('#pp-collage-slot');
  if (collageSlot) {
    collageSlot.replaceWith(buildCollageNode(imageRows, cols));
  }
}

function render() {
  View.renderSidebar();
  View.renderEditor();
  View.renderPrintPreview();
}

function bindUi() {
  if (uiBound) return;
  uiBound = true;

  Zoom.initZoom();
  document.getElementById('new-report-btn').addEventListener('click', Actions.createNewReport);
  document.getElementById('add-instrument-btn').addEventListener('click', Actions.addInstrument);

  const debouncedUpdateReport = Utils.debounce((field, value) => Actions.updateReportField(field, value), 400);
  document.getElementById('bakke-id').addEventListener('input', e => debouncedUpdateReport('bakke_id', e.target.value));
  document.getElementById('bakke-navn').addEventListener('input', e => debouncedUpdateReport('bakke_navn', e.target.value));
  document.getElementById('dato').addEventListener('input', e => debouncedUpdateReport('dato', e.target.value));

  document.getElementById('print-btn').addEventListener('click', () => window.print());
  window.addEventListener('focus', pokeAutoRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pokeAutoRefresh();
  });
}

// ─────────────────────────────────────────────
//  Actions
// ─────────────────────────────────────────────
async function selectReport(id) {
  state.currentReportId = id;
  state.activeImageField = null;

  if (!state.instruments[id]) {
    const instruments = await Api.getInstruments(id);
    state.instruments[id] = instruments;

    // Load photos from DB into state.images for display
    for (const inst of instruments) {
      if (inst.photo && Utils.isValidBase64Photo(inst.photo)) {
        state.images[inst.id] = 'data:image/jpeg;base64,' + inst.photo;
      } else if (inst.photo) {
        delete state.images[inst.id];
        inst.photo = '';
      }
    }
  }

  Store.syncReportInstrumentCount(id);
  View.render();
}

async function deleteReportById(id) {
  try {
    await Api.deleteReport(id);
    Store.markRecentlyDeleted(deletedReportIds, id);
    Store.purgeReportState(id);
    View.render();
    await refreshFromServer(state.currentReportId);
  } catch (err) {
    if (!navigator.onLine) Status.showOffline();
    Status.showError('Kunne ikke slette rapport: ' + err.message);
  }
}

async function createNewReport() {
  const id = Utils.uuid();
  try {
    const { report } = await Api.createReport(id);
    report.instrument_count = 0;
    await refreshFromServer(id);
  } catch (err) {
    Status.showError('Kunne ikke oprette rapport: ' + err.message);
  }
}

async function updateReportField(field, value) {
  if (!state.currentReportId) return;
  const report = state.reports.find(r => r.id === state.currentReportId);
  if (!report) return;

  const oldValue = report[field];
  report[field] = value;
  try {
    await Api.updateReport(state.currentReportId, { [field]: value });
    View.renderSidebar();
    View.renderPrintPreview();
  } catch (err) {
    report[field] = oldValue;
    Status.showError('Kunne ikke gemme: ' + err.message);
  }
}

async function updateInstrumentField(instId, field, value) {
  const instruments = state.instruments[state.currentReportId];
  if (!instruments) return;
  const inst = instruments.find(i => i.id === instId);
  if (!inst) return;

  const oldValue = inst[field];
  inst[field] = value;
  try {
    await Api.updateInstrument(instId, { [field]: value });
    View.renderPrintPreview();
  } catch (err) {
    inst[field] = oldValue;
    Status.showError('Kunne ikke gemme: ' + err.message);
  }
}

async function addInstrument() {
  if (!state.currentReportId) return;
  const instruments = state.instruments[state.currentReportId] ?? [];

  // Reuse the existing blank row instead of spawning an extra placeholder.
  for (let i = instruments.length - 1; i >= 0; i -= 1) {
    if (!isBlankInstrument(instruments[i])) continue;
    const input = document.querySelector(
      `input[name=nummer][data-inst-id="${instruments[i].id}"]`
    );
    if (input) input.focus();
    return;
  }

  const id = Utils.uuid();
  const position = (instruments.length > 0 ? Math.max(...instruments.map(i => i.position)) + 1 : 0);
  try {
    const { instrument: inst } = await Api.createInstrument(id, state.currentReportId, position);
    await refreshFromServer(state.currentReportId);
    // Auto-focus nummer field
    const input = document.querySelector(`input[name=nummer][data-inst-id="${id}"]`);
    if (input) input.focus();
  } catch (err) {
    Status.showError('Kunne ikke tilføje instrument: ' + err.message);
  }
}

async function deleteInstrumentById(instId) {
  const instruments = state.instruments[state.currentReportId];
  if (!instruments) return;

  // Always keep at least one row — replace instead of removing last
  if (instruments.length === 1) {
    // Clear the last row instead
    const inst = instruments[0];
    try {
      await Api.updateInstrument(inst.id, { antal: '1', nummer: '', photo: '' });
      await refreshFromServer(state.currentReportId);
    } catch (err) {
      Status.showError('Kunne ikke slette instrument: ' + err.message);
    }
    return;
  }

  try {
    await Api.deleteInstrument(instId);
    Store.markRecentlyDeleted(deletedInstrumentIds, instId);
    Store.purgeInstrumentState(state.currentReportId, instId);
    View.render();
    await refreshFromServer(state.currentReportId);
  } catch (err) {
    Status.showError('Kunne ikke slette instrument: ' + err.message);
  }
}

// ─────────────────────────────────────────────
//  Image paste
// ─────────────────────────────────────────────
document.addEventListener('paste', async e => {
  if (!state.currentReportId) return;

  const items = Array.from(e.clipboardData.items);
  const imageItem = items.find(item => item.type.startsWith('image/'));
  if (!imageItem) return;

  e.preventDefault();

  let targetInstId = state.activeImageField;

  // Fallback: use last instrument if no active field
  if (!targetInstId) {
    const instruments = state.instruments[state.currentReportId];
    if (instruments && instruments.length > 0) {
      targetInstId = instruments[instruments.length - 1].id;
    }
  }

  if (!targetInstId) return;

  const file = imageItem.getAsFile();
  if (!file) return;

  try {
    // Compress image to base64 JPEG
    const base64 = await Utils.compressImage(file);

    // Store through the API
    await Api.updateInstrument(targetInstId, { photo: base64 });

    // Update local state with data URL for display
    state.images[targetInstId] = 'data:image/jpeg;base64,' + base64;
    state.activeImageField = targetInstId;
    const inst = state.instruments[state.currentReportId]?.find(i => i.id === targetInstId);
    if (inst) inst.photo = base64;

    View.renderEditor();
    View.renderPrintPreview();
  } catch (err) {
    Status.showError('Kunne ikke gemme billede: ' + err.message);
  }
});

window.addEventListener('offline', () => Status.showOffline());
window.addEventListener('online', () => { Status.hideOffline(); Startup.init(); });

// ─────────────────────────────────────────────
//  Status and overlay helpers
// ─────────────────────────────────────────────
function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.style.display = 'block';
  setTimeout(() => { banner.style.display = 'none'; }, 8000);
}

function showOffline() {
  state.offline = true;
  document.getElementById('offline-banner').className = 'show';
}

function hideOffline() {
  state.offline = false;
  document.getElementById('offline-banner').className = '';
}

function showLoading(show) {
  document.getElementById('loading').className = show ? 'show' : '';
}

// ─────────────────────────────────────────────
//  Zoom
// ─────────────────────────────────────────────
function applyZoom(val) {
  document.getElementById('app').style.zoom = val + '%';
  document.getElementById('zoom-label').textContent = val + '%';
}

function initZoom() {
  const saved = localStorage.getItem('dfs_zoom');
  const val = saved ? parseInt(saved) : 115;
  const slider = document.getElementById('zoom-slider');
  slider.value = val;
  applyZoom(val);
  slider.addEventListener('input', e => {
    const v = e.target.value;
    localStorage.setItem('dfs_zoom', v);
    applyZoom(v);
  });
}

// ─────────────────────────────────────────────
//  Startup
// ─────────────────────────────────────────────
async function init() {
  View.bindUi();

  if (location.protocol === 'file:') {
    Status.showError('Denne version skal åbnes via Cloudflare Pages, ikke som en lokal fil.');
    return;
  }

  Status.showLoading(true);
  try {
    await refreshFromServer(null);
    startAutoRefreshLoop();
  } catch (err) {
    Status.showError('Fejl ved hentning af data: ' + err.message);
  } finally {
    Status.showLoading(false);
  }
}

// Module registry: explicit namespaces for the single shipped bundle.
Object.assign(Status, {
  showError,
  showOffline,
  hideOffline,
  showLoading,
});

Object.assign(Utils, {
  compressImage,
  sanitize,
  isValidBase64Photo,
  debounce,
  uuid,
});

Object.assign(Api, {
  api,
  getReports,
  createReport,
  updateReport,
  deleteReport,
  getInstruments,
  createInstrument,
  updateInstrument,
  deleteInstrument,
});

Object.assign(Store, {
  state,
  syncReportInstrumentCount,
  showSyncError,
  markRecentlyDeleted,
  pruneRecentDeletes,
  filterRecentlyDeleted,
  purgeReportState,
  purgeInstrumentState,
  isBlankInstrument,
  hasActiveTextEntry,
  canAutoRefresh,
  autoRefreshFromServer,
  startAutoRefreshLoop,
  pokeAutoRefresh,
  refreshFromServer,
  buildCollageNode,
});

Object.assign(View, {
  renderSidebar,
  renderEditor,
  renderPrintPreview,
  render,
  bindUi,
});

Object.assign(Actions, {
  selectReport,
  deleteReportById,
  createNewReport,
  updateReportField,
  updateInstrumentField,
  addInstrument,
  deleteInstrumentById,
});

Object.assign(Zoom, {
  applyZoom,
  initZoom,
});

Object.assign(Startup, {
  init,
});

Startup.init();
