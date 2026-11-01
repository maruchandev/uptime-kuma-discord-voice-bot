import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ChannelType,
} from "discord.js";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";

const requiredEnv = ["WEBHOOK_TOKEN"];
const clipCacheDir = "/app/cache";

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const config = {
  port: numberEnv("PORT", 3000),
  guildId: process.env.DISCORD_GUILD_ID,
  textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID,
  voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID,
  webhookToken: process.env.WEBHOOK_TOKEN,
  voicevoxUrl: process.env.VOICEVOX_URL || "http://voicevox:50021",
  speakerId: numberEnv("VOICEVOX_SPEAKER_ID", 3),
  speedScale: numberEnv("VOICEVOX_SPEED_SCALE", 1.05),
  timezone: process.env.TIMEZONE || "Asia/Tokyo",
  dedupMs: numberEnv("DEDUP_SECONDS", 60) * 1000,
  maxQueueSize: numberEnv("MAX_QUEUE_SIZE", 30),
  batchWindowMs: numberEnv("ALERT_BATCH_WINDOW_SECONDS", 5) * 1000,
  batchThreshold: numberEnv("ALERT_BATCH_THRESHOLD", 3),
  readingMap: parseJsonEnv("READING_MAP_JSON", {}),
};
const defaultReadingMap = { ...config.readingMap };
const readingMapFile = path.join(clipCacheDir, "reading-map.json");
await loadSavedReadingMap();

const discordEnabled = [
  process.env.DISCORD_BOT_TOKEN,
  config.voiceChannelId,
].every(Boolean);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const audioPlayer = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
});
const speechQueue = [];
const generatedAudioQueue = [];
const clipPromises = new Map();
const recentAlerts = new Map();
const audioFiles = new Map();
const streamClients = new Set();
const pendingSpeechAlerts = [];
let synthesisActive = false;
let playbackActive = false;
let audioSequence = 0;
let cacheWarmup = { done: 0, total: 0, ready: false };
let textChannel;
let voiceConnection;
let alertBatchTimer = null;

client.once("clientReady", async () => {
  const voiceChannel = await client.channels.fetch(config.voiceChannelId);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error("DISCORD_VOICE_CHANNEL_ID is not a voice channel");
  }
  const guild = voiceChannel.guild;
  if (config.guildId && config.guildId !== guild.id) {
    throw new Error("DISCORD_GUILD_ID does not match the voice channel server");
  }
  if (config.textChannelId) {
    textChannel = await guild.channels.fetch(config.textChannelId);
    if (!textChannel?.isTextBased()) {
      throw new Error("DISCORD_TEXT_CHANNEL_ID is not a text channel");
    }
  }

  voiceConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  voiceConnection.subscribe(audioPlayer);
  await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30_000);
  console.log(`Ready as ${client.user.tag}; text=${textChannel?.name || "disabled"}; voice=${voiceChannel.name}`);
});

client.on("error", (error) => console.error("Discord client error", error));
audioPlayer.on("error", (error) => console.error("Audio player error", error));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    discordEnabled,
    discord: client.isReady(),
    voice: voiceConnection?.state.status || "not-created",
    queue: speechQueue.length + generatedAudioQueue.length,
    batching: pendingSpeechAlerts.length,
    synthesizing: synthesisActive,
    playing: playbackActive,
    speechCache: cacheWarmup,
  });
});

app.get(["/stream", "/Stream"], (_req, res) => {
  res.type("html").send(streamPage());
});

app.get("/api/reading-map", async (_req, res) => {
  res.json({ entries: config.readingMap, cacheStatus: await readingMapCacheStatus(config.readingMap) });
});

app.get("/api/reading-map/preview", async (req, res) => {
  const reading = String(req.query.reading || "").trim();
  if (!reading || reading.length > 200) return res.status(400).send("Invalid reading");
  try {
    const wav = await getOrCreateClip(`警告です。${reading}で障害を検知しました。`);
    res.set({ "content-type": "audio/wav", "cache-control": "no-store" }).send(wav);
  } catch (error) {
    console.error("Reading preview failed", error);
    res.status(502).send("Preview generation failed");
  }
});

app.put("/api/reading-map", async (req, res) => {
  const entries = req.body?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return res.status(400).json({ error: "entries must be an object" });
  }
  const updated = {};
  for (const [word, reading] of Object.entries(entries)) {
    const key = String(word).trim();
    const value = String(reading).trim();
    if (!key || !value || key.length > 100 || value.length > 200 || Object.keys(updated).length >= 100) {
      return res.status(400).json({ error: "単語と読みを入力してください（各100/200文字以内、最大100件）" });
    }
    updated[key] = value;
  }

  try {
    await fs.mkdir(clipCacheDir, { recursive: true });
    const temporary = `${readingMapFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, readingMapFile);
    config.readingMap = updated;
    const phrases = [...new Set(Object.values(updated))].flatMap((name) => [
      `警告です。${name}で障害を検知しました。`,
      `復旧です。${name}は正常な状態に戻りました。`,
    ]);
    for (const phrase of phrases) await getOrCreateClip(phrase);
    res.json({ ok: true, entries: config.readingMap, cacheStatus: await readingMapCacheStatus(config.readingMap) });
  } catch (error) {
    console.error("Reading map save failed", error);
    res.status(500).json({ error: "保存または読み上げ音声の準備に失敗しました" });
  }
});

app.get("/stream/events", (req, res) => {
  res.set({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: status\ndata: ${JSON.stringify(streamStatus())}\n\n`);
  streamClients.add(res);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    streamClients.delete(res);
  });
});

