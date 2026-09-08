// Slack → Notion 連携（slack-notion/）のテスト。
// Apps Script のファイルは素の JavaScript なので、GAS のグローバル
// (PropertiesService など) を差し替えた VM で読み込んで検証する。
// 実行: node tests/slack-notion.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'slack-notion', 'src');
const FILES = ['Config.gs', 'Text.gs', 'Slack.gs', 'Notion.gs', 'Cache.gs', 'Views.gs', 'Main.gs', 'Setup.gs'];

// ---- テストランナー ----
let pass = 0;
const failures = [];

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else failures.push(`${name}\n    実際: ${JSON.stringify(actual)}\n    期待: ${JSON.stringify(expected)}`);
}

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
}

// ---- Notion 側のテストデータ ----
const DB_TASKS = {
  object: 'database',
  id: '11111111-2222-3333-4444-555555555555',
  url: 'https://www.notion.so/tasks',
  title: [{ plain_text: '開発タスク' }],
  properties: {
    '名前': { type: 'title' },
    'Slackリンク': { type: 'url' },
    'ステータス': { type: 'status' }
  }
};
const DB_NOTES = {
  object: 'database',
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  url: 'https://www.notion.so/notes',
  title: [{ plain_text: '議事録' }],
  properties: { 'Name': { type: 'title' } }
};
const DB_WITHOUT_TITLE = {
  object: 'database',
  id: 'ffffffff-0000-1111-2222-333333333333',
  title: [{ plain_text: 'タイトル列なし' }],
  properties: { 'メモ': { type: 'rich_text' } }
};
const DB_ARCHIVED = {
  object: 'database',
  id: '99999999-8888-7777-6666-555555555555',
  archived: true,
  title: [{ plain_text: '削除済み' }],
  properties: { 'Name': { type: 'title' } }
};

const DEFAULT_PROPERTIES = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_VERIFICATION_TOKEN: 'verify-me',
  NOTION_TOKEN: 'ntn_test'
};

/**
 * GAS のグローバルを差し替えた環境に slack-notion/src を読み込む。
 */
function createApp(options = {}) {
  const properties = { ...DEFAULT_PROPERTIES, ...(options.properties || {}) };
  const databases = options.databases || [DB_TASKS, DB_NOTES, DB_WITHOUT_TITLE, DB_ARCHIVED];
  const cache = new Map();
  const requests = [];
  const logs = [];
  let uuid = 0;

  const respond = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => JSON.stringify(body)
  });

  const defaultHandler = (url, request) => {
    if (url.endsWith('/api/views.open')) return respond(200, { ok: true });
    if (url.endsWith('/api/users.info')) {
      return respond(200, { ok: true, user: { profile: { display_name: '池上翔輝' } } });
    }
    if (url.endsWith('/v1/search')) return respond(200, { results: databases, has_more: false });
    if (url.endsWith('/v1/pages')) {
      return respond(200, { url: 'https://www.notion.so/created-page' });
    }
    return respond(200, {});
  };
  const handler = options.fetch || defaultHandler;

  const sandbox = {
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' '))
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...properties }),
        setProperty: (key, value) => { properties[key] = value; },
        deleteProperty: (key) => { delete properties[key]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => { cache.set(key, value); },
        remove: (key) => { cache.delete(key); }
      })
    },
    UrlFetchApp: {
      fetch: (url, request) => {
        const parsed = request && request.payload ? JSON.parse(request.payload) : null;
        requests.push({ url, request, payload: parsed });
        const response = handler(url, request, parsed);
        if (response instanceof Error) throw response;
        return response;
      }
    },
    Utilities: {
      getUuid: () => `uuid-${++uuid}`,
      formatDate: (date, timeZone, format) => `${date.toISOString().slice(0, 10)} 12:34`
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }) }) }),
      deleteTrigger: () => {}
    },
    ContentService: {
      MimeType: { TEXT: 'TEXT', JSON: 'JSON' },
      createTextOutput: (text) => {
        const output = {
          content: text,
          mimeType: 'TEXT',
          setMimeType(type) { output.mimeType = type; return output; },
          getContent: () => output.content
        };
        return output;
      }
    }
  };

  const context = vm.createContext(sandbox);
  for (const file of FILES) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }

  return {
    context,
    properties,
    requests,
    logs,
    cache,
    call: (name, ...args) => vm.runInContext(name, context)(...args),
    urls: () => requests.map((request) => request.url)
  };
}

