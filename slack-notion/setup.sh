#!/usr/bin/env bash
# GASプロジェクトの作成とコードの反映までを自動でやる。
# Googleへのログインだけは本人の操作が必要なので、その部分は途中で止まって案内する。
#
# 使い方: bash slack-notion/setup.sh
set -euo pipefail
cd "$(dirname "$0")"

CLASP="npx --yes @google/clasp@2.4.2"

echo "==> 1/4 Apps Script API の確認"
echo "    まだなら https://script.google.com/home/usersettings で"
echo "    「Google Apps Script API」をオンにしてください（1回だけ）。"
echo ""

if [ ! -f "$HOME/.clasprc.json" ]; then
  echo "==> 2/4 Googleにログインします（ブラウザが開きます）"
  $CLASP login
else
  echo "==> 2/4 ログイン済みです"
fi

if [ -f ".clasp.json" ]; then
  echo "==> 3/4 既存のプロジェクトを使います（.clasp.json あり）"
else
  echo "==> 3/4 プロジェクトを作成します"
  $CLASP create --type standalone --title "Slack Notion Task" --rootDir ./src
fi

echo "==> 4/4 コードを反映します"
$CLASP push -f

cat <<'GUIDE'

------------------------------------------------------------
ここから先はブラウザでの操作です。

  1. エディタを開く:  npx @google/clasp open-script
  2. ⚙️ プロジェクトの設定 → タイムゾーンが「日本標準時」か確認
  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
       次のユーザーとして実行 : 自分
       アクセスできるユーザー : 全員
  4. 表示されたURL（https://script.google.com/macros/s/.../exec）を控える

  ※ 以降コードを直したときは:
       npm run build:slack-notion && npx @google/clasp push -f
       そのあと「デプロイを管理」→ 鉛筆 →「バージョン: 新バージョン」→「デプロイ」
------------------------------------------------------------
GUIDE
