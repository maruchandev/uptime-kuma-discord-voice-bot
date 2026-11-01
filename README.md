# Uptime Kuma Slack and Discord Voice Alerts

Uptime Kuma の Webhook 通知を Slack へ送り、必要に応じて VOICEVOX で音声化して Discord のボイスチャンネルへ読み上げるセルフホスト用サービスです。ブラウザー用の `/Stream` ページとJSON形式の読み上げ辞書に対応しています。

## Features

- Discord ボイスチャンネルへの障害・復旧通知の読み上げ
- 任意でDiscordテキストチャンネルへEmbed通知
- 任意でSlackチャンネルへ通知（Slack Incoming Webhook）
- VOICEVOX EngineをDocker Composeで起動
- `/Stream` ページで通知の確認、ブラウザー再生、読み上げ辞書の編集
- 監視名ごとの発音を保存し、障害・復旧フレーズを事前生成
- 読み上げ辞書のJSON編集・読み込み・ダウンロード
- Webhookトークンによる通知リクエストの認証
- 短時間に届いた障害・復旧通知の一括読み上げ
- ブラウザー再生の通知キューイング

## How it works

```text
Uptime Kuma -- Webhook --> Bot -- VOICEVOX --> generated speech
                               |                    |
                               +--> Discord VC <----+
                               +--> Slack channel
                               +--> /Stream browser
```

Uptime Kuma は監視の状態、監視名、エラー情報、時刻をWebhookで送信します。Botは名前を読み上げ辞書で変換し、キャッシュした音声部品を組み立てて読み上げます。辞書と音声キャッシュはDockerの名前付きボリュームに保存されます。

## Requirements

- Docker Engine と Docker Compose v2
- 稼働中の Uptime Kuma
- DiscordアプリケーションとBot（ボイスチャンネルへ接続する場合）
- Slack Incoming Webhook（Slackへ通知する場合）

## Setup

1. このリポジトリを取得し、設定ファイルを作ります。

   ```sh
   git clone https://github.com/maruchandev/uptime-kuma-discord-voice-bot.git uptime-kuma-slack-bot
   cd uptime-kuma-slack-bot
   cp .env.example .env
   ```

2. `.env` を編集します。最低限 `WEBHOOK_TOKEN` を長くランダムな値に設定してください。Slackへ通知する場合はSlackでIncoming Webhookを作成し、`SLACK_WEBHOOK_URL` に設定します。Discordのボイス読み上げを使う場合は `DISCORD_BOT_TOKEN` と `DISCORD_VOICE_CHANNEL_ID` も設定します。サーバーIDはボイスチャンネルから自動判定されます。テキストチャンネルへの通知が不要なら `DISCORD_TEXT_CHANNEL_ID` は空欄のままにします。

3. Discordの音声・テキスト通知を使う場合はBotをDiscordサーバーへ招待し、対象チャンネルの権限を設定します。Slack通知だけを使う場合、この手順は不要です。

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

- URL: `http://kuma-slack-tts-bot:3000/alert`
- Method: `POST`
- Body: `application/json`（Uptime Kumaの標準Webhook形式）
- Additional Headers:

  ```json
  {
    "x-webhook-token": "<WEBHOOK_TOKENと同じ値>"
  }
  ```

Botは標準Webhookの `monitor`、`heartbeat`、`msg` フィールドを読み取ります。

## Alert batching

障害・復旧通知は短い時間窓に集め、同じ状態の通知がしきい値以上あれば一つの音声にまとめます。同じ監視対象の状態が時間窓内に複数回変わった場合は、最後の状態を使います。障害と復旧は別々にまとめ、しきい値に達しない通知は個別に読み上げます。Discordのテキスト通知はすぐに個別送信されます。

一括通知はグループ名ごとに件数を読み上げます。対象ごとにグループ名を設定できます。未設定の場合は、監視名の `-V123-` 形式から教室番号をまとめます。復旧通知では対象ごとの応答時間を読み上げ、一括復旧では平均応答時間も読み上げます。PINGの数値はキャッシュ済みの日本語の位読み音声を組み立てます。再生中の音声は中断せず、要約は通常の再生キューに入ります。

時間窓としきい値は `.env` の `ALERT_BATCH_WINDOW_SECONDS`（既定5秒）と `ALERT_BATCH_THRESHOLD`（既定3件）で変更できます。
`MAX_QUEUE_SIZE`（既定30）はキュー混雑の警告基準です。到着した通知はキュー上限で破棄しません。

## Stream page and pronunciation dictionary

既定ではStream UIをホストの `127.0.0.1:3100` にだけ公開します。

- Operations: `http://localhost:3100/stream`
- Pronunciation dictionary: `http://localhost:3100/stream/dictionary`
- Health: `http://localhost:3100/health`

