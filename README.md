# Subagent Job Notifier

Claude Code の subagent 実行ログと Codex CLI のセッションログを、ローカルのブラウザダッシュボードで一覧表示する小さな通知ツールです。

ジョブが完了、停止、エラー状態になったときにブラウザ通知を出せます。Windows ではオプションで OS のトースト通知も使えます。

## Features

- Claude Code subagent の実行状態を監視
- Codex CLI セッションの実行状態を監視
- 任意スクリプトから `POST /api/jobs` でジョブを登録
- ブラウザ通知による完了通知
- Windows トースト通知に対応
- 依存パッケージなし。Node.js だけで起動可能

## Requirements

- Node.js 18 以上
- Windows、macOS、Linux

Windows トースト通知は Windows 環境のみ有効です。ブラウザ通知は対応ブラウザで利用できます。

## Quick Start

```bash
npm start
```

または:

```bash
node server.js
```

起動後、ブラウザで次の URL を開いてください。

```text
http://localhost:45680
```

画面上の通知許可ボタンを押すと、ジョブ完了時にブラウザ通知が表示されます。

## Options

```bash
node server.js --port=45680 --host=127.0.0.1 --hours=24 --stall-min=5 --scan-sec=15
```

| Option | Default | Description |
| --- | --- | --- |
| `--port=45680` | `45680` | HTTP サーバーのポート |
| `--host=127.0.0.1` | `127.0.0.1` | バインドするホスト |
| `--hours=24` | `24` | 何時間前までのジョブを表示するか |
| `--stall-min=5` | `5` | 更新が止まったジョブを stalled 扱いにするまでの分数 |
| `--scan-sec=15` | `15` | ログを再スキャンする間隔 |
| `--toast=off` | `on` | Windows トースト通知を無効化 |
| `--toast-stalled` | off | running から stalled への遷移でもトースト通知を出す |

例:

```bash
node server.js --hours=168 --toast=off
```

## Register External Jobs

自作スクリプトやバッチ処理の進捗も、HTTP API で登録できます。

```bash
curl -X POST http://localhost:45680/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"id":"gen01","name":"image batch","progress":{"done":10,"total":20,"unit":"images"}}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post http://localhost:45680/api/jobs -ContentType 'application/json' `
  -Body (@{
    id = 'gen01'
    name = 'image batch'
    progress = @{ done = 10; total = 20; unit = 'images' }
  } | ConvertTo-Json)
```

完了時:

```bash
curl -X POST http://localhost:45680/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"id":"gen01","status":"complete","message":"finished"}'
```

主なフィールド:

| Field | Description |
| --- | --- |
| `id` | ジョブ ID。同じ ID に再 POST すると更新されます |
| `name` | ダッシュボード上の表示名 |
| `status` | `running`, `complete`, `error` |
| `progress` | `{ "done": 1, "total": 10, "unit": "steps" }` |
| `message` | 最終メッセージ |
| `model` | モデル名 |
| `project` | プロジェクト名またはパス |

登録データは `jobs/<id>.json` に保存されます。`jobs/*.json` は実行時データなので Git 管理対象から除外しています。

## Watched Locations

このツールはローカルファイルだけを読みます。外部サービスへログ内容を送信しません。

- Claude Code projects: `~/.claude/projects`
- Claude Code tasks: `~/.claude/tasks`
- Codex CLI sessions: `~/.codex/sessions`
- External jobs: `./jobs`

## Development

構文チェック:

```bash
npm test
```

このプロジェクトは npm 依存パッケージを使っていません。