/** Slack の […] メニューから届くペイロード。 */
function messageActionPayload(overrides = {}) {
  return {
    type: 'message_action',
    token: 'verify-me',
    callback_id: 'add_to_notion',
    trigger_id: 'trigger-1',
    response_url: 'https://hooks.slack.com/actions/T1/1/abc',
    team: { id: 'T1', domain: 'kitera' },
    channel: { id: 'C123', name: 'general' },
    user: { id: 'U999' },
    message: { ts: '1717000000.123456', user: 'U111', text: '請求書の締め切りを確認する\n詳細はこちら' },
    ...overrides
  };
}

function postEvent(payload, parameter = {}) {
  return { parameter: { payload: JSON.stringify(payload), ...parameter } };
}

/** モーダル送信のペイロード。 */
function viewSubmissionPayload(privateMetadata, databaseId, overrides = {}) {
  return {
    type: 'view_submission',
    token: 'verify-me',
    team: { id: 'T1', domain: 'kitera' },
    user: { id: 'U999' },
    view: {
      callback_id: 'create_notion_task',
      private_metadata: privateMetadata,
      state: {
        values: {
          database: {
            database_select: databaseId
              ? { type: 'static_select', selected_option: { value: databaseId } }
              : { type: 'static_select', selected_option: null }
          }
        }
      }
    },
    ...overrides
  };
}

/** message_action を1回処理して、開かれたモーダルを返す。 */
function openTaskModal(app, payload = messageActionPayload()) {
  app.call('doPost', postEvent(payload));
  const opened = app.requests.filter((request) => request.url.endsWith('/api/views.open'));
  return opened.length ? opened[opened.length - 1].payload.view : null;
}

// ---- 1. Slack のマークアップをテキストに直す ----
{
  const app = createApp();
  const toPlain = (text) => app.call('slackTextToPlain_', text);
  check('メンションを名前に直す', toPlain('<@U123|taro> よろしく'), '@taro よろしく');
  check('名前なしメンションはIDを残す', toPlain('<@U123> よろしく'), '@U123 よろしく');
  check('チャンネル参照', toPlain('<#C123|general> を見て'), '#general を見て');
  check('ラベル付きリンクはラベルだけ', toPlain('<https://ex.com|資料> を確認'), '資料 を確認');
  check('素のリンクはURLのまま', toPlain('<https://ex.com/a?b=1>'), 'https://ex.com/a?b=1');
  check('@here', toPlain('<!here> 集合'), '@here 集合');
  check('HTMLエスケープを戻す', toPlain('a &amp;&lt;b&gt;'), 'a &<b>');
  check('空文字', toPlain(''), '');
  check('null', toPlain(null), '');
}

// ---- 2. タスク名の組み立て ----
{
  const app = createApp();
  const title = (text, fallback) => app.call('buildTaskTitle_', text, fallback);
  check('最初の空でない行を使う', title('\n\n請求書を送る\n詳細は後で', 'なし'), '請求書を送る');
  check('空白は1つにまとめる', title('  A   B  ', 'なし'), 'A B');
  check('本文が空ならフォールバック', title('   \n  ', 'Slackメッセージ #general'), 'Slackメッセージ #general');
  const long = title('あ'.repeat(200), 'なし');
  ok('長い行は100文字に切り詰める', long.length === 100 && long.endsWith('…'), `長さ=${long.length}`);
}

// ---- 3. パーマリンク ----
{
  const app = createApp();
  const link = (...args) => app.call('buildPermalink_', ...args);
  check('通常のメッセージ', link('kitera', 'C123', '1717000000.123456'),
    'https://kitera.slack.com/archives/C123/p1717000000123456');
  check('スレッド内の返信', link('kitera', 'C123', '1717000000.123456', '1716999999.000100'),
    'https://kitera.slack.com/archives/C123/p1717000000123456?thread_ts=1716999999.000100&cid=C123');
  check('親メッセージのthread_tsは無視', link('kitera', 'C123', '1717000000.123456', '1717000000.123456'),
    'https://kitera.slack.com/archives/C123/p1717000000123456');
  check('情報が足りなければ空', link('', 'C123', '1717000000.123456'), '');
}

// ---- 4. 本文の分割 ----
{
  const app = createApp();
  const chunk = (text, size) => app.call('chunkText_', text, size);
  check('短い本文はそのまま', chunk('abc', 10), ['abc']);
  check('空文字は空配列', chunk('', 10), []);
  check('改行を優先して切る', chunk('12345\n67890abc', 8), ['12345', '67890abc']);
  const chunks = chunk('x'.repeat(4500), 1900);
  ok('改行がなければ長さで切る',
    chunks.length === 3 && chunks.every((part) => part.length <= 1900) &&
    chunks.join('').length === 4500,
    JSON.stringify(chunks.map((part) => part.length)));
}

