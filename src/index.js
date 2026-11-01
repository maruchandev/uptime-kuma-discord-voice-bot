import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import express from "express";
import { io as createSocketClient } from "socket.io-client";
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
const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const config = {
  port: numberEnv("PORT", 3000),
  guildId: process.env.DISCORD_GUILD_ID,
  textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
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
  kumaSocketUrl: process.env.KUMA_SOCKET_URL || "",
  kumaUsername: process.env.KUMA_USERNAME || "",
  kumaPassword: process.env.KUMA_PASSWORD || "",
  readingMap: parseJsonEnv("READING_MAP_JSON", {}),
  groupMap: {},
  monitorGroupMap: {},
};
const defaultReadingMap = { ...config.readingMap };
const readingMapFile = path.join(clipCacheDir, "reading-map.json");
await loadSavedReadingMap();

const discordEnabled = [
  process.env.DISCORD_BOT_TOKEN,
  config.voiceChannelId,
].every(Boolean);
const slackEnabled = Boolean(config.slackWebhookUrl);

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
let queuePressureWarned = false;
let audioSequence = 0;
let cacheWarmup = { done: 0, total: 0, ready: false };
let textChannel;
let voiceConnection;
let alertBatchTimer = null;
let kumaSocket = null;
let kumaSocketStatus = "not-configured";
let kumaSocketError = "";
let kumaMonitors = new Map();
let kumaMonitorsSyncedAt = null;

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
app.use("/stream-assets", express.static(uiDir, { maxAge: "1h", fallthrough: false }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    discordEnabled,
    slackEnabled,
    discord: client.isReady(),
    voice: voiceConnection?.state.status || "not-created",
    queue: speechQueue.length + generatedAudioQueue.length,
    batching: pendingSpeechAlerts.length,
    synthesizing: synthesisActive,
    playing: playbackActive,
    speechCache: cacheWarmup,
  });
});

app.get(["/stream/dictionary", "/Stream/dictionary"], (_req, res) => {
  res.set("cache-control", "no-cache").sendFile(path.join(uiDir, "dictionary.html"));
});

app.get(["/stream", "/Stream"], (_req, res) => {
  res.set("cache-control", "no-cache").sendFile(path.join(uiDir, "stream.html"));
});

app.get("/api/reading-map", async (_req, res) => {
  res.json({ entries: structuredReadingEntries(), groups: config.groupMap, cacheStatus: await readingMapCacheStatus(config.readingMap) });
});

