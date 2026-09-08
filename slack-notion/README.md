# Slack → Notion タスク追加

Slackのメッセージの […] メニューからNotionのデータベースを選ぶと、そのメッセージが
データベースのアイテム（タスク）として追加されるSlackアプリです。
Google Apps Script（GAS）のウェブアプリとして動きます。

## できること

- メッセージの […] → 「Notionに追加」でモーダルが開く
- Integrationに共有されているNotionのデータベースから追加先を選ぶ
- 選んだデータベースにページが1件作られる
  - **タイトル列**: メッセージ本文の最初の行（100文字で切り詰め）
  - **URL列**（あれば）: そのメッセージへのSlackリンク
  - **本文**: Slackへのリンク・投稿者・チャンネル・投稿日時＋メッセージ全文の引用
- 追加できたら、実行した本人にだけ見えるメッセージでNotionページのリンクを返す

## 処理の流れ

```
Slack […] メニュー
   │  message_action
   ▼
doPost ── 検証 ──▶ データベース一覧（キャッシュ）──▶ views.open でモーダル表示
   │
   │  view_submission（データベースを選んで「追加」）
   ▼
doPost ── Notion /v1/pages でページ作成 ──▶ response_url で完了通知
```

`trigger_id` は発行から3秒で失効するため、モーダルを開く経路ではNotionを呼ばず、
1時間ごとのトリガーで更新したデータベース一覧のキャッシュだけを読みます。

## セットアップ

### 1. Notion側

1. https://www.notion.so/my-integrations で内部インテグレーションを作る
   - 権限は「コンテンツを読み取る」「コンテンツを挿入する」が必要
2. Internal Integration Token（`ntn_...`）を控える
3. 追加先にしたい**各データベース**のページを開き、`…` → 「接続」から作成した
   インテグレーションを追加する（共有していないデータベースは候補に出ません）

### 2. Apps Script側

`clasp` を使う場合:

```bash
npm install -g @google/clasp
clasp login
cd slack-notion
clasp create --type standalone --title "Slack Notion Task" --rootDir ./src
clasp push
```

手動で作る場合は https://script.google.com で新規プロジェクトを作り、`src/` の
`.gs` ファイルの中身をそれぞれ同じ名前のファイルとして貼り付けてください
（`appsscript.json` はプロジェクト設定の「appsscript.json マニフェスト ファイルを
エディタで表示する」を有効にすると編集できます）。

### 3. スクリプトプロパティ

エディタの「プロジェクトの設定」→「スクリプト プロパティ」で設定します。

| キー | 必須 | 内容 |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | ✅ | Slackアプリの Bot User OAuth Token（`xoxb-...`） |
| `SLACK_VERIFICATION_TOKEN` | ✅ | Slackアプリの Basic Information → Verification Token |
| `NOTION_TOKEN` | ✅ | Notion の Internal Integration Token（`ntn_...`） |
| `WEBHOOK_SECRET` | 推奨 | 任意の合言葉。Request URL に `?s=<合言葉>` として付ける |
| `NOTION_DATABASE_ALLOWLIST` | 任意 | 候補に出すデータベースIDをカンマ区切りで指定 |
| `NOTION_URL_PROPERTY` | 任意 | SlackリンクをNotionのどのURL列に入れるか（列名） |
| `NOTION_VERSION` | 任意 | Notion APIのバージョン（既定 `2022-06-28`） |

`NOTION_URL_PROPERTY` を指定しない場合は、名前に `slack` / `link` / `url` / `リンク`
を含むURL型の列を自動で使います。該当する列がなければURLは書き込みません。

### 4. ウェブアプリとしてデプロイ

「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」

- 次のユーザーとして実行: **自分**
- アクセスできるユーザー: **全員**

発行された `https://script.google.com/macros/s/.../exec` を控えます。
`WEBHOOK_SECRET` を設定した場合は末尾に `?s=<合言葉>` を付けたものがRequest URLです。

> コードを直したら「デプロイを管理」→ 鉛筆アイコン →「バージョン: 新バージョン」→
> 「デプロイ」まで行わないと `/exec` には反映されません。