// ---- 5. Notion のページ本体 ----
{
  const app = createApp();
  const database = app.call('summarizeDatabase_', DB_TASKS, '');
  check('タイトル列を見つける', database.titleProperty, '名前');
  check('URL列を名前から推測する', database.urlProperty, 'Slackリンク');
  check('データベース名', database.title, '開発タスク');
  check('タイトル列がなければ候補から外す', app.call('summarizeDatabase_', DB_WITHOUT_TITLE, ''), null);
  check('アーカイブ済みは候補から外す', app.call('summarizeDatabase_', DB_ARCHIVED, ''), null);

  const payload = app.call('buildNotionPagePayload_', database, {
    title: '請求書の締め切りを確認する',
    text: '請求書の締め切りを確認する\n詳細はこちら',
    permalink: 'https://kitera.slack.com/archives/C123/p1717000000123456',
    authorName: '池上翔輝',
    channelName: 'general',
    postedAt: '2024/05/29 12:34'
  });
  check('親データベース', payload.parent, { database_id: DB_TASKS.id });
  check('タイトル列に入る値', payload.properties['名前'].title[0].text.content, '請求書の締め切りを確認する');
  check('URL列にパーマリンク', payload.properties['Slackリンク'].url,
    'https://kitera.slack.com/archives/C123/p1717000000123456');
  check('メタ情報の段落が先頭', payload.children[0].type, 'paragraph');
  check('Slackへのリンクを張る', payload.children[0].paragraph.rich_text[0].text.link.url,
    'https://kitera.slack.com/archives/C123/p1717000000123456');
  ok('投稿者とチャンネルを載せる',
    payload.children[0].paragraph.rich_text[2].text.content.includes('投稿者: 池上翔輝') &&
    payload.children[0].paragraph.rich_text[2].text.content.includes('チャンネル: #general'),
    JSON.stringify(payload.children[0].paragraph.rich_text[2]));
  check('本文は引用ブロック', payload.children[1].type, 'quote');

  const noUrlProperty = app.call('summarizeDatabase_', DB_NOTES, '');
  const notePayload = app.call('buildNotionPagePayload_', noUrlProperty, { title: 'メモ', text: '' });
  check('URL列がなければ書き込まない', Object.keys(notePayload.properties), ['Name']);
  check('本文が空なら引用ブロックなし', notePayload.children.length, 0);

  const explicit = app.call('summarizeDatabase_',
    { ...DB_TASKS, properties: { 'Name': { type: 'title' }, '参照元': { type: 'url' } } }, '参照元');
  check('NOTION_URL_PROPERTY の指定を優先', explicit.urlProperty, '参照元');
}

// ---- 6. モーダルの組み立て ----
{
  const app = createApp();
  const many = Array.from({ length: 120 }, (unused, index) => ({
    id: `db-${index}`, title: 'あ'.repeat(100), titleProperty: 'Name', urlProperty: ''
  }));
  const modal = app.call('buildTaskModal_', many, '{}', 'テスト本文');
  const select = modal.blocks.find((block) => block.type === 'input').element;
  check('選択肢は100件まで', select.options.length, 100);
  ok('選択肢のラベルは75文字以内',
    select.options.every((option) => option.text.text.length <= 75),
    `最長=${Math.max(...select.options.map((option) => option.text.text.length))}`);
  check('block_id', modal.blocks.find((block) => block.type === 'input').block_id, 'database');
  check('action_id', select.action_id, 'database_select');
  check('callback_id', modal.callback_id, 'create_notion_task');
  ok('件数超過を知らせる', modal.blocks.some((block) => block.type === 'context'));
}

// ---- 7. […] からモーダルが開くまで ----
{
  const app = createApp();
  const output = app.call('doPost', postEvent(messageActionPayload()));
  check('Slackには空の200を返す', output.getContent(), '');

  const view = openTaskModal(app);
  ok('モーダルを開いた', !!view);
  const options = view.blocks.find((block) => block.type === 'input').element.options;
  check('候補は使えるデータベースだけ', options.map((option) => option.text.text), ['開発タスク', '議事録']);
  ok('本文のプレビューを出す',
    view.blocks[0].text.text.includes('請求書の締め切りを確認する'), JSON.stringify(view.blocks[0]));

  const metadata = JSON.parse(view.private_metadata);
  check('タスク名を引き継ぐ', metadata.t, '請求書の締め切りを確認する');
  check('パーマリンクを引き継ぐ', metadata.u, 'https://kitera.slack.com/archives/C123/p1717000000123456');
  check('response_url を引き継ぐ', metadata.r, 'https://hooks.slack.com/actions/T1/1/abc');
  ok('private_metadata は3000文字以内', view.private_metadata.length <= 3000);
  ok('本文はキャッシュに預ける',
    JSON.parse(app.cache.get(metadata.k)).text.includes('詳細はこちら'));

  // 2回目はキャッシュから引くので Notion を叩かない。
  const before = app.urls().filter((url) => url.endsWith('/v1/search')).length;
  openTaskModal(app);
  const after = app.urls().filter((url) => url.endsWith('/v1/search')).length;
  check('データベース一覧はキャッシュする', [before, after], [1, 1]);
}