app.get("/api/monitors", (_req, res) => {
  res.json({
    configured: Boolean(config.kumaSocketUrl && config.kumaUsername && config.kumaPassword),
    connected: kumaSocketStatus === "connected",
    status: kumaSocketStatus,
    error: kumaSocketError,
    syncedAt: kumaMonitorsSyncedAt,
    monitors: [...kumaMonitors.values()].sort((left, right) => left.name.localeCompare(right.name, "ja")),
  });
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
  const groups = req.body?.groups || {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return res.status(400).json({ error: "entries must be an object" });
  }
  if (!groups || typeof groups !== "object" || Array.isArray(groups) || Object.keys(groups).length > 200) {
    return res.status(400).json({ error: "groups must be an object with at most 200 rules" });
  }
  const updated = {};
  const updatedMonitorGroups = {};
  for (const [word, reading] of Object.entries(entries)) {
    const key = String(word).trim();
    const value = String(typeof reading === "string" ? reading : reading?.reading || "").trim();
    const rawGroup = typeof reading === "object" && reading ? (reading.group ?? "") : "";
    if (typeof rawGroup !== "string") return res.status(400).json({ error: "グループ名は文字列で入力してください" });
    const group = rawGroup.trim();
    if (!key || !value || key.length > 100 || value.length > 200 || Object.keys(updated).length >= 500) {
      return res.status(400).json({ error: "単語と読みを入力してください（各100/200文字以内、最大500件）" });
    }
    if (group.length > 100) return res.status(400).json({ error: "グループ名は100文字以内にしてください" });
    updated[key] = value;
    if (group) updatedMonitorGroups[key] = group;
  }
  const updatedGroups = {};
  for (const [pattern, name] of Object.entries(groups)) {
    if (!pattern || pattern.length > 200 || typeof name !== "string" || !name.trim() || name.length > 100) {
      return res.status(400).json({ error: "グループの正規表現は200文字以内、名称は1〜100文字で入力してください" });
    }
    try {
      new RegExp(pattern);
    } catch {
      return res.status(400).json({ error: `無効な正規表現です: ${pattern}` });
    }
    updatedGroups[pattern] = name.trim();
  }

  try {
    await fs.mkdir(clipCacheDir, { recursive: true });
    const temporary = `${readingMapFile}.${process.pid}.tmp`;
    const savedEntries = Object.fromEntries(Object.entries(updated).map(([name, reading]) => [name, {
      reading,
      group: updatedMonitorGroups[name] || "",
    }]));
    await fs.writeFile(temporary, `${JSON.stringify({ groups: updatedGroups, entries: savedEntries }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, readingMapFile);
    config.readingMap = updated;
    config.groupMap = updatedGroups;
    config.monitorGroupMap = updatedMonitorGroups;
    const phrases = [...new Set(Object.values(updated))].flatMap((name) => [
      `警告です。${name}で障害を検知しました。`,
      `復旧です。${name}は正常な状態に戻りました。`,
    ]).concat(batchCachePhrases());
    for (const phrase of phrases) await getOrCreateClip(phrase);
    res.json({ ok: true, entries: structuredReadingEntries(), groups: config.groupMap, cacheStatus: await readingMapCacheStatus(config.readingMap) });
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
    if (slackEnabled) await sendSlackAlert(alert);
    enqueueAlertSpeech(alert);
    res.status(202).json({ accepted: true, batching: true });
  } catch (error) {
    console.error("Alert handling failed", error);
    res.status(502).json({ error: "Alert delivery failed" });
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
connectKumaMonitorSync();

if (discordEnabled) {
  await client.login(process.env.DISCORD_BOT_TOKEN);
} else {
  console.warn("Discord settings are incomplete; /stream mode only");
}
void warmSpeechCache();

function connectKumaMonitorSync() {
  if (!config.kumaSocketUrl || !config.kumaUsername || !config.kumaPassword) return;

  let endpoint;
  try {
    endpoint = new URL(config.kumaSocketUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error("Unsupported protocol");
  } catch {
    kumaSocketStatus = "configuration-error";
    kumaSocketError = "KUMA_SOCKET_URL must be an http(s) URL";
    console.error(kumaSocketError);
    return;
  }

  kumaSocketStatus = "connecting";
  kumaSocket = createSocketClient(endpoint.toString().replace(/\/$/, ""), {
    reconnection: true,
    timeout: 8000,
  });

  kumaSocket.on("connect", () => {
    kumaSocketStatus = "authenticating";
    kumaSocketError = "";
    kumaSocket.emit("login", {
      username: config.kumaUsername,
      password: config.kumaPassword,
    }, (result) => {
      if (!result?.ok) {
        kumaSocketStatus = result?.tokenRequired ? "two-factor-required" : "authentication-error";
        kumaSocketError = result?.tokenRequired
          ? "Uptime Kuma account requires 2FA; use a dedicated account without 2FA for this integration"
          : "Uptime Kuma login failed; check KUMA_USERNAME and KUMA_PASSWORD";
        console.error(kumaSocketError);
        return;
      }

      kumaSocketStatus = "connected";
      kumaSocket.emit("getMonitorList", (response) => {
        if (!response?.ok) {
          kumaSocketStatus = "sync-error";
          kumaSocketError = "Uptime Kuma rejected getMonitorList";
          console.error(kumaSocketError);
        }
      });
    });
  });

  kumaSocket.on("monitorList", (list) => {
    kumaMonitors = new Map(normalizeKumaMonitors(list).map((monitor) => [monitor.id, monitor]));
    kumaMonitorsSyncedAt = new Date().toISOString();
    kumaSocketStatus = "connected";
    kumaSocketError = "";
    console.log(`Uptime Kuma monitor list synchronized: ${kumaMonitors.size} monitors`);
  });

  kumaSocket.on("updateMonitorIntoList", (updates) => {
    for (const monitor of normalizeKumaMonitors(updates)) kumaMonitors.set(monitor.id, monitor);
    kumaMonitorsSyncedAt = new Date().toISOString();
  });

  kumaSocket.on("deleteMonitorFromList", (monitorId) => {
    kumaMonitors.delete(String(monitorId));
    kumaMonitorsSyncedAt = new Date().toISOString();
  });

  kumaSocket.on("disconnect", () => {
    kumaSocketStatus = "disconnected";
  });

  kumaSocket.on("connect_error", (error) => {
    kumaSocketStatus = "connection-error";
    kumaSocketError = "Could not connect to Uptime Kuma Socket.IO";
    console.error(kumaSocketError, error.message);
  });
}

function normalizeKumaMonitors(list) {
  if (!list || typeof list !== "object" || Array.isArray(list)) return [];
  return Object.entries(list)
    .map(([key, value]) => ({
      id: String(value?.id ?? key),
      name: String(value?.name || "").trim(),
      active: value?.active !== false,
      type: String(value?.type || ""),
    }))
    .filter((monitor) => monitor.id && monitor.name && monitor.type !== "group");
}

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
    const structured = saved.entries && typeof saved.entries === "object" && !Array.isArray(saved.entries);
    const entries = structured ? saved.entries : saved;
    const groups = structured && saved.groups && typeof saved.groups === "object" && !Array.isArray(saved.groups)
      ? saved.groups
      : {};
    config.readingMap = {};
    config.monitorGroupMap = {};
    for (const [word, entry] of Object.entries(entries)) {
      if (!word.trim()) continue;
      const reading = typeof entry === "string" ? entry : entry?.reading;
      const group = typeof entry === "object" && entry ? entry.group : "";
      if (typeof reading !== "string" || !reading.trim()) continue;
      config.readingMap[word] = reading.trim();
      if (typeof group === "string" && group.trim()) config.monitorGroupMap[word] = group.trim();
    }
    config.groupMap = Object.fromEntries(Object.entries(groups).filter(([pattern, name]) => {
      if (typeof name !== "string" || !name.trim() || pattern.length > 200) return false;
      try { new RegExp(pattern); return true; } catch { return false; }
    }));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load saved reading map", error);
    config.readingMap = defaultReadingMap;
    config.groupMap = {};
    config.monitorGroupMap = {};
  }
}

function structuredReadingEntries() {
  return Object.fromEntries(Object.entries(config.readingMap).map(([name, reading]) => [name, {
    reading,
    group: config.monitorGroupMap[name] || "",
  }]));
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

async function sendSlackAlert(alert) {
  const down = alert.status === "down";
  const up = alert.status === "up";
  const title = down ? `🚨 障害検知：${alert.name}` : up ? `✅ 復旧：${alert.name}` : "🔊 通知テスト";
  const lines = [
    `*${slackEscape(title)}*`,
    `状態: ${down ? "障害" : up ? "正常" : "テスト"}`,
    `監視方式: ${slackEscape(String(alert.monitor.type || "不明"))}`,
    `対象: ${slackEscape(alert.target)}`,
    `確認時刻: ${slackEscape(alert.time)}`,
  ];
  if (down) lines.push(`原因: ${slackEscape(alert.reason)}`);
  if (up && alert.heartbeat?.ping != null) lines.push(`応答時間: ${Math.round(alert.heartbeat.ping)} ms`);
  if (alert.monitor.description) lines.push(`説明: ${slackEscape(String(alert.monitor.description))}`);

  const response = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack webhook HTTP ${response.status}`);
}

function slackEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  if (alert.status === "up" && alert.heartbeat?.ping != null && Number.isFinite(Number(alert.heartbeat.ping))) {
    segments.push(...pingSpeechSegments(alert.heartbeat.ping, "現在の応答時間は、"));
  }
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

function groupNameFor(monitorName) {
  if (config.monitorGroupMap[monitorName]) return config.monitorGroupMap[monitorName];
  for (const [pattern, groupName] of Object.entries(config.groupMap)) {
    if (new RegExp(pattern).test(String(monitorName))) return groupName;
  }
  return "";
}

function enqueueAlertSpeech(alert) {
  if (alert.status !== "down" && alert.status !== "up") {
    enqueueSpeech(buildSpeech(alert), config.speakerId, buildSpeechSegments(alert), buildAlertDisplay(alert));
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
        enqueueSpeech(buildSpeech(alert), config.speakerId, buildSpeechSegments(alert), buildAlertDisplay(alert));
      }
      continue;
    }
    enqueueSpeech(
      buildBatchSpeech(status, alerts),
      config.speakerId,
      buildBatchSpeechSegments(status, alerts),
      buildBatchDisplay(status, alerts),
    );
    console.log("Batched " + alerts.length + " " + status + " alerts into one announcement");
  }
}

