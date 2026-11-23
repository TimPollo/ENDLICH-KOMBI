(() => {
  'use strict';

  const DB_NAME = 'verrueckte-kombination-daten';
  const DB_VERSION = 1;
  const DISPLAY_BATCH = 150;
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_LINES = 40000;
  const MAX_CODE_LENGTH = 512;

  const nodes = {
    stackView: document.getElementById('view-stack'),
    importView: document.getElementById('view-import'),
    tabStack: document.getElementById('tab-stack'),
    tabImport: document.getElementById('tab-import'),
    nextCode: document.getElementById('next-code'),
    nextHint: document.getElementById('next-hint'),
    copyBtn: document.getElementById('copy-btn'),
    copyLabel: document.getElementById('copy-label'),
    count: document.getElementById('remaining-count'),
    queueList: document.getElementById('queue-list'),
    queueEmpty: document.getElementById('queue-empty'),
    showMore: document.getElementById('show-more-btn'),
    deleteBtn: document.getElementById('delete-btn'),
    fileInput: document.getElementById('file-input'),
    importResult: document.getElementById('import-result'),
    dialog: document.getElementById('confirm-dialog'),
    toast: document.getElementById('toast')
  };

  let db = null;
  let pending = [];
  let seen = new Set();
  let busy = false;
  let accessibleCount = DISPLAY_BATCH;
  let toastTimer = null;

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.addEventListener('complete', () => resolve());
      tx.addEventListener('abort', () => reject(tx.error || new Error('Speichern wurde abgebrochen.')));
      tx.addEventListener('error', () => reject(tx.error || new Error('Speichern fehlgeschlagen.')));
    });
  }

  function requestDone(req) {
    return new Promise((resolve, reject) => {
      req.addEventListener('success', () => resolve(req.result));
      req.addEventListener('error', () => reject(req.error || new Error('Datenbankfehler.')));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('Lokaler Speicher wird nicht unterstützt.'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.addEventListener('upgradeneeded', () => {
        const instance = req.result;
        if (!instance.objectStoreNames.contains('records')) {
          const store = instance.createObjectStore('records', { keyPath: 'code' });
          store.createIndex('byStatusOrder', ['status', 'order'], { unique: false });
        }
        if (!instance.objectStoreNames.contains('settings')) instance.createObjectStore('settings', { keyPath: 'key' });
      });
      req.addEventListener('success', () => {
        const instance = req.result;
        instance.addEventListener('versionchange', () => instance.close());
        resolve(instance);
      });
      req.addEventListener('error', () => reject(req.error || new Error('Speicher konnte nicht geöffnet werden.')));
      req.addEventListener('blocked', () => reject(new Error('Bitte andere Fenster dieser App schließen und neu öffnen.')));
    });
  }

  async function refreshFromStorage() {
    if (!db) throw new Error('Speicher ist nicht verfügbar.');
    const tx = db.transaction('records', 'readonly');
    const done = transactionDone(tx);
    const result = requestDone(tx.objectStore('records').getAll());
    const rows = await result;
    await done;
    seen = new Set(rows.map(row => row.code));
    pending = rows.filter(row => row.status === 'pending').sort((a, b) => a.order - b.order);
    render();
  }

  function render() {
    nodes.count.textContent = pending.length.toLocaleString('de-DE');
    const next = pending[0];
    nodes.nextCode.textContent = next ? next.code : 'Noch keine Kombination';
    nodes.nextCode.classList.toggle('empty', !next);
    nodes.nextHint.textContent = next ? 'Bereit für die Zwischenablage.' : 'Importiere eine TXT-Datei, um zu starten.';
    nodes.copyBtn.disabled = !next || busy || !db;
    nodes.deleteBtn.disabled = pending.length === 0 || busy || !db;
    nodes.queueEmpty.hidden = pending.length > 0;
    nodes.queueList.hidden = pending.length === 0;
    const visible = pending.slice(0, accessibleCount);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < visible.length; i++) {
      const li = document.createElement('li');
      li.className = 'queue-item';
      const num = document.createElement('span');
      num.className = 'queue-num';
      num.textContent = String(i + 1).padStart(2, '0');
      const code = document.createElement('span');
      code.className = 'queue-value';
      code.textContent = visible[i].code;
      li.append(num, code);
      fragment.appendChild(li);
    }
    nodes.queueList.replaceChildren(fragment);
    nodes.showMore.hidden = pending.length <= accessibleCount;
    if (!nodes.showMore.hidden) nodes.showMore.textContent = `Weitere anzeigen (${(pending.length - accessibleCount).toLocaleString('de-DE')} verbleiben)`;
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    nodes.toast.textContent = message;
    nodes.toast.classList.toggle('error', error);
    nodes.toast.classList.add('show');
    toastTimer = setTimeout(() => nodes.toast.classList.remove('show'), 3700);
  }

  function selectTab(tab) {
    const showStack = tab === 'stack';
    nodes.stackView.hidden = !showStack;
    nodes.importView.hidden = showStack;
    nodes.tabStack.classList.toggle('selected', showStack);
    nodes.tabImport.classList.toggle('selected', !showStack);
    if (showStack) {
      nodes.tabStack.setAttribute('aria-current', 'page');
      nodes.tabImport.removeAttribute('aria-current');
    } else {
      nodes.tabImport.setAttribute('aria-current', 'page');
      nodes.tabStack.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  function fallbackCopy(code) {
    const area = document.createElement('textarea');
    area.value = code;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
    document.body.appendChild(area);
    const selection = window.getSelection();
    const oldRange = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    let succeeded = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      succeeded = Boolean(document.execCommand('copy'));
    } catch (_) {
      succeeded = false;
    } finally {
      area.remove();
      if (selection) {
        selection.removeAllRanges();
        if (oldRange) selection.addRange(oldRange);
      }
    }
    return succeeded;
  }

  async function copyToClipboard(code) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(code);
        return true;
      } catch (_) { /* Möglicherweise im Standalone-Modus nicht verfügbar: Fallback. */ }
    }
    return fallbackCopy(code);
  }

  async function markOneAsUsed(code) {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const req = store.get(code);
    req.addEventListener('success', () => {
      if (!req.result || req.result.status !== 'pending') {
        tx.abort();
        return;
      }
      store.put({ ...req.result, status: 'used', processedAt: Date.now() });
    });
    await transactionDone(tx);
  }

  async function copyAndTake() {
    if (busy || !db || pending.length === 0) return;
    const code = pending[0].code;
    busy = true;
    nodes.copyLabel.textContent = 'Wird kopiert …';
    render();
    try {
      const copied = await copyToClipboard(code);
      if (!copied) {
        showToast('Kopieren fehlgeschlagen – Eintrag bleibt erhalten.', true);
        return;
      }
      try {
        await markOneAsUsed(code);
        pending.shift();
        accessibleCount = DISPLAY_BATCH;
        showToast('Kopiert & aus dem Stapel entnommen.');
      } catch (err) {
        await refreshFromStorage().catch(() => {});
        showToast('Kopiert, aber nicht entnommen: Speichern fehlgeschlagen.', true);
      }
    } catch (err) {
      showToast('Kopieren fehlgeschlagen – Eintrag bleibt erhalten.', true);
    } finally {
      busy = false;
      nodes.copyLabel.textContent = 'Kopieren & entnehmen';
      render();
    }
  }

  function parseCodes(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > MAX_LINES) throw new Error(`Zu viele Zeilen. Maximal ${MAX_LINES.toLocaleString('de-DE')} je Datei.`);
    const unique = [];
    const inFile = new Set();
    let empty = 0;
    let duplicatesInFile = 0;
    for (const raw of lines) {
      const value = raw.trim();
      if (!value) { empty++; continue; }
      if (value.length > MAX_CODE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('Ungültige Zeile: Steuerzeichen oder mehr als 512 Zeichen.');
      }
      if (inFile.has(value)) { duplicatesInFile++; continue; }
      inFile.add(value);
      unique.push(value);
    }
    return { unique, empty, duplicatesInFile };
  }

  async function importCodes(codes) {
    // Eine atomare Transaktion bewahrt Reihenfolge und Duplikatschutz.
    // Die Schlüssel sind auch nach der Entnahme weiterhin in "records" gespeichert.
    const tx = db.transaction(['records', 'settings'], 'readwrite');
    const records = tx.objectStore('records');
    const settings = tx.objectStore('settings');
    let inserted = 0;
    let duplicate = 0;
    const settingRequest = settings.get('nextOrder');
    settingRequest.addEventListener('success', () => {
      let order = settingRequest.result?.value ?? 0;
      let remaining = codes.length;
      if (remaining === 0) { settings.put({ key: 'nextOrder', value: order }); return; }
      for (const code of codes) {
        const check = records.get(code);
        check.addEventListener('success', () => {
          if (check.result) duplicate++;
          else {
            records.add({ code, order: order++, status: 'pending', addedAt: Date.now() });
            inserted++;
          }
          remaining--;
          if (remaining === 0) settings.put({ key: 'nextOrder', value: order });
        });
      }
    });
    await transactionDone(tx);
    return { inserted, duplicate };
  }

  async function handleFileChange() {
    const file = nodes.fileInput.files?.[0];
    if (!file || busy) return;
    busy = true;
    nodes.fileInput.disabled = true;
    nodes.importResult.hidden = false;
    nodes.importResult.classList.remove('error');
    nodes.importResult.textContent = 'Datei wird eingelesen …';
    render();
    try {
      if (!db) throw new Error('Lokaler Speicher ist nicht verfügbar.');
      if (file.size > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß (maximal 5 MB).');
      if (!file.name.toLowerCase().endsWith('.txt') && file.type && file.type !== 'text/plain') throw new Error('Bitte eine TXT-Datei wählen.');
      const { unique, empty, duplicatesInFile } = parseCodes(await file.text());
      const { inserted, duplicate } = await importCodes(unique);
      await refreshFromStorage();
      accessibleCount = DISPLAY_BATCH;
      const skipped = duplicate + duplicatesInFile;
      nodes.importResult.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = `${inserted.toLocaleString('de-DE')} neue Kombination${inserted === 1 ? '' : 'en'} importiert`;
      const details = document.createElement('span');
      details.textContent = `${skipped.toLocaleString('de-DE')} Duplikate übersprungen · ${empty.toLocaleString('de-DE')} Leerzeilen ignoriert. Jetzt ${pending.length.toLocaleString('de-DE')} im Stapel.`;
      nodes.importResult.append(strong, details);
      showToast(inserted ? 'Import erfolgreich!' : 'Keine neuen Kombinationen.');
    } catch (err) {
      nodes.importResult.classList.add('error');
      nodes.importResult.textContent = err?.message || 'Import fehlgeschlagen. Bitte erneut versuchen.';
      showToast('Import nicht abgeschlossen.', true);
    } finally {
      nodes.fileInput.value = '';
      nodes.fileInput.disabled = false;
      busy = false;
      render();
    }
  }

  async function deleteAllPending() {
    if (!db || busy || pending.length === 0) return;
    busy = true;
    render();
    try {
      const time = Date.now();
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      for (const record of pending) store.put({ ...record, status: 'discarded', processedAt: time });
      await transactionDone(tx);
      pending = [];
      accessibleCount = DISPLAY_BATCH;
      showToast('Stapel geleert. Bekannte Kombinationen bleiben gesperrt.');
    } catch (err) {
      await refreshFromStorage().catch(() => {});
      showToast('Löschen fehlgeschlagen – Einträge sind noch vorhanden.', true);
    } finally {
      busy = false;
      render();
    }
  }

  nodes.tabStack.addEventListener('click', () => selectTab('stack'));
  nodes.tabImport.addEventListener('click', () => selectTab('import'));
  nodes.copyBtn.addEventListener('click', copyAndTake);
  nodes.fileInput.addEventListener('change', handleFileChange);
  nodes.showMore.addEventListener('click', () => { accessibleCount += DISPLAY_BATCH; render(); });
  nodes.deleteBtn.addEventListener('click', () => { if (!busy && pending.length) nodes.dialog.showModal(); });
  nodes.dialog.addEventListener('close', () => { if (nodes.dialog.returnValue === 'delete') deleteAllPending(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && db && !busy) refreshFromStorage().catch(() => {});
  });

  (async function start() {
    nodes.nextCode.textContent = 'Speicher wird geladen …';
    try {
      db = await openDatabase();
      await refreshFromStorage();
    } catch (err) {
      nodes.nextCode.textContent = 'Speicher nicht verfügbar';
      nodes.nextHint.textContent = 'Bitte Safari-Einstellungen prüfen und die App erneut öffnen.';
      showToast(err?.message || 'Lokale Datenspeicherung nicht verfügbar.', true);
    }
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Die App funktioniert auch ohne Offline-Cache online weiter.
      });
    }
  })();
})();
