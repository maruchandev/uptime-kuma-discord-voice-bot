const dictStatus = document.querySelector('#dictStatus');
const entryCount = document.querySelector('#entryCount');
const jsonEditor = document.querySelector('#jsonEditor');
const lineNumbers = document.querySelector('#lineNumbers');
const saveState = document.querySelector('#saveState');
const jsonTemplateLink = document.querySelector('#jsonTemplate');
const jsonFileInput = document.querySelector('#jsonFile');
const previewReading = document.querySelector('#previewReading');
const previewAudio = document.querySelector('#previewAudio');
const cacheSummary = document.querySelector('#cacheSummary');
const cacheProgressFill = document.querySelector('#cacheProgressFill');
const cacheProgressTrack = document.querySelector('.cache-progress-track');
const cacheProgressCount = document.querySelector('#cacheProgressCount');
const cacheRows = document.querySelector('#cacheRows');
const cacheNote = document.querySelector('#cacheNote');
let jsonTemplateUrl = null;
let previewUrl = null;
let savedJson = '';
let cacheGenerationActive = false;
let cachePollTimer = null;

function orderedEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right, 'ja')),
  );
}

function formatDictionary(entries, groups) {
  return `${JSON.stringify({ groups, entries: orderedEntries(entries) }, null, 2)}\n`;
}

function setEditorDictionary(entries, groups = {}, persisted = false) {
  jsonEditor.value = formatDictionary(entries, groups);
  if (persisted) savedJson = jsonEditor.value;
  updateEditorState();
}

function updateEditorState() {
  const lineCount = Math.max(1, jsonEditor.value.split('\n').length);
  lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  lineNumbers.scrollTop = jsonEditor.scrollTop;
  try {
    const dictionary = parseDictionary(jsonEditor.value);
    entryCount.textContent = `${Object.keys(dictionary.entries).length}件 / グループ${Object.keys(dictionary.groups).length}件`;
  } catch {
    entryCount.textContent = 'JSON確認中';
  }
  const isSaved = jsonEditor.value === savedJson;
  saveState.textContent = isSaved ? '保存済み' : '未保存の変更';
  saveState.classList.toggle('is-dirty', !isSaved);
  updateCacheNote();
}

function setDownloadDictionary(entries, groups) {
  if (jsonTemplateUrl) URL.revokeObjectURL(jsonTemplateUrl);
  jsonTemplateUrl = URL.createObjectURL(new Blob(
    [formatDictionary(entries, groups)],
    { type: 'application/json;charset=utf-8' },
  ));
  jsonTemplateLink.href = jsonTemplateUrl;
  jsonTemplateLink.removeAttribute('aria-disabled');
}

function renderCacheStatus(entries, status = {}) {
  const pairs = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right, 'ja'));
  const total = pairs.length * 2;
  let ready = 0;
  cacheRows.replaceChildren();

  for (const [word, reading] of pairs) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const readingCell = document.createElement('td');
    nameCell.textContent = word;
    readingCell.textContent = typeof reading === 'string' ? reading : reading?.reading || '';
    row.append(nameCell, readingCell);
    for (const kind of ['down', 'up']) {
      const cell = document.createElement('td');
      const isReady = Boolean(status[word]?.[kind]);
      if (isReady) ready += 1;
      const badge = document.createElement('span');
      badge.className = `cache-badge ${isReady ? 'is-ready' : ''}`;
      badge.textContent = isReady ? '準備済み' : cacheGenerationActive ? '待機中' : '未生成';
      cell.append(badge);
      row.append(cell);
    }
    cacheRows.append(row);
  }

  const ratio = total ? ready / total : 1;
  cacheProgressFill.style.width = `${Math.round(ratio * 100)}%`;
  cacheProgressTrack.setAttribute('aria-valuemax', String(total || 1));
  cacheProgressTrack.setAttribute('aria-valuenow', String(ready));
  cacheProgressCount.textContent = `${ready} / ${total}`;
  cacheSummary.textContent = cacheGenerationActive
    ? '音声を生成中'
    : ready === total ? 'すべて準備済み' : `${total - ready}件が未生成`;
  updateCacheNote();
}