function batchBreakdown(alerts) {
  return batchGroupCounts(alerts).map(({ group, count }) => `${group}、${count}件`);
}

function batchGroupCounts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const room = String(alert.name).match(/-V(\d{3,4})-/)?.[1];
    const group = groupNameFor(alert.name) || (room ? `V${Number(room)}教室` : "教室外の機器");
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "ja"))
    .map(([group, count]) => ({ group, count }));
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
  const details = batchGroupCounts(alerts).flatMap(({ group, count }) => [`${group}、`, `${count}件。`]);
  if (status === "down") {
    return ["警告です。障害を", `${alerts.length}件。`, "検知しました。", ...details, "詳細は監視画面を確認してください。"];
  }
  const latencies = alerts.map((alert) => Number(alert.heartbeat?.ping)).filter((value) => Number.isFinite(value) && value >= 0);
  const segments = ["復旧のお知らせです。", `${alerts.length}件。`, "の復旧を確認しました。", ...details];
  if (latencies.length > 0) {
    const average = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
    segments.push(...pingSpeechSegments(average, "平均応答時間は、"));
  }
  return segments;
}

const pingNumberReadings = {
  digits: ["ぜろ", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"],
  tens: ["", "じゅう", "にじゅう", "さんじゅう", "よんじゅう", "ごじゅう", "ろくじゅう", "ななじゅう", "はちじゅう", "きゅうじゅう"],
  hundreds: ["", "ひゃく", "にひゃく", "さんびゃく", "よんひゃく", "ごひゃく", "ろっぴゃく", "ななひゃく", "はっぴゃく", "きゅうひゃく"],
  thousands: ["", "せん", "にせん", "さんぜん", "よんせん", "ごせん", "ろくせん", "ななせん", "はっせん", "きゅうせん"],
};

function pingSpeechSegments(value, prefix) {
  const number = Math.max(0, Math.min(9999, Math.round(Number(value))));
  let remainder = number;
  const spoken = [];
  for (const [unit, readings] of [[1000, pingNumberReadings.thousands], [100, pingNumberReadings.hundreds], [10, pingNumberReadings.tens]]) {
    const digit = Math.floor(remainder / unit);
    if (digit > 0) spoken.push(readings[digit]);
    remainder %= unit;
  }
  if (remainder > 0) spoken.push(pingNumberReadings.digits[remainder]);
  if (spoken.length === 0) spoken.push(pingNumberReadings.digits[0]);
  return [prefix, ...spoken, "ミリ秒です。"];
}

function pingNumberCachePhrases() {
  return [...new Set([
    "現在の応答時間は、", "平均応答時間は、", "ミリ秒です。",
    ...pingNumberReadings.digits,
    ...pingNumberReadings.tens.slice(1),
    ...pingNumberReadings.hundreds.slice(1),
    ...pingNumberReadings.thousands.slice(1),
  ])];
}

function batchCachePhrases() {
  const groups = new Set([...Object.values(config.groupMap), ...Object.values(config.monitorGroupMap)]);
  for (const name of Object.keys(config.readingMap)) {
    const room = name.match(/-V(\d{3,4})-/)?.[1];
    if (room) groups.add(`V${Number(room)}教室`);
  }
  groups.add("教室外の機器");
  const maxCount = Math.min(30, Math.max(13, kumaMonitors.size, Object.keys(config.readingMap).length));
  const phrases = [
    "警告です。障害を",
    "復旧のお知らせです。",
    "検知しました。",
    "の復旧を確認しました。",
    "詳細は監視画面を確認してください。",
    "平均応答時間は、",
  ];
  for (const group of groups) phrases.push(`${group}、`);
  for (let count = 1; count <= maxCount; count += 1) {
    phrases.push(`${count}件。`);
  }
  return phrases;
}

function buildAlertDisplay(alert) {
  const down = alert.status === "down";
  const up = alert.status === "up";
  if (!down && !up) {
    return { status: alert.status, title: "Uptime Kuma 通知テスト", details: ["音声通知のテスト"] };
  }
  const groupName = groupNameFor(alert.name);
  const details = [];
  if (groupName) details.push(`グループ: ${groupName}`);
  details.push(`対象: ${alert.target}`);
  if (down) details.push(`原因: ${alert.reason}`);
  if (up && alert.heartbeat?.ping != null) {
    details.push(`応答時間: ${Math.round(alert.heartbeat.ping)} ms`);
  }
  details.push(`${down ? "検知" : "復旧"}時刻: ${alert.time}`);
  return {
    status: alert.status,
    title: `${down ? "障害検知" : "復旧"}：${alert.name}`,
    details,
  };
}

function buildBatchDisplay(status, alerts) {
  return {
    status,
    title: `${status === "down" ? "障害" : "復旧"}を${alerts.length}件${status === "down" ? "検知" : "確認"}`,
    details: batchBreakdown(alerts),
  };
}

function enqueueSpeech(text, speakerId = config.speakerId, segments = null, display = null) {
  const queuedBeforeEnqueue = speechQueue.length + generatedAudioQueue.length;
  if (queuedBeforeEnqueue < config.maxQueueSize) queuePressureWarned = false;
  speechQueue.push({ text, speakerId, segments, display });
  const queued = speechQueue.length + generatedAudioQueue.length;
  if (queued >= config.maxQueueSize && !queuePressureWarned) {
    queuePressureWarned = true;
    console.warn(`Speech queue has ${queued} announcements; preserving all alerts`);
  }
  void processSynthesisQueue();
}

async function processSynthesisQueue() {
  if (synthesisActive) return;
  synthesisActive = true;
  try {
    while (speechQueue.length > 0) {
      const { text, speakerId, segments, display } = speechQueue.shift();
      try {
        const startedAt = performance.now();
        let wav;
        let cached = false;
        if (segments) {
          const cacheHits = await Promise.all(segments.map((part) => clipIsCached(part, speakerId)));
          const misses = segments.filter((_part, index) => !cacheHits[index]);
          const clips = await Promise.all(segments.map((part) => getOrCreateClip(part, speakerId)));
          wav = concatenateWavs(clips);
          cached = misses.length === 0;
          if (misses.length > 0) console.warn(`Speech cache misses (${misses.length}): ${misses.join(" | ").slice(0, 240)}`);
        }
        if (!wav) wav = await getOrCreateClip(text, speakerId);
        publishAudio(wav, display);
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

function publishAudio(wav, display = null) {
  const id = String(++audioSequence);
  audioFiles.set(id, wav);
  while (audioFiles.size > 20) audioFiles.delete(audioFiles.keys().next().value);
  const event = JSON.stringify({
    id,
    display,
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
  for (const phrase of batchCachePhrases()) phrases.add(phrase);
  for (const phrase of pingNumberCachePhrases()) phrases.add(phrase);
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