LAN上のブラウザーから開きたい場合は `.env` の `STREAM_BIND_ADDRESS` を `0.0.0.0` にし、ファイアウォールで信頼できるLANからのアクセスだけを許可してください。Stream UIの辞書APIはローカル運用を想定し、Webhookトークン認証を行いません。インターネットへ直接公開しないでください。

Streamは運用画面と読み上げ辞書の管理画面に分かれています。運用画面には通知状態、再生状態、直近の通知履歴だけを表示します。辞書の編集・同期・試聴は `/stream/dictionary` で行います。運用画面の通知欄には監視名、対象、原因、時刻を表示し、VOICEVOX向けの読み上げ文は音声合成にだけ使います。

ブラウザー音声は SSE で通知を受け取り、HTTP WAV をダウンロードして順番に再生します。ブラウザー側で再生を有効にしたあと、切断時は EventSource が自動で再接続します。

辞書JSONは `groups` と `entries` で管理します。`entries` は監視名をキーにし、各値に `reading`（読み上げる表記）と `group`（対象のグループ名）を設定します。`group` は画面表示と一括通知の集約に使います。`groups` は任意で、監視名に適用するJavaScript正規表現をキー、既定のグループ名を値にします。正規表現ルールはJSON内の記載順で評価し、監視対象ごとの `group` が優先されます。`/stream/dictionary` のJSON欄で直接編集し、「JSONを保存」を押すと障害・復旧用音声を準備します。以前の「監視名: 読み」形式も読み込めます。

```json
{
  "groups": {
    "^CK-.*-V101-": "第101教室"
  },
  "entries": {
    "CK-AP-V001-1": {
      "reading": "アクセスポイント ブイゼロゼロイチ いち",
      "group": "教室１０１"
    }
  }
}
```

Uptime Kumaの全監視対象一覧を同期する場合は、`.env` に `KUMA_SOCKET_URL`、`KUMA_USERNAME`、`KUMA_PASSWORD` を設定し、Stream画面の「監視対象を同期」を押してください。BotはSocket.IOの一覧・追加・削除イベントを受け取り、画面上で未登録名だけを読み方の候補として追加します。候補は監視名を初期読みとして表示するため、読み方を確認して保存してください。保存時に障害・復旧音声キャッシュを生成します。監視対象が削除されても辞書から自動削除しません。

この同期はUptime Kuma 2.5.5で確認した内部Socket.IO APIを使います。Uptime Kuma側の変更で動かなくなる可能性があります。同期専用のアカウントを使い、2段階認証を無効にしてください（このクライアントは2FAログインに対応しません）。パスワードはBotの `.env` にだけ保存し、Stream画面やAPI応答には返しません。同期が不要なら3つの設定を空欄にできます。

旧形式の辞書ファイルも読み込めます。

```json
{
  "router-01": "ルーター ゼロワン"
}
```

JSONファイルを読み込んだ後、内容を確認して「JSONを保存」を押してください。

## Configuration

主要な環境変数は `.env.example` を参照してください。

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Bot token |
| `DISCORD_VOICE_CHANNEL_ID` | 読み上げ先ボイスチャンネル |
| `DISCORD_TEXT_CHANNEL_ID` | 任意のEmbed通知先テキストチャンネル |
| `SLACK_WEBHOOK_URL` | 任意のSlack Incoming Webhook URL。Discord設定なしでもSlack通知を有効化 |
| `WEBHOOK_TOKEN` | Uptime Kumaからの通知を認証する秘密値 |
| `KUMA_DOCKER_NETWORK` | Kumaと共有するDockerネットワーク名 |
| `KUMA_SOCKET_URL` | 監視一覧同期用のUptime Kuma URL（任意） |
| `KUMA_USERNAME` / `KUMA_PASSWORD` | 監視一覧同期用アカウント（任意） |
| `STREAM_BIND_ADDRESS` | Stream UIのホスト側バインドアドレス（既定 `127.0.0.1`） |
| `STREAM_PORT` | Stream UIのホスト側ポート（既定 `3100`） |
| `VOICEVOX_SPEAKER_ID` | VOICEVOX speaker/style ID（既定 `3`） |
| `VOICEVOX_SPEED_SCALE` | 読み上げ速度 |
| `TIMEZONE` | 通知時刻の表示タイムゾーン |
| `READING_MAP_JSON` | 任意の初期読み上げ辞書JSON。Web UIからも編集可能 |

## Maintenance

```sh
docker compose logs -f kuma-slack-tts-bot
docker compose ps
docker compose down
```

`docker compose down -v` は音声キャッシュと辞書も削除するため、通常の停止では使わないでください。

## Voice attribution

既定のspeaker IDはVOICEVOX Engineのstyle ID `3` です。使用する音声ライブラリの利用規約・クレジット要件を確認し、それに従ってください。VOICEVOX Engineおよび音声ライブラリはこのプロジェクトに同梱されていません。

## License

このプロジェクトは [MIT License](LICENSE) の下で公開されています。VOICEVOX Engineおよび音声ライブラリには、それぞれ別の利用条件が適用されます。
