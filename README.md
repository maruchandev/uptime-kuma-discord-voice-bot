# Uptime Kuma Discord Voice Alerts

Uptime Kuma の Webhook 通知を VOICEVOX で音声化し、Discord のボイスチャンネルへ読み上げるセルフホスト用サービスです。ブラウザー用の `/Stream` ページ、読み上げ辞書、CSV インポートにも対応しています。

## Features

- Discord ボイスチャンネルへの障害・復旧通知の読み上げ
- 任意でDiscordテキストチャンネルへEmbed通知
- VOICEVOX EngineをDocker Composeで起動
- `/Stream` ページで通知の確認、ブラウザー再生、読み上げ辞書の編集
- 監視名ごとの発音を保存し、障害・復旧フレーズを事前生成
- 読み上げ辞書のCSVインポート
- Webhookトークンによる通知リクエストの認証

## How it works

```text
Uptime Kuma -- Webhook --> Bot -- VOICEVOX --> generated speech
                               |                    |
                               +--> Discord VC <----+
                               +--> /Stream browser
```

Uptime Kuma は監視の状態、監視名、エラー情報、時刻をWebhookで送信します。Botは名前を読み上げ辞書で変換し、保存済み音声部品を組み立てて読み上げます。音声キャッシュと辞書はDockerの名前付きボリュームに保存されます。

## Requirements

- Docker Engine と Docker Compose v2
- 稼働中の Uptime Kuma
- DiscordアプリケーションとBot（ボイスチャンネルへ接続する場合）

## Setup

1. このリポジトリを取得し、設定ファイルを作ります。

   ```sh
   git clone https://github.com/maruchandev/uptime-kuma-discord-voice-bot.git
   cd uptime-kuma-discord-voice-bot
   cp .env.example .env
   ```

2. `.env` を編集します。最低限 `WEBHOOK_TOKEN` を長くランダムな値に設定してください。Discordのボイス読み上げを使う場合は `DISCORD_BOT_TOKEN` と `DISCORD_VOICE_CHANNEL_ID` も設定します。サーバーIDはボイスチャンネルから自動判定されます。テキストチャンネルへの通知が不要なら `DISCORD_TEXT_CHANNEL_ID` は空欄のままにします。

3. BotをDiscordサーバーへ招待し、対象チャンネルで `View Channel`、`Connect`、`Speak` を許可します。テキスト通知を使う場合は `Send Messages` と `Embed Links` も許可してください。Botは `GuildVoiceStates` Gateway intentを使用し、Message Content intentは使用しません。

4. Kumaとこのサービスが共有するDockerネットワークを用意します。ネットワーク名は `.env` の `KUMA_DOCKER_NETWORK` と一致させてください。

   ```sh
   docker network inspect uptime-kuma-tts >/dev/null 2>&1 || docker network create uptime-kuma-tts
   docker network connect uptime-kuma-tts <uptime-kuma-container-name>
   ```

   Kumaコンテナがすでにそのネットワークに接続されている場合、`docker network connect` は不要です。

5. 起動します。

   ```sh
   docker compose up -d --build
   ```

## Uptime Kuma notification

Uptime Kumaで `Webhook` 通知先を追加し、監視対象に割り当てます。

- URL: `http://discord-tts-bot:3000/alert`
- Method: `POST`
- Body: `application/json`（Uptime Kumaの標準Webhook形式）
- Additional Headers:

  ```json
  {
    "x-webhook-token": "<WEBHOOK_TOKENと同じ値>"
  }
  ```

Botは標準Webhookの `monitor`、`heartbeat`、`msg` フィールドを読み取ります。

## Stream page and pronunciation dictionary

既定ではStream UIをホストの `127.0.0.1:3100` にだけ公開します。

- Local: `http://localhost:3100/Stream`
- Health: `http://localhost:3100/health`

LAN上のブラウザーから開きたい場合は `.env` の `STREAM_BIND_ADDRESS` を `0.0.0.0` にし、ファイアウォールで信頼できるLANからのアクセスだけを許可してください。Stream UIの辞書APIはローカル運用を想定し、Webhookトークン認証を行いません。インターネットへ直接公開しないでください。

辞書の左列にはUptime Kuma上の監視名、右列には読み上げたい表記を登録します。保存すると、その読みの障害・復旧用音声が事前生成されます。CSVは `monitor_name,reading` または `監視名,読み方` の列名に対応しています。

```csv
monitor_name,reading
router-01,ルーター ゼロワン
```

CSVを読み込んだ後、内容を確認して「変更を保存」を押してください。

## Configuration

主要な環境変数は `.env.example` を参照してください。

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Bot token |
| `DISCORD_VOICE_CHANNEL_ID` | 読み上げ先ボイスチャンネル |
| `DISCORD_TEXT_CHANNEL_ID` | 任意のEmbed通知先テキストチャンネル |
| `WEBHOOK_TOKEN` | Uptime Kumaからの通知を認証する秘密値 |
| `KUMA_DOCKER_NETWORK` | Kumaと共有するDockerネットワーク名 |
| `STREAM_BIND_ADDRESS` | Stream UIのホスト側バインドアドレス（既定 `127.0.0.1`） |
| `STREAM_PORT` | Stream UIのホスト側ポート（既定 `3100`） |
| `VOICEVOX_SPEAKER_ID` | VOICEVOX speaker/style ID（既定 `3`） |
| `VOICEVOX_SPEED_SCALE` | 読み上げ速度 |
| `TIMEZONE` | 通知時刻の表示タイムゾーン |
| `READING_MAP_JSON` | 任意の初期読み上げ辞書JSON。Web UIからも編集可能 |

## Maintenance

```sh
docker compose logs -f discord-tts-bot
docker compose ps
docker compose down
```

`docker compose down -v` は音声キャッシュと辞書も削除するため、通常の停止では使わないでください。

## Voice attribution

既定のspeaker IDはVOICEVOX Engineのstyle ID `3` です。使用する音声ライブラリの利用規約・クレジット要件を確認し、それに従ってください。VOICEVOX Engineおよび音声ライブラリはこのプロジェクトに同梱されていません。

## License

このプロジェクトは [MIT License](LICENSE) の下で公開されています。VOICEVOX Engineおよび音声ライブラリには、それぞれ別の利用条件が適用されます。