function updateCacheNote() {
  if (cacheGenerationActive) {
    cacheNote.textContent = '保存した読みの障害・復旧音声を順に生成しています。状態は自動更新されます。';
  } else if (jsonEditor.value !== savedJson) {
    cacheNote.textContent = 'JSONに未保存の変更があります。保存すると対象の音声キャッシュを更新します。';
  } else {
    cacheNote.textContent = '保存済み辞書の音声キャッシュ状態です。';
  }
}

function parseDictionary(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSONはgroupsとentriesを持つオブジェクトにしてください');
  }
  const structured = parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries);
  const entries = structured ? parsed.entries : parsed;
  const groups = structured ? (parsed.groups ?? {}) : {};
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('groupsは正規表現とグループ名のオブジェクトにしてください');
  if (Object.keys(groups).length > 200) throw new Error('グループルールは200件までです');
  const pairs = Object.entries(entries);
  if (pairs.length > 500) throw new Error('登録できる読みは500件までです');
  const normalizedEntries = {};
  for (const [word, reading] of pairs) {
    const value = typeof reading === 'string' ? reading : reading && typeof reading === 'object' && !Array.isArray(reading) ? reading.reading : null;
    const group = typeof reading === 'object' && reading && !Array.isArray(reading) ? (reading.group || '') : '';
    if (!word.trim() || typeof value !== 'string' || !value.trim() || typeof group !== 'string') {
      throw new Error('監視名と読みは空でない文字列にしてください');
    }
    if (word.length > 100 || value.length > 200 || group.length > 100) {
      throw new Error('監視名は100文字、読みは200文字以内にしてください');
    }
    normalizedEntries[word] = { reading: value.trim(), group: group.trim() };
  }
  for (const [pattern, name] of Object.entries(groups)) {
    if (!pattern.trim() || pattern.length > 200 || typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new Error('正規表現は200文字以内、グループ名は1〜100文字で入力してください');
    }
    try { new RegExp(pattern); } catch { throw new Error(`正規表現が無効です: ${pattern}`); }
  }
  return { entries: normalizedEntries, groups };
}

async function dictRequest(method = 'GET', body) {
  const response = await fetch('/api/reading-map', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '辞書の操作に失敗しました');
  return data;
}

async function refreshCacheStatus() {
  const data = await dictRequest();
  renderCacheStatus(data.entries, data.cacheStatus);
}

async function loadDictionary() {
  dictStatus.textContent = '辞書を読み込んでいます';
  try {
    const data = await dictRequest();
    setEditorDictionary(data.entries, data.groups || {}, true);
    setDownloadDictionary(data.entries, data.groups || {});
    renderCacheStatus(data.entries, data.cacheStatus);
    dictStatus.textContent = `${Object.keys(data.entries).length}件と${Object.keys(data.groups || {}).length}グループを読み込みました`;
  } catch (error) {
    dictStatus.textContent = error.message;
  }
}

async function loadJsonFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const dictionary = parseDictionary((await file.text()).replace(/^\uFEFF/, ''));
    setEditorDictionary(dictionary.entries, dictionary.groups);
    dictStatus.textContent = `${Object.keys(dictionary.entries).length}件と${Object.keys(dictionary.groups).length}グループを読み込みました。内容を確認して保存してください`;
  } catch (error) {
    dictStatus.textContent = error instanceof SyntaxError
      ? 'JSONを読み取れません。形式を確認してください'
      : error.message;
  } finally {
    event.target.value = '';
  }
}

document.querySelector('#loadDict').addEventListener('click', loadDictionary);
document.querySelector('#formatJson').addEventListener('click', () => {
  try {
    const dictionary = parseDictionary(jsonEditor.value);
    jsonEditor.value = formatDictionary(dictionary.entries, dictionary.groups);
    updateEditorState();
    dictStatus.textContent = 'JSONを整形しました';
  } catch (error) {
    dictStatus.textContent = error instanceof SyntaxError
      ? 'JSONを読み取れません。形式を確認してください'
      : error.message;
    jsonEditor.focus();
  }
});
document.querySelector('#importJson').addEventListener('click', () => jsonFileInput.click());
jsonFileInput.addEventListener('change', loadJsonFile);
jsonEditor.addEventListener('input', updateEditorState);
jsonEditor.addEventListener('scroll', () => { lineNumbers.scrollTop = jsonEditor.scrollTop; });
jsonEditor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    document.querySelector('#saveDict').click();
  }
});
jsonTemplateLink.addEventListener('click', (event) => {
  if (jsonTemplateLink.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    dictStatus.textContent = '保存済み辞書を読み込んでからダウンロードしてください';
  }
});

