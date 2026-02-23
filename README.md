# 麻雀点数計算機 (Mahjong Calculator)

[🚀 Web版を開く](https://script.google.com/macros/s/AKfycbxpdiEivPzuP1sKB1CNILbb6KQ9RWfl0EAkOD41KqATvNYZy2V_EkAFolCmJ6aIWKCs/exec)

Google Apps Script (GAS) 上で動作する、シンプルでモダンなデザインの麻雀点数計算機です。
翻数と符数を選択するだけで、親・子、ロン・ツモに応じた点数をリアルタイムに算出します。

## 🌟 主な機能

- **点数計算**: 1翻〜役満、20符〜110符まで対応。
- **符計算アシスト**: 手牌の構成（雀頭、待ち、面子の種類）をクリックするだけで符を自動計算。
- **本場管理**: 積み棒（本場）を含めた支払い点数の算出。
- **ダークモードUI**: 視認性の高い、モダンで洗礼されたデザイン。
- **リアルタイム反映**: 設定を変更すると即座に計算結果を表示。

## 🛠 技術スタック

- **Frontend**: HTML5, CSS3 (Custom Properties), JavaScript (ES6+)
- **Backend**: Google Apps Script (GAS)

## 🚀 セットアップ方法

このプロジェクトは Google Apps Script 向けに構成されています。

1. [Google Apps Script](https://script.google.com/) で新しいプロジェクトを作成します。
2. `code.gs` の内容をプロジェクトの `.gs` ファイルに貼り付けます。
3. `index.html` という名前で新しい HTML ファイルを作成し、内容を貼り付けます。
4. 「デプロイ」>「新しいデプロイ」から「ウェブアプリ」を選択して公開します。

## 💡 使い方

1. **親/子の選択**: 東（親）か南（子）を選択します。
2. **アガリ方の選択**: ロンまたはツモを選択します。
3. **翻数・符数の選択**: ドロップダウンから選択します。
4. **符計算が不明な場合**: 「符数計算アシスト」ボタンを押し、手牌の状態を入力して反映させます。
5. **本場の設定**: 連荘中などの場合は積み棒の数を調整します。

---

Developed with ❤️ using Antigravity AI.
