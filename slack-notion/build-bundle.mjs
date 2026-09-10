// src/*.gs を1ファイルにまとめる。
// Apps Script のエディタに手で貼り付けるとき、ファイルを1つずつ作らずに済ませるため。
// 実行: npm run build:slack-notion
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.join(HERE, 'src');
export const BUNDLE_PATH = path.join(HERE, 'dist', 'Code.gs');

// 読み込む順番。GASは全ファイルが同じスコープなので依存順ではないが、
// 読みやすさのために「設定 → 部品 → 入口」の順に並べる。
export const SOURCE_FILES = [
  'Config.gs',
  'Text.gs',
  'Slack.gs',
  'Notion.gs',
  'Gemini.gs',
  'Cache.gs',
  'Users.gs',
  'Views.gs',
  'Queue.gs',
  'Tasks.gs',
  'Main.gs',
  'Setup.gs'
];

const HEADER = `/**
 * このファイルは slack-notion/src/*.gs をまとめた自動生成ファイルです。
 * 直接編集しないでください。編集は src/ 側で行い、
 * \`npm run build:slack-notion\` で作り直してください。
 *
 * Apps Script のエディタに手で貼り付ける場合は、この中身をまるごと
 * 「コード.gs」に貼れば動きます（ファイルを分ける必要はありません）。
 */
`;

/**
 * まとめた中身を組み立てる。
 * @return {string}
 */
export function buildBundle() {
  const parts = SOURCE_FILES.map((file) => {
    const code = fs.readFileSync(path.join(SRC_DIR, file), 'utf8').trim();
    return `// ${'='.repeat(72)}\n// ${file}\n// ${'='.repeat(72)}\n\n${code}\n`;
  });
  return HEADER + '\n' + parts.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.dirname(BUNDLE_PATH), { recursive: true });
  fs.writeFileSync(BUNDLE_PATH, buildBundle());
  const lines = buildBundle().split('\n').length;
  console.log(`${path.relative(process.cwd(), BUNDLE_PATH)} を作成しました（${SOURCE_FILES.length}ファイル / ${lines}行）`);
}
