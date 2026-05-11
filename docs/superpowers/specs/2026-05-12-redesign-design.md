# 麻雀点数計算機 リデザイン仕様

## 概要

現行の「AIっぽいダーク＋ネオングリーン＋グラスモーフィズム」デザインを、白ベース×深緑アクセントの日本的ミニマルスタイルに刷新する。あわせてツモ時の支払い表示を改善する。

---

## カラーパレット

| 役割 | 色コード | 用途 |
|---|---|---|
| 背景 | `#f5f2eb` | ページ・カード背景（温かみのある白） |
| 白 | `#ffffff` | カードヘッダー・select背景 |
| メインアクセント | `#3a7a50` | トグルアクティブ・点数パネル・ラベル・ボーダー |
| 点数文字 | `#ffffff` | 点数パネル内の大きい数字 |
| サブテキスト | `rgba(255,255,255,0.55)` | 点数パネル内のラベル・詳細テキスト |
| ボーダー | `#d8d4cc` | 非アクティブ要素の枠線 |
| テキスト（主） | `#1a1a1a` | 本文・選択肢テキスト |
| テキスト（副） | `#999999` | 非アクティブボタン・補足 |

廃止: グロー、グラスモーフィズム、`backdrop-filter`、ネオングリーン (`#4ade80`)、黒背景。

---

## タイポグラフィ

- フォント: `-apple-system, 'Helvetica Neue', sans-serif`（Outfit フォント廃止）
- ラベル: `0.62rem`, `font-weight: 700`, `letter-spacing: 0.14em`, `text-transform: uppercase`
- 点数: `3rem+`, `font-weight: 700`
- 本文: `0.85–0.9rem`

---

## コンポーネント仕様

### ヘッダー

```
背景: #ffffff
下ボーダー: 2px solid #3a7a50
タイトル: #1a1a1a, font-weight:700
リセットボタン: 丸形, border #d4c8a0, 色 #6a8050
```

### トグルボタン（親/子・ロン/ツモ）

```
コンテナ: border 1.5px solid #d8d4cc, border-radius 8px, overflow hidden, flex
非アクティブ: background #fff, color #aaa
アクティブ:   background #3a7a50, color #fff, font-weight 700
```

### セレクトボックス（翻数・符数）

```
border: 1.5px solid #d8d4cc
border-radius: 8px
background: #fff
color: #1a1a1a
```

### 本場カウンター

```
コンテナ: border 1.5px solid #d8d4cc, border-radius 8px, overflow hidden
±ボタン: background #ede8de, color #3a7a50, font-weight 700
```

### 点数パネル

```
background: #3a7a50
border-radius: 12px
ラベル: 0.6rem, color rgba(255,255,255,0.55), uppercase
点数: 3rem, font-weight 700, color #ffffff
詳細テキスト: 0.78rem, color rgba(255,255,255,0.5)
```

グロー・before 疑似要素・グラデーション背景はすべて削除。

### 符数計算アシストボタン

```
background: transparent
border: 1.5px solid #3a7a50
color: #3a7a50
border-radius: 8px
```

### 符数計算モーダル

同じカラーパレットで統一。現行の暗いモーダル背景 (`#0f172a`) を `#fff` ベースへ変更。

---

## ツモ支払い表示の修正（バグ修正）

### 現行

```
子のツモ: "親: 2000点 / 子: 1000点"  ← 1行に詰め込み
```

### 修正後

点数パネル内に2行で表示：

```
     3,900
 ┌──────────────────┐
 │  子  1,000点     │
 │  親  2,000点     │
 └──────────────────┘
```

具体的には `score-detail` を以下の構造に変更：

```html
<!-- ツモ（子）の場合 -->
<div class="tsumo-breakdown">
  <div class="tsumo-row"><span class="tsumo-who">子</span><span class="tsumo-amt">1,000点</span></div>
  <div class="tsumo-row"><span class="tsumo-who">親</span><span class="tsumo-amt">2,000点</span></div>
</div>
```

親のツモはそのまま「〇〇点オール」1行表示を維持。

---

## 削除する要素

- `font-family: 'Outfit'` および Google Fonts インポート
- `backdrop-filter: blur()`
- CSS変数: `--bg-dark`, `--accent-glow`, `--glass`, `--glass-thick`, `--glass-border`, `--card-shadow`
- `.result-area::before` (グロー疑似要素)
- `radial-gradient` 背景
- `text-shadow` (点数のグロー)
- `"WINNING SCORE"` ラベル → `"点数"` に変更

---

## スコープ外

- 計算ロジックの変更なし
- 符数計算アシストの機能変更なし（デザインのみ更新）
- レスポンシブ対応範囲の変更なし（max-width: 440px）