// ---- 8. 本文が空のメッセージ ----
{
  const app = createApp();
  const view = openTaskModal(app, messageActionPayload({
    message: { ts: '1717000000.123456', user: 'U111', text: '', files: [{ id: 'F1' }] }
  }));
  const metadata = JSON.parse(view.private_metadata);
  ok('チャンネル名と日時から名前を作る',
    metadata.t.startsWith('Slackメッセージ #general'), metadata.t);
}

// ---- 9. リクエストの検証 ----
{
  const app = createApp();
  app.call('doPost', postEvent(messageActionPayload({ token: 'wrong-token' })));
  check('Verification Token が違えば何もしない',
    app.urls().filter((url) => url.endsWith('/api/views.open')).length, 0);
  ok('理由をログに残す', app.logs.some((line) => line.includes('Verification Token')), app.logs.join('|'));

  const secured = createApp({ properties: { WEBHOOK_SECRET: 's3cret' } });
  secured.call('doPost', postEvent(messageActionPayload()));
  check('合言葉が無ければ弾く',
    secured.urls().filter((url) => url.endsWith('/api/views.open')).length, 0);
  secured.call('doPost', postEvent(messageActionPayload(), { s: 's3cret' }));
  check('合言葉が合えば通す',
    secured.urls().filter((url) => url.endsWith('/api/views.open')).length, 1);

  const unconfigured = createApp({ properties: { SLACK_VERIFICATION_TOKEN: '' } });
  unconfigured.call('doPost', postEvent(messageActionPayload()));
  check('検証トークン未設定なら受け付けない',
    unconfigured.urls().filter((url) => url.endsWith('/api/views.open')).length, 0);

  check('壊れたペイロードでも落ちない',
    createApp().call('doPost', { parameter: { payload: '{' } }).getContent(), '');
  check('ペイロードなしでも落ちない', createApp().call('doPost', {}).getContent(), '');
}

// ---- 10. モーダル送信 → Notion にページ作成 ----
{
  const app = createApp();
  const view = openTaskModal(app);
  const metadata = view.private_metadata;
  const output = app.call('doPost', postEvent(viewSubmissionPayload(metadata, DB_TASKS.id)));
  check('モーダルは閉じる（空の200）', output.getContent(), '');

  const created = app.requests.filter((request) => request.url.endsWith('/v1/pages'));
  check('ページを1件作る', created.length, 1);
  check('選んだデータベースに入れる', created[0].payload.parent.database_id, DB_TASKS.id);
  check('タスク名', created[0].payload.properties['名前'].title[0].text.content, '請求書の締め切りを確認する');
  check('Notion-Version ヘッダー', created[0].request.headers['Notion-Version'], '2022-06-28');
  ok('本文をキャッシュから復元する',
    JSON.stringify(created[0].payload.children).includes('詳細はこちら'),
    JSON.stringify(created[0].payload.children));
  ok('投稿者名を users.info で解決する',
    JSON.stringify(created[0].payload.children).includes('池上翔輝'));

  const notified = app.requests.filter((request) => request.url.startsWith('https://hooks.slack.com/'));
  check('response_url に完了を通知する', notified.length, 1);
  check('本人にだけ見せる', notified[0].payload.response_type, 'ephemeral');
  ok('作成したページへのリンクを載せる',
    notified[0].payload.text.includes('https://www.notion.so/created-page'), notified[0].payload.text);
  ok('データベース名を載せる', notified[0].payload.text.includes('開発タスク'));
}

