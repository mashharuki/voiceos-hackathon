# Voice Poker

> Voice OS Hackathon Tokyo — 音声で操作するテキサスホールデムポーカー

## プロダクト概要

**Voice Poker** は、音声コマンドでプレイできるテキサスホールデムポーカーゲームです。
MCP (Model Context Protocol) を通じて Voice OS と接続し、「フォールド」「コールして」「100ドルレイズ」と話すだけでゲームが進行します。

画面はChat GPTのGPT APP風の2ペインレイアウトで、左側にVoice OS、右側にリアルタイムのポーカーテーブルが表示されます。

```
┌──────────────────────┬──────────────────────────┐
│   Voice OS Panel     │    Poker Game Panel       │
│                      │                           │
│  [音声波形]          │  [コミュニティカード]     │
│  [会話ログ]          │  [プレイヤーハンド]       │
│  [マイクボタン]      │  [Fold / Call / Raise]    │
└──────────────────────┴──────────────────────────┘
```

## 機能一覧

| 機能 | 説明 |
|------|------|
| 音声操作 | Web Speech API でマイク入力 → ゲームアクションに変換 |
| MCP連携 | `poker_new_game` / `poker_deal` / `poker_action` / `poker_get_state` の4ツール |
| リアルタイム同期 | 2秒ポーリングで画面を自動更新（MCP操作も即反映） |
| カードアニメーション | 3D flip アニメーションでカードが配られる |
| 音声波形ビジュアライザー | Canvas APIによるリアルタイム波形表示 |
| ゲーム状態永続化 | Supabase にゲームステートを保存（インメモリフォールバック付き） |
| クイックアクション | 音声が使えない環境向けのボタン操作 |

## MCP Tools

Voice OS (またはClaude Desktop) から以下のツールを呼び出せます。

| ツール | 説明 | 例 |
|--------|------|-----|
| `poker_new_game` | 新しいゲームを開始。デッキをシャッフルし2枚配る | 「新しいゲームを始めて」 |
| `poker_get_state` | 現在のゲーム状態を取得 | 「今の手札を見せて」 |
| `poker_deal` | フロップ/ターン/リバーを公開 | 「フロップを出して」 |
| `poker_action` | fold / call / raise を実行 | 「100ドルレイズして」 |

## アーキテクチャ

```
voiceos-hackathon/
├── packages/
│   ├── mcp-server/          # TypeScript MCP Server (stdio transport)
│   │   └── src/index.ts     # 4ツールの実装 + Supabase連携
│   └── backend/             # Hono Web Server
│       ├── src/index.ts     # REST API + Supabase
│       └── src/public/      # フロントエンド HTML
├── package.json             # pnpm workspace ルート
├── pnpm-workspace.yaml
├── biome.json               # Biome (lint / format)
└── mcp-config.json          # Claude Desktop 登録用設定
```

**Tech Stack:**
- Runtime: Node.js 20 + TypeScript
- Web Framework: [Hono](https://hono.dev/) (超軽量・型安全)
- MCP: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- DB: [Supabase](https://supabase.com/) (fallback: in-memory Map)
- Lint: [Biome](https://biomejs.dev/)
- Package Manager: pnpm (monorepo)

## セットアップ

### 前提条件

- Node.js 20+
- pnpm
- Supabase アカウント（任意。なくてもインメモリで動作します）

### 1. 依存パッケージのインストール

```bash
pnpm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して Supabase の接続情報を入力します。

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
PORT=3000
```

> Supabase を使わない場合はそのままでOKです。ゲーム状態はメモリに保存されます。

### 3. Supabase テーブル作成（Supabase使用時のみ）

Supabase の SQL Editor で以下を実行します。

```sql
create table games (
  id uuid primary key default gen_random_uuid(),
  session_id text unique not null,
  state jsonb not null,
  updated_at timestamptz default now()
);
```

### 4. ビルド

```bash
pnpm build
```

## 動かし方

### バックエンドを起動する

```bash
pnpm dev:backend
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開くとポーカー画面が表示されます。

### MCP Server を Claude Desktop に登録する

`mcp-config.json` の内容を Claude Desktop の設定ファイル (`claude_desktop_config.json`) に追加します。

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "voice-poker": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/voiceos-hackathon/packages/mcp-server/src/index.ts"
      ],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_ANON_KEY": "your-anon-key"
      }
    }
  }
}
```

Claude Desktop を再起動すると `poker_*` ツールが使えるようになります。

### 音声でゲームをプレイする

マイクボタンをタップして話しかけます。

```
「新しいゲームを始めて」  → poker_new_game
「フロップを出して」      → poker_deal
「コールして」            → poker_action (call)
「100ドルレイズ」         → poker_action (raise, 100)
「フォールド」            → poker_action (fold)
「今の状態を見せて」      → poker_get_state
```

### 5. MCPサーバー起動方法

```bash
# ルートから（推奨）
pnpm start:mcp

# mcp-server パッケージから直接
pnpm --filter mcp-server start:tsx

# npx を使う場合
npx tsx packages/mcp-server/src/index.ts
```

## 開発コマンド

```bash
pnpm build          # 全パッケージをビルド
pnpm dev:backend    # バックエンドをwatchモードで起動
pnpm dev:mcp        # MCPサーバーをwatchモードで起動
pnpm lint           # Biomeでlint
pnpm format         # Biomeでフォーマット
```

## Pitch
[Pitch](https://docs.google.com/presentation/d/1pifY0a3JGVr7YGyqkaNgqc6kiF9p6GVt/edit?usp=drive_link&ouid=116558815912869106200&rtpof=true&sd=true)

## 参考文献

- [VoiceOS Hackathon Tokyo](https://luma.com/diz9rauq?tk=ux7mMF)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Hono](https://hono.dev/)
- [Supabase](https://supabase.com/)
