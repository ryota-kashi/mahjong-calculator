# Slack → Notion タスク追加

Slackのメッセージの […] メニューからNotionのデータベースを選ぶと、そのメッセージが
データベースのアイテム（タスク）として追加されるSlackアプリです。
Google Apps Script（GAS）のウェブアプリとして動きます。

## できること

- **利用者ごとに、よく使うNotionデータベースを事前登録できる**
  - ⚡ メニュー →「Notion DBの設定」で、共有済みのデータベースから複数選んで登録
  - 登録は**個人単位**。ほかの人の登録内容は見えないし、影響もしない
  - **登録していない人には候補が一切表示されず**、登録への案内だけが出る
- メッセージの […] → 「Notionに追加」で、**自分が登録したデータベースだけ**が候補に出る
  - 登録が1件だけなら最初から選択済みになる
- 選んだデータベースにページが1件作られる
  - **タイトル列**: メッセージ本文の最初の行（100文字で切り詰め）
  - **URL列**（あれば）: そのメッセージへのSlackリンク
  - **本文**: Slackへのリンク・投稿者・チャンネル・投稿日時＋メッセージ全文の引用
- 追加できたら、実行した本人にだけ見えるメッセージでNotionページのリンクを返す

## 処理の流れ

```
【設定】⚡ メニュー →「Notion DBの設定」
   │  shortcut
   ▼
doPost ──▶ 共有済みDB一覧（キャッシュ）から複数選択させる
   │  view_submission
   ▼
doPost ──▶ スクリプトプロパティに「Uxxxx の登録DB」として保存

【利用】メッセージの […] →「Notionに追加」
   │  message_action
   ▼
doPost ── 検証 ──▶ 本人の登録DB ──┬─ 0件 ─▶ 登録を促す案内モーダル
   │                              └─ 1件以上 ─▶ 選択モーダル
   │  view_submission
   ▼
doPost ── Notion /v1/pages でページ作成 ──▶ response_url で完了通知
```

`trigger_id` は発行から3秒で失効するため、モーダルを開く経路ではNotionを呼ばず、
1時間ごとのトリガーで更新したデータベース一覧のキャッシュだけを読みます。
利用者ごとの登録内容も、リクエストの最初に1回だけ読むスクリプトプロパティから引きます。

## 登録データの持ち方

スクリプトプロパティに `USER_DATABASES_<SlackユーザーID>` というキーで
`{"ids": ["<データベースID>", ...], "updatedAt": "..."}` を保存します。
Notion側で共有が外されたデータベースは、候補にも設定画面の初期選択にも出なくなります
（登録を消し回る必要はありません）。

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
| `NOTION_DATABASE_ALLOWLIST` | 任意 | **登録できる**データベースIDをカンマ区切りで指定（管理者が範囲を絞る用） |
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

### 7. 利用者に登録してもらう

管理者側の作業はここまでです。あとは各利用者が ⚡ メニュー →「Notion DBの設定」から
自分の使うデータベースを登録します（次の「使い方」を参照）。

## 使い方

### 1. 追加先を登録する（利用者が各自で1回だけ）

メッセージ入力欄の ⚡（またはプラス）メニュー →「Notion DBの設定」→
よく使うデータベースを選んで「保存」。

未登録のままメッセージの […] から使おうとした場合も、案内モーダルの
「データベースを登録」ボタンからその場で登録できます。

### 2. メッセージをタスクにする

Slackのメッセージにマウスを乗せる → […] →「Notionに追加」
（初回は「その他のメッセージ ショートカット」の中にあります）。
自分が登録したデータベースが候補に出るので、選んで「追加」。

登録内容はいつでも ⚡ メニュー →「Notion DBの設定」から変更できます。
すべての選択を外して保存すると登録解除になり、候補は表示されなくなります。

## 手で実行できる関数

| 関数 | 用途 |
| --- | --- |
| `showSetupStatus` | どのプロパティが設定済みかを確認する（値は伏せて表示） |
| `refreshDatabaseCache` | データベース一覧を取り直し、内容をログに出す |
| `installDatabaseRefreshTrigger` | 1時間ごとの更新トリガーを作る |
| `listUserRegistrations` | 誰がどのデータベースを登録しているか一覧する |
| `deleteUserRegistration` | 指定した利用者の登録を消す（退職者の整理など） |
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
- **… メニューの項目自体は全員に見える**
  Slackの仕様上、メッセージショートカットを利用者ごとに出し分けることはできません。
  そのため「使っていない人に見せない」は、押した後の挙動で実現しています。
  未登録の人には候補を一切出さず（ほかの人の登録内容も見えません）、
  登録への案内だけを表示します。
- **登録できるのは100件まで**
  Slackのセレクトの上限です。共有済みのデータベースがそれを超える場合、
  設定画面には最近更新された100件を出します。`NOTION_DATABASE_ALLOWLIST` で
  登録できる範囲を管理者が絞れます。
- **スクリプトプロパティの容量**
  登録内容は1利用者につき1プロパティ（上限9KB／全体500KB）です。
  100件登録しても4KB程度なので通常は問題になりませんが、
  数百人規模で使う場合は全体の上限に注意してください。

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
| 「追加先が未登録です」と出る | ⚡ メニュー →「Notion DBの設定」から登録する（利用者ごとの登録が必要です） |
| 設定画面に「選べるDBがありません」と出る | Notion側で各データベースをIntegrationに共有したか。`refreshDatabaseCache` を実行してログを見る |
| 共有したデータベースが設定画面に出ない | 一覧は1時間キャッシュ。`clearCaches` か `refreshDatabaseCache` を実行する。タイトル列のないデータベースは候補になりません |
| 登録したはずのDBが候補から消えた | Notion側で共有が外れていないか。設定画面を開くと現状の候補が確認できます |
| 「Notionへの追加に失敗しました」 | メッセージに出るNotionのエラー文を確認。必須の列がある（未入力を許さない）データベースは追加できません |
| 何も起きずログに「Verification Token が一致しません」 | `SLACK_VERIFICATION_TOKEN` がSlackアプリの値と一致しているか |