document.querySelector('#syncMonitors').addEventListener('click', async () => {
  dictStatus.textContent = 'Uptime Kumaから監視対象を取得しています';
  try {
    const dictionary = parseDictionary(jsonEditor.value);
    const { entries } = dictionary;
    const response = await fetch('/api/monitors');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '監視対象を取得できませんでした');
    if (!data.configured) throw new Error('同期設定がありません。KUMA_SOCKET_URL、KUMA_USERNAME、KUMA_PASSWORDを設定してください');
    if (!data.connected) throw new Error(data.error || `Uptime Kumaに接続できません（状態: ${data.status}）`);

    const existing = new Set(Object.keys(entries));
    const candidates = data.monitors.filter((monitor) => !existing.has(monitor.name));
    const additions = candidates.slice(0, Math.max(0, 500 - existing.size));
    for (const monitor of additions) entries[monitor.name] = { reading: monitor.name, group: '' };
    setEditorDictionary(entries, dictionary.groups);
    dictStatus.textContent = additions.length
      ? `${additions.length}件をJSONに追加しました。読みを確認して保存してください`
      : candidates.length
        ? '登録上限500件のため、候補を追加できませんでした'
        : `新しい監視対象はありません（${data.monitors.length}件を確認）`;
  } catch (error) {
    dictStatus.textContent = error.message;
  }
});

document.querySelector('#saveDict').addEventListener('click', async () => {
  let dictionary;
  try {
    dictionary = parseDictionary(jsonEditor.value);
  } catch (error) {
    dictStatus.textContent = error instanceof SyntaxError
      ? 'JSONを読み取れません。形式を確認してください'
      : error.message;
    jsonEditor.focus();
    return;
  }

  dictStatus.textContent = '保存して音声キャッシュを準備しています';
  cacheGenerationActive = true;
  updateCacheNote();
  cachePollTimer = window.setInterval(() => { void refreshCacheStatus().catch(() => {}); }, 2000);
  const saveButton = document.querySelector('#saveDict');
  saveButton.disabled = true;
  saveButton.textContent = '音声を準備中';
  try {
    const data = await dictRequest('PUT', dictionary);
    setEditorDictionary(data.entries, data.groups || {}, true);
    setDownloadDictionary(data.entries, data.groups || {});
    renderCacheStatus(data.entries, data.cacheStatus);
    dictStatus.textContent = `${Object.keys(data.entries).length}件を保存しました`;
  } catch (error) {
    dictStatus.textContent = error.message;
  } finally {
    clearInterval(cachePollTimer);
    cachePollTimer = null;
    cacheGenerationActive = false;
    saveButton.disabled = false;
    saveButton.textContent = 'JSONを保存';
    updateCacheNote();
    void refreshCacheStatus().catch(() => {});
  }
});

document.querySelector('#previewButton').addEventListener('click', async () => {
  const reading = previewReading.value.trim();
  if (!reading) {
    dictStatus.textContent = '試聴する読みを入力してください';
    previewReading.focus();
    return;
  }
  try {
    dictStatus.textContent = '試聴音声を準備しています';
    const response = await fetch(`/api/reading-map/preview?reading=${encodeURIComponent(reading)}`);
    if (!response.ok) throw new Error('試聴音声を作成できませんでした');
    const blob = await response.blob();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    previewAudio.src = previewUrl;
    await previewAudio.play();
    dictStatus.textContent = `「${reading}」の試聴を再生しています`;
  } catch (error) {
    dictStatus.textContent = error.name === 'NotAllowedError'
      ? '再生できませんでした。下のプレイヤーから再生してください'
      : error.message;
  }
});

window.addEventListener('pagehide', () => {
  if (jsonTemplateUrl) URL.revokeObjectURL(jsonTemplateUrl);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (cachePollTimer) clearInterval(cachePollTimer);
});

loadDictionary();
