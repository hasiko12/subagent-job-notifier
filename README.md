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

## Prompting Other Agentic AIs to Report Here

Claude Code の subagent と Codex CLI はログファイルを自動検出しますが、それ以外の強力なエージェント型 AI(Fable 5、GPT-5.6 など、自分でサブエージェントやバックグラウンドジョブを呼び出せるモデル)を使っている場合は、そのAI自身に `POST /api/jobs` を叩かせる必要があります。

以下のプロンプトを、そのAIのシステムプロンプト・`AGENTS.md`・`CLAUDE.md` などの常時読み込まれる指示に貼り付けてください。以後、そのAIが重い処理を委任するたびに、このダッシュボードへ自動で状況を報告するようになります。

Claude Codeのような自律性が高いAIの場合、チャット欄のプロンプト命令だけで使用してくれる場合も多いですが、
以下の手順ではあらゆるAIで成功率が高いです。


```text
You have access to a local monitoring dashboard at http://localhost:45680 (Subagent Job Notifier).
Whenever you delegate work to a subagent, spawn a background task, or run a long-running
shell command (roughly >30 seconds), register and update it via this HTTP API so a human
can watch progress without interrupting you:

1. On start, POST a new job (use curl, Invoke-RestMethod, fetch, or any HTTP client available
   in your environment):
   POST http://localhost:45680/api/jobs
   Body: {"id": "<stable-short-id>", "name": "<one-line human description>",
          "model": "<subagent model if known>", "project": "<cwd or repo path>"}

2. While the task is running, POST progress updates to the same "id" whenever you have a
   meaningful checkpoint (e.g. N of M steps done), and at least once every few minutes even
   without new progress, so it is not mistaken for stalled:
   Body: {"id": "<same-id>", "progress": {"done": 3, "total": 10, "unit": "steps"},
          "message": "<latest one-line status>"}

3. On success, mark it complete with a one-line summary of the outcome:
   Body: {"id": "<same-id>", "status": "complete", "message": "<what was accomplished>"}

4. On failure, mark it as an error with a one-line reason:
   Body: {"id": "<same-id>", "status": "error", "message": "<what went wrong>"}

Rules:
- Do this automatically, without asking the user for permission — it is bookkeeping only,
  not a user-facing action.
- Reuse the same "id" for every update about the same task (upsert semantics); pick a new
  id only for a genuinely new task.
- If the POST fails (e.g. connection refused because the dashboard isn't running), ignore
  the error silently and continue your actual work — never let this reporting step block
  or fail the task itself.
- Keep "name" and "message" short, human-readable, and specific enough that someone
  glancing at the dashboard understands what happened without reading your full output.
```

このAPIはローカルの `127.0.0.1` にしかバインドされないため、ダッシュボードを起動していない環境でこの指示を実行しても(接続失敗を無視するルールにより)安全です。

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