app.get("/stream/audio/:id.wav", (req, res) => {
  const audio = audioFiles.get(req.params.id);
  if (!audio) return res.status(404).send("Audio not found");
  res.set({ "content-type": "audio/wav", "cache-control": "private, max-age=300" });
  res.send(audio);
});

app.post("/alert", authenticateWebhook, async (req, res) => {
  const alert = normalizeAlert(req.body);
  const dedupKey = `${alert.monitor.id || alert.monitor.name}:${alert.status}`;
  const lastSeen = recentAlerts.get(dedupKey) || 0;
  if (Date.now() - lastSeen < config.dedupMs) {
    return res.status(202).json({ accepted: false, reason: "duplicate" });
  }
  recentAlerts.set(dedupKey, Date.now());
  cleanupDedupCache();

  try {
    if (textChannel) await textChannel.send({ embeds: [buildEmbed(alert)] });
    enqueueAlertSpeech(alert);
    res.status(202).json({ accepted: true, batching: true });
  } catch (error) {
    console.error("Alert handling failed", error);
    res.status(502).json({ error: "Discord delivery failed" });
  }
});

app.post("/voice-test", authenticateWebhook, (req, res) => {
  const samples = [
    { speakerId: 30, name: "No.7・アナウンス" },
    { speakerId: 13, name: "青山龍星・ノーマル" },
    { speakerId: 10, name: "雨晴はう" },
    { speakerId: 3, name: "ずんだもん・ノーマル" },
  ];
  const phrase = "警告です。エルツー、スイッチワンが応答しません。10時5分に検知しました。";
  for (const sample of samples) {
    enqueueSpeech(`${sample.name}です。${phrase}`, sample.speakerId);
  }
  res.status(202).json({ accepted: true, samples: samples.map(({ speakerId, name }) => ({ speakerId, name })) });
});