// ---- 11. 送信時のエラー ----
{
  // 選択なし
  const app = createApp();
  const empty = app.call('doPost', postEvent(viewSubmissionPayload('{}', '')));
  check('未選択はモーダル内にエラーを出す', JSON.parse(empty.getContent()).response_action, 'errors');
  check('エラーは選択欄に紐づける',
    Object.keys(JSON.parse(empty.getContent()).errors), ['database']);
  check('ページは作らない', app.urls().filter((url) => url.endsWith('/v1/pages')).length, 0);

  // Notion がエラーを返す
  const failing = createApp({
    fetch: (url, request, payload) => {
      if (url.endsWith('/v1/pages')) {
        return {
          getResponseCode: () => 400,
          getContentText: () => JSON.stringify({ message: 'body.properties.名前 should be defined' })
        };
      }
      if (url.endsWith('/v1/search')) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ results: [DB_TASKS] }) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
    }
  });
  const view = openTaskModal(failing);
  const result = failing.call('doPost', postEvent(viewSubmissionPayload(view.private_metadata, DB_TASKS.id)));
  const body = JSON.parse(result.getContent());
  check('Notionのエラーはモーダルに出す', body.response_action, 'errors');
  ok('原因を書く', body.errors.database.includes('should be defined'), body.errors.database);
  check('失敗したら完了通知はしない',
    failing.urls().filter((url) => url.startsWith('https://hooks.slack.com/')).length, 0);

  // 通信そのものが失敗
  const throwing = createApp({
    fetch: (url) => {
      if (url.endsWith('/v1/pages')) return new Error('DNS error');
      if (url.endsWith('/v1/search')) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ results: [DB_TASKS] }) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
    }
  });
  const throwingView = openTaskModal(throwing);
  const thrown = throwing.call('doPost',
    postEvent(viewSubmissionPayload(throwingView.private_metadata, DB_TASKS.id)));
  check('例外でも500にせずエラー表示に落とす',
    JSON.parse(thrown.getContent()).response_action, 'errors');
}

// ---- 12. キャッシュが消えていても最低限動く ----
{
  const app = createApp();
  const view = openTaskModal(app);
  app.cache.clear();
  app.call('doPost', postEvent(viewSubmissionPayload(view.private_metadata, DB_TASKS.id)));
  const created = app.requests.filter((request) => request.url.endsWith('/v1/pages'));
  check('タスク名は private_metadata から復元できる',
    created[0].payload.properties['名前'].title[0].text.content, '請求書の締め切りを確認する');
}

// ---- 13. 許可リスト ----
{
  const app = createApp({ properties: { NOTION_DATABASE_ALLOWLIST: DB_NOTES.id.replace(/-/g, '') } });
  const view = openTaskModal(app);
  const options = view.blocks.find((block) => block.type === 'input').element.options;
  check('許可したデータベースだけ出す', options.map((option) => option.text.text), ['議事録']);
}

// ---- 14. 追加先が1件もない ----
{
  const app = createApp({ databases: [] });
  const view = openTaskModal(app);
  check('案内モーダルを出す', view.title.text, '追加先がありません');
  ok('送信ボタンは出さない', view.submit === undefined, JSON.stringify(view.submit));
}

// ---- 15. 設定が足りない ----
{
  const app = createApp({ properties: { NOTION_TOKEN: '' } });
  const view = openTaskModal(app);
  check('設定を促すモーダルを出す', view.title.text, '設定が未完了です');
  ok('不足している項目名を出す', view.blocks[0].text.text.includes('NOTION_TOKEN'));
  check('Notionは呼ばない', app.urls().filter((url) => url.includes('api.notion.com')).length, 0);
}

// ---- 16. 想定外のペイロード種別 ----
{
  const app = createApp();
  const output = app.call('doPost', postEvent({ type: 'block_actions', token: 'verify-me', actions: [] }));
  check('block_actions は空の200で無視する', output.getContent(), '');
  const challenge = app.call('doPost', postEvent({ type: 'url_verification', token: 'verify-me', challenge: 'abc' }));
  check('url_verification に応答する', JSON.parse(challenge.getContent()).challenge, 'abc');
}

// ---- 17. 定数の突き合わせ（マニフェストとコード） ----
{
  const app = createApp();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-notion', 'slack-app-manifest.json'), 'utf8'));
  check('ショートカットは message 型', manifest.features.shortcuts[0].type, 'message');
  check('callback_id がコードと一致する',
    manifest.features.shortcuts[0].callback_id, vm.runInContext('SHORTCUT_CALLBACK_ID', app.context));
  ok('interactivity が有効', manifest.settings.interactivity.is_enabled === true);
  ok('users:read を要求する', manifest.oauth_config.scopes.bot.includes('users:read'));
}

// ---- 結果 ----
if (failures.length) {
  console.error(`❌ ${failures.length} 件失敗 / ${pass + failures.length} 件中\n`);
  failures.forEach((failure) => console.error('  - ' + failure));
  process.exit(1);
}
console.log(`✅ ${pass} 件すべて成功`);