### 5. Slackアプリ

1. https://api.slack.com/apps → 「Create New App」→「From an app manifest」
2. `slack-app-manifest.json` を貼り付ける
3. `settings.interactivity.request_url` を4で控えたURLに書き換える
4. 「Install to Workspace」でインストールし、Bot User OAuth Token を控える
5. Basic Information の Verification Token を控える
6. 3と5で控えた値をスクリプトプロパティに設定する

### 6. データベース一覧の取り込み

Apps Scriptエディタで `installDatabaseRefreshTrigger` を1回実行します。
1時間ごとにデータベース一覧を取り直すトリガーが作られ、その場で初回の取得も走ります。

## 使い方

Slackのメッセージにマウスを乗せる → […] →「Notionに追加」
（初回は「その他のメッセージ ショートカット」の中にあります）。
モーダルで追加先のデータベースを選び、「追加」を押すと作成されます。

## 手で実行できる関数

| 関数 | 用途 |
| --- | --- |
| `showSetupStatus` | どのプロパティが設定済みかを確認する（値は伏せて表示） |
| `refreshDatabaseCache` | データベース一覧を取り直し、内容をログに出す |
| `installDatabaseRefreshTrigger` | 1時間ごとの更新トリガーを作る |
| `clearCaches` | キャッシュを捨てる（データベースを共有した直後の確認用） |

## 既知の制約（Apps Scriptを選んだことによるもの）

- **署名検証ができない**
  Apps Script の `doPost` はリクエストヘッダーを読めないため、Slack推奨の
  `X-Slack-Signature` による検証ができません。代わりに、ペイロードに含まれる
  Verification Token（Slackでは非推奨扱い）と、Request URLに付けた `WEBHOOK_SECRET`
  の2つで照合しています。URLと合言葉が漏れない限りは第三者からの投入を防げますが、
  厳密な署名検証が要件になる場合はGAS以外の実行環境が必要です。
- **ウェブアプリのレスポンスは302リダイレクトを挟む**
  Apps Script は `/exec` へのPOSTに対して `googleusercontent.com` へのリダイレクトを
  返します。Slackはこれを追跡するため通常は問題になりませんが、画面の描画は
  レスポンス本文ではなく `views.open` API で行う作りにして、影響を受けにくくしています。
- **3秒制限とコールドスタート**
  Slackは `trigger_id` を3秒で失効させます。データベース一覧をキャッシュから読む設計に
  していますが、久しぶりの実行でGASの起動が遅いと稀に間に合わずモーダルが開かないこと
  があります。その場合はもう一度 […] から実行してください（2回目以降は速くなります）。
- **選択肢は100件まで**
  Slackのセレクトの上限です。それを超える場合は最近更新された100件を出します。
  `NOTION_DATABASE_ALLOWLIST` で絞り込めます。

## テスト

```bash
npm run test:slack-notion
```

`tests/slack-notion.test.mjs` が `src/*.gs` をNode上のVMに読み込み、GASのサービス
（`UrlFetchApp` など）を差し替えて、検証・モーダル生成・Notionへのリクエスト内容・
エラー処理を確認します。実際のSlack/Notionには接続しません。

## うまく動かないとき

| 症状 | 確認すること |
| --- | --- |
| ショートカットを押しても何も起きない | Apps Scriptの「実行数」ログにエラーが出ていないか。Request URLとデプロイ済みバージョンが最新か |
| 「追加先がありません」と出る | Notion側で各データベースをIntegrationに共有したか。`refreshDatabaseCache` を実行してログを見る |
| 追加したデータベースが候補に出ない | 一覧は1時間キャッシュ。`clearCaches` か `refreshDatabaseCache` を実行する |
| 「Notionへの追加に失敗しました」 | メッセージに出るNotionのエラー文を確認。必須の列がある（未入力を許さない）データベースは追加できません |
| 何も起きずログに「Verification Token が一致しません」 | `SLACK_VERIFICATION_TOKEN` がSlackアプリの値と一致しているか |