app.use((error, _req, res, _next) => {
  console.error("HTTP error", error);
  res.status(400).json({ error: "Invalid request" });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Internal webhook listening on port ${config.port}`);
});

if (discordEnabled) {
  await client.login(process.env.DISCORD_BOT_TOKEN);
} else {
  console.warn("Discord settings are incomplete; /stream mode only");
}
void warmSpeechCache();

function authenticateWebhook(req, res, next) {
  const supplied = req.get("x-webhook-token") || "";
  const expected = config.webhookToken;
  const valid = supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function loadSavedReadingMap() {
  try {
    const saved = JSON.parse(await fs.readFile(readingMapFile, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid reading map");
    config.readingMap = Object.fromEntries(
      Object.entries(saved).filter(([word, reading]) =>
        typeof word === "string" && typeof reading === "string" && word.trim() && reading.trim()),
    );
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load saved reading map", error);
    config.readingMap = defaultReadingMap;
  }
}

function normalizeAlert(body) {
  const monitor = body.monitor || body.monitorJSON || {};
  const heartbeat = body.heartbeat || body.heartbeatJSON || null;
  let status = "test";
  if (heartbeat?.status === 0) status = "down";
  if (heartbeat?.status === 1) status = "up";

  return {
    status,
    monitor,
    heartbeat,
    rawMessage: String(body.msg || heartbeat?.msg || ""),
    name: String(monitor.name || "監視対象"),
    target: monitorTarget(monitor),
    time: alertTime(heartbeat),
    reason: summarizeReason(String(heartbeat?.msg || body.msg || "")),
  };
}

function monitorTarget(monitor) {
  if (monitor.type === "ping" || monitor.type === "dns") return monitor.hostname || "未設定";
  if (monitor.type === "port") return `${monitor.hostname || "未設定"}:${monitor.port || ""}`;
  return monitor.url || monitor.hostname || "未設定";
}

function summarizeReason(message) {
  const lower = message.toLowerCase();
  if (message.includes("Destination Host Unreachable")) return "対象機器までの通信経路に到達できません";
  if (lower.includes("no route to host")) return "対象機器への通信経路がありません";
  if (lower.includes("100% packet loss")) return "対象機器から応答がありません";
  if (lower.includes("connection refused")) return "接続が拒否されました";
  if (lower.includes("timeout") || lower.includes("timed out")) return "接続がタイムアウトしました";
  if (lower.includes("certificate") || lower.includes("cert")) return "証明書に問題があります";
  if (lower.includes("status code")) {
    const code = message.match(/status code[: ]+(\d{3})/i)?.[1];
    return code ? `HTTPステータス ${code} を検出しました` : "HTTPエラーを検出しました";
  }
  return message ? firstLine(message, 180) : "対象の状態を確認できません";
}

function alertTime(heartbeat) {
  const value = heartbeat?.time || heartbeat?.localDateTime;
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(safeDate);
}

function buildEmbed(alert) {
  const down = alert.status === "down";
  const up = alert.status === "up";
  const title = down ? `🚨 障害検知：${alert.name}` : up ? `✅ 復旧：${alert.name}` : "🔊 通知テスト";
  const color = down ? 0xe74c3c : up ? 0x2ecc71 : 0xf1c40f;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: "状態", value: down ? "障害" : up ? "正常" : "テスト", inline: true },
      { name: "監視方式", value: String(alert.monitor.type || "不明"), inline: true },
      { name: "対象", value: code(alert.target), inline: false },
      { name: "確認時刻", value: alert.time, inline: true },
    )
    .setFooter({ text: "Uptime Kuma Monitoring • VOICEVOX" })
    .setTimestamp();

  if (down) embed.addFields({ name: "原因", value: truncate(alert.reason, 1024), inline: false });
  if (up && alert.heartbeat?.ping != null) {
    embed.addFields({ name: "応答時間", value: `${Math.round(alert.heartbeat.ping)} ms`, inline: true });
  }
  if (alert.monitor.description) {
    embed.addFields({ name: "説明", value: truncate(String(alert.monitor.description), 1024), inline: false });
  }
  return embed;
}

function buildSpeech(alert) {
  const spokenName = applyReadingMap(alert.name);
  const spokenTime = spokenAlertTime(alert.heartbeat);
  if (alert.status === "down") {
    return `警告です。${spokenName}の障害を検知しました。${alert.reason}。確認時刻は、${spokenTime}です。`;
  }
  if (alert.status === "up") {
    const latency = alert.heartbeat?.ping != null
      ? `現在の応答時間は、${Math.round(alert.heartbeat.ping)}ミリ秒です。`
      : "";
    return `復旧のお知らせです。${spokenName}は正常な状態に戻りました。復旧時刻は、${spokenTime}です。${latency}`;
  }
  return "Uptime Kumaの通知テストです。テキスト通知と音声通知は正常に設定されています。";
}

function buildSpeechSegments(alert) {
  if (alert.status !== "down" && alert.status !== "up") return null;
  const spokenName = applyReadingMap(alert.name);
  const { hour, minute } = spokenAlertTimeParts(alert.heartbeat);
  const timeLabel = alert.status === "down" ? "確認時刻は、" : "復旧時刻は、";
  const segments = [
    alert.status === "down"
      ? `警告です。${spokenName}で障害を検知しました。`
      : `復旧です。${spokenName}は正常な状態に戻りました。`,
  ];
  if (alert.status === "down") segments.push(canonicalReason(alert.reason));
  segments.push(timeLabel, `${hour}時`, minute === 0 ? "ちょうどです。" : `${minute}分です。`);
  return segments;
}

function canonicalReason(reason) {
  if (reason.includes("通信経路に到達できません")) return "通信経路に到達できません。";
  if (reason.includes("通信経路がありません")) return "通信経路がありません。";
  if (reason.includes("応答がありません")) return "対象機器から応答がありません。";
  if (reason.includes("接続が拒否")) return "接続が拒否されました。";
  if (reason.includes("タイムアウト")) return "接続がタイムアウトしました。";
  if (reason.includes("証明書")) return "証明書に問題があります。";
  return "対象の状態を確認してください。";
}

function spokenAlertTime(heartbeat) {
  const { hour, minute } = spokenAlertTimeParts(heartbeat);
  return minute === 0 ? `${hour}時ちょうど` : `${hour}時${minute}分`;
}

function spokenAlertTimeParts(heartbeat) {
  const value = heartbeat?.time || heartbeat?.localDateTime;
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: config.timezone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(safeDate).map(({ type, value: partValue }) => [type, partValue]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return { hour, minute };
}

function applyReadingMap(text) {
  return Object.entries(config.readingMap).reduce(
    (result, [from, to]) => result.split(from).join(String(to)),
    text,
  );
}

function enqueueAlertSpeech(alert) {
  if (alert.status !== "down" && alert.status !== "up") {
    enqueueSpeech(buildSpeech(alert), config.speakerId, buildSpeechSegments(alert));
    return;
  }
  pendingSpeechAlerts.push(alert);
  if (!alertBatchTimer) {
    alertBatchTimer = setTimeout(flushAlertSpeechBatch, config.batchWindowMs);
  }
}

function flushAlertSpeechBatch() {
  alertBatchTimer = null;
  const received = pendingSpeechAlerts.splice(0);
  if (received.length === 0) return;

  // If a device changes state more than once in the window, announce only its latest state.
  const latestByMonitor = new Map();
  for (const alert of received) {
    const key = String(alert.monitor.id || alert.monitor.name || alert.name);
    latestByMonitor.set(key, alert);
  }

  for (const status of ["down", "up"]) {
    const alerts = [...latestByMonitor.values()].filter((alert) => alert.status === status);
    if (alerts.length === 0) continue;
    if (alerts.length < config.batchThreshold) {
      for (const alert of alerts) {
        enqueueSpeech(buildSpeech(alert), config.speakerId, buildSpeechSegments(alert));
      }
      continue;
    }
    enqueueSpeech(buildBatchSpeech(status, alerts), config.speakerId, buildBatchSpeechSegments(status, alerts));
    console.log("Batched " + alerts.length + " " + status + " alerts into one announcement");
  }
}

function batchBreakdown(alerts) {
  const rooms = new Map();
  let otherCount = 0;
  for (const alert of alerts) {
    const room = String(alert.name).match(/-V(\d{3,4})-/)?.[1];
    if (room) rooms.set(room, (rooms.get(room) || 0) + 1);
    else otherCount += 1;
  }
  const details = [...rooms.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([room, count]) => "ブイ" + Number(room) + "教室、" + count + "件");
  if (otherCount > 0) details.push("教室外の機器、" + otherCount + "件");
  return details;
}

function buildBatchSpeech(status, alerts) {
  const details = batchBreakdown(alerts).join("。");
  if (status === "down") {
    return "警告です。障害を" + alerts.length + "件検知しました。" + details + "。詳細は監視画面を確認してください。";
  }
  const latencies = alerts.map((alert) => Number(alert.heartbeat?.ping)).filter((value) => Number.isFinite(value) && value >= 0);
  const latency = latencies.length > 0
    ? "平均応答時間は、" + Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) + "ミリ秒です。"
    : "";
  return "復旧のお知らせです。" + alerts.length + "件の復旧を確認しました。" + details + "。" + latency;
}

function buildBatchSpeechSegments(status, alerts) {
  const details = batchBreakdown(alerts).map((detail) => detail + "。");
  if (status === "down") {
    return ["警告です。障害を" + alerts.length + "件検知しました。", ...details, "詳細は監視画面を確認してください。"];
  }
  const latencies = alerts.map((alert) => Number(alert.heartbeat?.ping)).filter((value) => Number.isFinite(value) && value >= 0);
  const segments = ["復旧のお知らせです。" + alerts.length + "件の復旧を確認しました。", ...details];
  if (latencies.length > 0) {
    const average = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
    segments.push("平均応答時間は、" + average + "ミリ秒です。");
  }
  return segments;
}

function enqueueSpeech(text, speakerId = config.speakerId, segments = null) {
  if (speechQueue.length + generatedAudioQueue.length >= config.maxQueueSize) {
    console.warn("Speech queue is full; dropping oldest alert");
    if (speechQueue.length > 0) speechQueue.shift();
    else generatedAudioQueue.shift();
  }
  speechQueue.push({ text, speakerId, segments });
  void processSynthesisQueue();
}

async function processSynthesisQueue() {
  if (synthesisActive) return;
  synthesisActive = true;
  try {
    while (speechQueue.length > 0) {
      const { text, speakerId, segments } = speechQueue.shift();
      try {
        const startedAt = performance.now();
        let wav;
        let cached = false;
        if (segments) {
          const clips = await Promise.all(segments.map((part) => getOrCreateClip(part, speakerId)));
          wav = concatenateWavs(clips);
          cached = true;
        }
        if (!wav) wav = await getOrCreateClip(text, speakerId);
        publishAudio(wav, text);
        generatedAudioQueue.push({ wav, text });
        console.log(`${cached ? "Assembled cached audio" : "Synthesized"} in ${Math.round(performance.now() - startedAt)} ms; ready=${generatedAudioQueue.length}`);
        void processPlaybackQueue();
      } catch (error) {
        console.error("Speech synthesis failed", error);
      }
    }
  } finally {
    synthesisActive = false;
  }
}

async function processPlaybackQueue() {
  if (playbackActive) return;
  playbackActive = true;
  try {
    while (generatedAudioQueue.length > 0) {
      const { wav, text } = generatedAudioQueue.shift();
      if (voiceConnection?.state.status !== VoiceConnectionStatus.Ready) continue;
      try {
        const resource = createAudioResource(Readable.from(wav));
        audioPlayer.play(resource);
        await entersState(audioPlayer, AudioPlayerStatus.Playing, 10_000);
        console.log(`Playback started: ${text.slice(0, 60)}`);
        await entersState(audioPlayer, AudioPlayerStatus.Idle, 120_000);
        console.log("Playback finished");
      } catch (error) {
        console.error("Speech playback failed", error);
      }
    }
  } finally {
    playbackActive = false;
  }
}

function publishAudio(wav, text) {
  const id = String(++audioSequence);
  audioFiles.set(id, wav);
  while (audioFiles.size > 20) audioFiles.delete(audioFiles.keys().next().value);
  const event = JSON.stringify({
    id,
    text,
    url: `/stream/audio/${id}.wav`,
    createdAt: new Date().toISOString(),
  });
  for (const clientResponse of streamClients) {
    clientResponse.write(`event: audio\ndata: ${event}\n\n`);
  }
}

function streamStatus() {
  return {
    discordEnabled,
    discordReady: client.isReady(),
    voice: voiceConnection?.state.status || "not-connected",
    queue: speechQueue.length + generatedAudioQueue.length,
    batching: pendingSpeechAlerts.length,
    synthesizing: synthesisActive,
    playing: playbackActive,
  };
}

function streamPage() {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uptime Kuma 音声通知</title>
<style>
body{margin:0;background:radial-gradient(ellipse at top,#1e293b 0,#0b1120 55%);color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 0}
main{width:min(900px,calc(100% - 32px));box-sizing:border-box;background:#111827;border:1px solid #263449;border-radius:22px;padding:32px;box-shadow:0 24px 80px #0008}
h1{margin:0 0 8px;font-size:27px;letter-spacing:-.03em}.muted{color:#94a3b8}.row{display:flex;gap:12px;align-items:center;margin:20px 0}
button{border:0;border-radius:10px;padding:11px 16px;background:#22c55e;color:#052e16;font-weight:700;cursor:pointer;font:inherit;font-size:14px;white-space:nowrap;transition:background .15s,transform .15s}button:hover{transform:translateY(-1px)}
#dot{width:10px;height:10px;border-radius:50%;background:#f59e0b}.ready #dot{background:#22c55e}
#log{white-space:pre-wrap;background:#111827;padding:16px;border-radius:10px;min-height:72px}audio{width:100%;margin-top:12px}
section{margin-top:30px;padding:24px;border:1px solid #263449;border-radius:18px;background:linear-gradient(145deg,#172235,#111827 70%)}input{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #334155;border-radius:10px;background:#0b1220;color:#f8fafc;outline:none}input:focus{border-color:#818cf8;box-shadow:0 0 0 3px #6366f133}.dict-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.dict-heading h2{margin:0 0 8px;font-size:21px;letter-spacing:-.02em}.dict-heading p{margin:0;max-width:650px;line-height:1.7}.dict-count{flex:none;border:1px solid #334155;background:#0b1220;color:#cbd5e1;border-radius:999px;padding:6px 11px;font-size:12px}.dict-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:20px 0 0;padding:12px;border:1px solid #263449;border-radius:14px;background:#0b1220}.dict-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dict-actions button{margin:0}.dict-actions .secondary{background:#1e293b;color:#e2e8f0}.dict-actions .secondary:hover{background:#334155}.csv-link{display:inline-flex;align-items:center;border:1px solid #334155;border-radius:10px;padding:10px 14px;color:#cbd5e1;text-decoration:none;font-size:14px;white-space:nowrap}.csv-link:hover{background:#1e293b}.save-button{min-width:132px;background:#6366f1;color:white}.save-button:hover{background:#4f46e5}.dict-status{display:block;min-height:18px;padding:8px 4px;margin:4px 0 10px;color:#a5b4fc;font-size:13px}.dict-status:empty{display:none}.dict-list{overflow-x:auto;border:1px solid #263449;border-radius:12px;background:#0b1220}.dict-head,.dict-row{display:grid;grid-template-columns:minmax(130px,1fr) minmax(150px,1.2fr) 116px 76px 54px;gap:10px;align-items:center}.dict-head{padding:10px 12px;color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#111c2e;border-bottom:1px solid #263449}.dict-row{padding:10px 12px;border-bottom:1px solid #1e293b}.dict-row:last-child{border-bottom:0}.dict-row input{min-width:0}.cache-state{white-space:nowrap;font-size:11px;color:#94a3b8}.cache-state.complete{color:#86efac}.preview-button{padding:9px 10px;background:#1e293b;color:#c7d2fe;border:1px solid #334155}.delete-button{padding:9px 10px;background:transparent;color:#fca5a5}.hint{font-size:13px;color:#9ca3af}@media(max-width:680px){body{padding:12px 0}main{padding:20px 14px}.dict-panel{padding:16px 12px} .dict-heading{display:block}.dict-count{display:inline-block;margin-top:12px}.dict-toolbar{align-items:stretch;padding:9px}.dict-actions{width:100%}.dict-actions button,.csv-link{flex:1;justify-content:center;padding:9px 8px;font-size:12px}.save-button{width:100%}.dict-head,.dict-row{grid-template-columns:minmax(95px,1fr) minmax(110px,1fr) 90px 62px 42px;gap:5px;padding-left:7px;padding-right:7px}.dict-row input{padding:8px 6px;font-size:12px}.dict-row button{padding:8px 5px;font-size:11px}.dict-head{font-size:9px}.cache-state{font-size:9px}}
</style></head><body><main><h1>Uptime Kuma 音声通知</h1><div class="muted">VOICEVOX / Discord VC連携</div>
<div class="row" id="state"><span id="dot"></span><span id="status">接続中</span></div>
<button id="start">このページで聞く（ブラウザ再生を有効化）</button><p class="muted">Discord VC接続と、このページで聞くためのブラウザ再生は別設定です。ページ内で音声を聞く場合だけ、最初に一度押してください。</p>
<div id="log">通知待機中です。</div><audio id="audio" controls></audio>
<section class="dict-panel"><div class="dict-heading"><div><h2>機器名の読み方</h2><p class="hint">Uptime Kumaの監視名と、読み上げたい名前を登録します。例：<code>router-01</code> → <code>ルーターゼロワン</code>。保存すると障害・復旧の名前音声を準備します。</p></div><span class="dict-count" id="entryCount">辞書</span></div>
<div class="dict-toolbar"><div class="dict-actions"><button class="secondary" id="loadDict">再読み込み</button><button class="secondary" id="addDict">＋ 単語を追加</button><button class="secondary" id="importCsv">CSVを読み込む</button><input id="csvFile" type="file" accept=".csv,text/csv" hidden><a class="csv-link" href="data:text/csv;charset=utf-8,%EF%BB%BFmonitor_name%2Creading%0Arouter-01%2C%E3%83%AB%E3%83%BC%E3%82%BF%E3%83%BC%E3%82%BC%E3%83%AD%E3%83%AF%E3%83%B3%0A" download="reading-map-template.csv">ひな形</a></div><button class="save-button" id="saveDict">変更を保存</button></div><div id="dictStatus" class="dict-status" role="status" aria-live="polite"></div>
<div class="dict-list"><div class="dict-head"><span>監視名</span><span>読み上げる名前</span><span>音声キャッシュ</span><span>試聴</span><span></span></div><div id="dictRows"></div></div></section>
<script>
const audio=document.querySelector('#audio'),log=document.querySelector('#log'),state=document.querySelector('#state'),status=document.querySelector('#status');let enabled=false,discordReady=false;
const browserAudioQueue=[];let currentAudioItem=null,autoplayBlocked=false;
function updatePlaybackStatus(){
  const connection=discordReady?'Discord VC接続済み':'Discord VC未接続';
  status.textContent=autoplayBlocked?'再生を開始できません。「このページで聞く」かプレイヤーの再生を押してください':enabled?'ブラウザ再生有効・'+connection+'（'+(currentAudioItem?'再生中・':'')+'待機 '+browserAudioQueue.length+'件）':connection+'（ブラウザ再生待機 '+browserAudioQueue.length+'件）';
  state.classList.toggle('ready',enabled);
}
function releaseAudioItem(item){if(item.objectUrl)URL.revokeObjectURL(item.objectUrl)}
async function playCurrentAudio(){
  if(!currentAudioItem)return;
  const item=currentAudioItem;
  try{await audio.play();if(currentAudioItem===item){autoplayBlocked=false;updatePlaybackStatus()}}
  catch(error){if(currentAudioItem===item){autoplayBlocked=true;updatePlaybackStatus()}}
}
function playNextAudio(){
  if(!enabled||currentAudioItem)return;
  while(browserAudioQueue.length&&browserAudioQueue[0].failed){releaseAudioItem(browserAudioQueue.shift())}
  if(!browserAudioQueue.length||!browserAudioQueue[0].ready){updatePlaybackStatus();return}
  currentAudioItem=browserAudioQueue.shift();log.textContent=currentAudioItem.text;audio.src=currentAudioItem.objectUrl;updatePlaybackStatus();void playCurrentAudio();
}
function finishCurrentAudio(){
  if(!currentAudioItem)return;
  releaseAudioItem(currentAudioItem);currentAudioItem=null;autoplayBlocked=false;playNextAudio();updatePlaybackStatus();
}
function enqueueBrowserAudio(item){browserAudioQueue.push(item);updatePlaybackStatus();playNextAudio()}
audio.addEventListener('ended',finishCurrentAudio);
audio.addEventListener('error',()=>{if(currentAudioItem){log.textContent='音声を再生できませんでした。'+currentAudioItem.text;finishCurrentAudio()}});
audio.addEventListener('play',()=>{autoplayBlocked=false;updatePlaybackStatus()});
document.querySelector('#start').onclick=()=>{enabled=true;updatePlaybackStatus();if(currentAudioItem)void playCurrentAudio();else playNextAudio()};
const events=new EventSource('/stream/events');
events.addEventListener('status',e=>{discordReady=JSON.parse(e.data).discordReady;updatePlaybackStatus()});
events.addEventListener('audio',e=>{
  const item={...JSON.parse(e.data),ready:false,failed:false};enqueueBrowserAudio(item);
  // Fetch immediately so waiting notifications survive eviction from the server's short audio cache.
  fetch(item.url).then(response=>{if(!response.ok)throw new Error('Audio download failed');return response.blob()}).then(blob=>{item.objectUrl=URL.createObjectURL(blob);item.ready=true;playNextAudio()}).catch(error=>{item.failed=true;playNextAudio()});
});
events.onerror=()=>{status.textContent='再接続中（待機 '+browserAudioQueue.length+'件）';state.classList.remove('ready')};
const rows=document.querySelector('#dictRows'),dictStatus=document.querySelector('#dictStatus'),entryCount=document.querySelector('#entryCount');
function updateEntryCount(){entryCount.textContent=rows.children.length+'件'}
function addRow(word='',reading='',cache={}){const row=document.createElement('div');row.className='dict-row';const wordInput=document.createElement('input');wordInput.value=word;wordInput.placeholder='例：router-01';const readingInput=document.createElement('input');readingInput.value=reading;readingInput.placeholder='例：ルーターゼロワン';const state=document.createElement('span');state.className='cache-state';const refreshState=()=>{state.textContent='障害 '+(cache.down?'✓':'–')+' / 復旧 '+(cache.up?'✓':'–');state.classList.toggle('complete',cache.down&&cache.up)};refreshState();readingInput.oninput=()=>{cache={down:false,up:false};refreshState()};const preview=document.createElement('button');preview.className='preview-button';preview.textContent='▶';preview.title='障害通知の名前部分を試聴';preview.setAttribute('aria-label','読み上げを試聴');preview.onclick=async()=>{if(!readingInput.value.trim()){dictStatus.textContent='先に読み上げる名前を入力してください';return}try{dictStatus.textContent='試聴音声を準備中…';const response=await fetch('/api/reading-map/preview?reading='+encodeURIComponent(readingInput.value.trim()));if(!response.ok)throw new Error('試聴音声を作成できませんでした');const objectUrl=URL.createObjectURL(await response.blob());enqueueBrowserAudio({text:'読み方の試聴：'+readingInput.value.trim(),objectUrl,ready:true});cache.down=true;refreshState();dictStatus.textContent='試聴音声を再生待ちに追加しました'}catch(error){dictStatus.textContent=error.message}};const remove=document.createElement('button');remove.className='delete-button';remove.textContent='×';remove.title='この単語を削除';remove.setAttribute('aria-label','この単語を削除');remove.onclick=()=>{row.remove();updateEntryCount()};row.append(wordInput,readingInput,state,preview,remove);rows.append(row);updateEntryCount()}
async function dictRequest(method='GET',body){const response=await fetch('/api/reading-map',{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error||'辞書の操作に失敗しました');return data}
document.querySelector('#loadDict').onclick=async()=>{try{dictStatus.textContent='読み込み中…';const data=await dictRequest();rows.replaceChildren();Object.entries(data.entries).sort(([a],[b])=>a.localeCompare(b,'ja')).forEach(([word,reading])=>addRow(word,reading,data.cacheStatus[word]));dictStatus.textContent=Object.keys(data.entries).length+'件読み込みました'}catch(error){dictStatus.textContent=error.message}};
document.querySelector('#addDict').onclick=()=>addRow();
function parseCsv(text){const records=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++}else if(ch==='"')quoted=false;else field+=ch}else if(ch==='"'&&field==='')quoted=true;else if(ch===','){row.push(field);field=''}else if(ch==='\\n'||ch==='\\r'){if(ch==='\\r'&&text[i+1]==='\\n')i++;row.push(field);if(row.some(cell=>cell.trim()))records.push(row);row=[];field=''}else field+=ch}if(quoted)throw new Error('CSVの引用符が閉じられていません');if(field||row.length){row.push(field);if(row.some(cell=>cell.trim()))records.push(row)}return records}
document.querySelector('#importCsv').onclick=()=>document.querySelector('#csvFile').click();
document.querySelector('#csvFile').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{const records=parseCsv((await file.text()).replace(/^\\uFEFF/,''));if(records.length<2)throw new Error('CSVにデータ行がありません');const header=records.shift().map(value=>value.trim().toLowerCase());const keyIndex=header.findIndex(value=>['monitor_name','監視名','uptime kumaの監視名'].includes(value));const readingIndex=header.findIndex(value=>['reading','読み方','読み上げる名前'].includes(value));if(keyIndex<0||readingIndex<0)throw new Error('ヘッダーは monitor_name,reading（または 監視名,読み方）にしてください');const entries=records.map(row=>[row[keyIndex]?.trim()||'',row[readingIndex]?.trim()||'']).filter(([key,reading])=>key&&reading);if(!entries.length)throw new Error('有効な監視名と読み方が見つかりません');rows.replaceChildren();entries.forEach(([key,reading])=>addRow(key,reading));dictStatus.textContent=entries.length+'件を一覧に読み込みました。内容を確認して「保存」を押してください'}catch(error){dictStatus.textContent=error.message}finally{event.target.value=''}};
document.querySelector('#saveDict').onclick=async()=>{const entries={};for(const row of rows.children){const [word,reading]=row.querySelectorAll('input');if(word.value.trim()||reading.value.trim()){if(!word.value.trim()||!reading.value.trim()){dictStatus.textContent='単語と読み方の両方を入力してください';return}entries[word.value.trim()]=reading.value.trim()}}try{dictStatus.textContent='保存・音声準備中…';const data=await dictRequest('PUT',{entries});rows.replaceChildren();Object.entries(data.entries).sort(([a],[b])=>a.localeCompare(b,'ja')).forEach(([word,reading])=>addRow(word,reading,data.cacheStatus[word]));dictStatus.textContent='保存しました（'+Object.keys(data.entries).length+'件）'}catch(error){dictStatus.textContent=error.message}};
document.querySelector('#loadDict').click();
</script></main></body></html>`;
}

async function synthesize(text, speakerId = config.speakerId) {
  const queryUrl = new URL("/audio_query", config.voicevoxUrl);
  queryUrl.searchParams.set("speaker", String(speakerId));
  queryUrl.searchParams.set("text", text);
  const queryResponse = await fetchWithRetry(queryUrl, { method: "POST" });
  const query = await queryResponse.json();
  query.speedScale = config.speedScale;

  const synthesisUrl = new URL("/synthesis", config.voicevoxUrl);
  synthesisUrl.searchParams.set("speaker", String(speakerId));
  const synthesisResponse = await fetchWithRetry(synthesisUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  return Buffer.from(await synthesisResponse.arrayBuffer());
}

async function readCachedClip(text, speakerId) {
  const filename = clipFilename(text, speakerId);
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function readingMapCacheStatus(entries) {
  const result = {};
  for (const [word, reading] of Object.entries(entries)) {
    const [down, up] = await Promise.all([
      clipIsCached(`警告です。${reading}で障害を検知しました。`),
      clipIsCached(`復旧です。${reading}は正常な状態に戻りました。`),
    ]);
    result[word] = { down, up };
  }
  return result;
}

async function clipIsCached(text, speakerId = config.speakerId) {
  try {
    await fs.access(clipFilename(text, speakerId));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function clipFilename(text, speakerId) {
  const key = crypto.createHash("sha256")
    .update(`${speakerId}:${config.speedScale}:${text}`)
    .digest("hex");
  return path.join(clipCacheDir, `${key}.wav`);
}

async function getOrCreateClip(text, speakerId = config.speakerId) {
  const filename = clipFilename(text, speakerId);
  if (clipPromises.has(filename)) return clipPromises.get(filename);
  const pending = (async () => {
    try {
      return await fs.readFile(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const wav = await synthesize(text, speakerId);
    const temporary = `${filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, wav);
    await fs.rename(temporary, filename);
    return wav;
  })();
  clipPromises.set(filename, pending);
  try {
    return await pending;
  } finally {
    clipPromises.delete(filename);
  }
}

async function warmSpeechCache() {
  await fs.mkdir(clipCacheDir, { recursive: true });
  const phrases = new Set([
    "通信経路に到達できません。",
    "通信経路がありません。",
    "対象機器から応答がありません。",
    "接続が拒否されました。",
    "接続がタイムアウトしました。",
    "証明書に問題があります。",
    "対象の状態を確認してください。",
    "確認時刻は、",
    "復旧時刻は、",
    "ちょうどです。",
    ...Array.from({ length: 24 }, (_, hour) => `${hour}時`),
    ...Array.from({ length: 59 }, (_, index) => `${index + 1}分です。`),
  ]);
  for (const name of Object.values(config.readingMap)) {
    phrases.add(name + "。");
    phrases.add(`警告です。${name}で障害を検知しました。`);
    phrases.add(`復旧です。${name}は正常な状態に戻りました。`);
  }
  const list = [...phrases];
  cacheWarmup = { done: 0, total: list.length, ready: false };
  for (const phrase of list) {
    while (speechQueue.length > 0 || synthesisActive || playbackActive) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
      await getOrCreateClip(phrase);
    } catch (error) {
      console.error(`Speech cache warmup failed for ${phrase}`, error.message);
    }
    cacheWarmup.done += 1;
    if (cacheWarmup.done % 20 === 0) {
      console.log(`Speech cache warmup ${cacheWarmup.done}/${cacheWarmup.total}`);
    }
  }
  cacheWarmup.ready = cacheWarmup.done === cacheWarmup.total;
  console.log(`Speech cache ready: ${cacheWarmup.done}/${cacheWarmup.total}`);
}

function concatenateWavs(wavs) {
  const parsed = wavs.map(parseWav);
  const first = parsed[0];
  if (parsed.some((part) => !part.format.equals(first.format))) {
    throw new Error("Speech cache WAV formats do not match");
  }
  const bytesPerSecond = first.sampleRate * first.blockAlign;
  const silence = Buffer.alloc(Math.round(bytesPerSecond * 0.08));
  const pieces = [];
  for (const [index, part] of parsed.entries()) {
    if (index > 0) pieces.push(silence);
    pieces.push(part.audio);
  }
  const audio = Buffer.concat(pieces);
  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write("fmt ", 0);
  fmtHeader.writeUInt32LE(first.format.length, 4);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(audio.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + fmtHeader.length + first.format.length + dataHeader.length + audio.length, 4);
  riff.write("WAVE", 8);
  return Buffer.concat([riff, fmtHeader, first.format, dataHeader, audio]);
}

function parseWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV in speech cache");
  }
  let format;
  let audio;
  let sampleRate;
  let blockAlign;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error("Truncated WAV in speech cache");
    if (id === "fmt ") {
      format = buffer.subarray(start, end);
      sampleRate = format.readUInt32LE(4);
      blockAlign = format.readUInt16LE(12);
    }
    if (id === "data") audio = buffer.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !audio) throw new Error("WAV format/data chunk is missing");
  return { format, audio, sampleRate, blockAlign };
}

async function fetchWithRetry(url, options, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`VOICEVOX HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

function cleanupDedupCache() {
  const cutoff = Date.now() - config.dedupMs;
  for (const [key, timestamp] of recentAlerts) {
    if (timestamp < cutoff) recentAlerts.delete(key);
  }
}

function firstLine(value, maxLength) {
  return truncate(value.split(/\r?\n/, 1)[0].trim(), maxLength);
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function code(value) {
  return `\`${String(value).replaceAll("`", "") || "未設定"}\``;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function parseJsonEnv(name, fallback) {
  try {
    return JSON.parse(process.env[name] || JSON.stringify(fallback));
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}
