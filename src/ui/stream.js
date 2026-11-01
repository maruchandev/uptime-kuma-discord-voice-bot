const audio = document.querySelector('#audio');
const notificationTitle = document.querySelector('#notificationTitle');
const notificationDetails = document.querySelector('#notificationDetails');
const state = document.querySelector('#state');
const status = document.querySelector('#status');
const discordStatus = document.querySelector('#discordStatus');
const browserStatus = document.querySelector('#browserStatus');
const queueCount = document.querySelector('#queueCount');
const historyList = document.querySelector('#historyList');
const historyCount = document.querySelector('#historyCount');
const browserAudioQueue = [];
let enabled = false;
let discordReady = false;
let currentAudioItem = null;
let autoplayBlocked = false;

function showNotification(item, failed = false) {
  notificationTitle.parentElement.classList.toggle('status-down', !failed && item.display?.status === 'down');
  notificationTitle.parentElement.classList.toggle('status-up', !failed && item.display?.status === 'up');
  notificationTitle.textContent = failed ? '音声を再生できませんでした' : item.display?.title || '音声通知';
  notificationDetails.replaceChildren();
  const details = failed ? ['しばらくしてから再試行してください'] : item.display?.details || ['音声を再生しています'];
  for (const detail of details) {
    const line = document.createElement('div');
    line.textContent = detail;
    notificationDetails.append(line);
  }
}

function updatePlaybackStatus() {
  discordStatus.textContent = discordReady ? '接続済み' : '未接続';
  browserStatus.textContent = enabled ? 'HTTP音声' : '待機中';
  queueCount.textContent = `${browserAudioQueue.length + (currentAudioItem ? 1 : 0)}件`;
  status.textContent = autoplayBlocked ? '再生操作が必要です' : enabled ? '受信中' : '待機中';
  state.classList.toggle('ready', enabled);
}

function addHistoryItem(item) {
  historyList.querySelector('.empty-row')?.remove();
  const row = document.createElement('tr');
  if (item.display?.status === 'down' || item.display?.status === 'up') {
    row.classList.add(`status-${item.display.status}`);
  }
  const time = document.createElement('td');
  const date = new Date(item.createdAt || Date.now());
  time.textContent = Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('ja-JP', { hour12: false });
  const title = document.createElement('td');
  title.textContent = item.display?.title || '音声通知';
  const details = document.createElement('td');
  details.textContent = (item.display?.details || []).join(' / ') || '通知音声を再生';
  row.append(time, title, details);
  historyList.prepend(row);
  while (historyList.children.length > 20) historyList.lastElementChild.remove();
  historyCount.textContent = `${historyList.children.length}件`;
}

function releaseAudioItem(item) {
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
}

async function playCurrentAudio() {
  if (!currentAudioItem) return;
  const item = currentAudioItem;
  try {
    await audio.play();
    if (currentAudioItem === item) {
      autoplayBlocked = false;
      updatePlaybackStatus();
    }
  } catch {
    if (currentAudioItem === item) {
      autoplayBlocked = true;
      updatePlaybackStatus();
    }
  }
}

function playNextAudio() {
  if (!enabled || currentAudioItem) return;
  while (browserAudioQueue.length && browserAudioQueue[0].failed) {
    releaseAudioItem(browserAudioQueue.shift());
  }
  if (!browserAudioQueue.length || !browserAudioQueue[0].ready) {
    updatePlaybackStatus();
    return;
  }
  currentAudioItem = browserAudioQueue.shift();
  showNotification(currentAudioItem);
  audio.src = currentAudioItem.objectUrl;
  updatePlaybackStatus();
  void playCurrentAudio();
}

function finishCurrentAudio() {
  if (!currentAudioItem) return;
  releaseAudioItem(currentAudioItem);
  currentAudioItem = null;
  autoplayBlocked = false;
  playNextAudio();
  updatePlaybackStatus();
}

function receiveAudio(item) {
  const queueItem = { ...item, ready: false, failed: false };
  addHistoryItem(queueItem);
  browserAudioQueue.push(queueItem);
  if (!enabled && !currentAudioItem) showNotification(queueItem);
  updatePlaybackStatus();

  // Download on arrival so a queued clip remains available after the server cache rotates.
  fetch(queueItem.url)
    .then((response) => {
      if (!response.ok) throw new Error(`Audio download failed: ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      queueItem.objectUrl = URL.createObjectURL(blob);
      queueItem.ready = true;
      playNextAudio();
    })
    .catch(() => {
      queueItem.failed = true;
      showNotification(queueItem, true);
      playNextAudio();
    });
}

audio.addEventListener('ended', finishCurrentAudio);
audio.addEventListener('error', () => {
  if (!currentAudioItem) return;
  showNotification(currentAudioItem, true);
  finishCurrentAudio();
});
audio.addEventListener('play', () => {
  autoplayBlocked = false;
  updatePlaybackStatus();
});
document.querySelector('#start').addEventListener('click', async () => {
  enabled = true;
  updatePlaybackStatus();
  if (currentAudioItem) await playCurrentAudio();
  else playNextAudio();
});

const events = new EventSource('/stream/events');
events.addEventListener('status', (event) => {
  discordReady = JSON.parse(event.data).discordReady;
  updatePlaybackStatus();
});
events.addEventListener('audio', (event) => receiveAudio(JSON.parse(event.data)));
events.onopen = updatePlaybackStatus;
events.onerror = () => {
  status.textContent = 'サーバーへ再接続中';
  state.classList.remove('ready');
};
