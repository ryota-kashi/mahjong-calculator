/**
 * Notion API とのやり取り。
 */

var NOTION_API_BASE = 'https://api.notion.com/v1/';

/**
 * Notion API を呼ぶ。
 * @param {!Object} config
 * @param {string} method HTTPメソッド。
 * @param {string} path 例: 'pages'
 * @param {?Object} payload
 * @return {{ok: boolean, status: number, error: string, body: !Object}}
 */
function callNotionApi_(config, method, path, payload) {
  var options = {
    method: method,
    contentType: 'application/json; charset=utf-8',
    headers: {
      Authorization: 'Bearer ' + config.notionToken,
      'Notion-Version': config.notionVersion
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(NOTION_API_BASE + path, options);
  var status = response.getResponseCode();
  var body = safeJsonParse_(response.getContentText()) || {};
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      status: status,
      error: String(body.message || body.code || ('HTTP ' + status)),
      body: body
    };
  }
  return { ok: true, status: status, error: '', body: body };
}

/**
 * Integration に共有されているデータベースを取得する。
 * @param {!Object} config
 * @return {{ok: boolean, error: string, databases: !Array<!Object>}}
 */
function searchNotionDatabases_(config) {
  var databases = [];
  var cursor = null;
  for (var page = 0; page < 10; page++) {
    var payload = {
      filter: { property: 'object', value: 'database' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100
    };
    if (cursor) payload.start_cursor = cursor;

    var result = callNotionApi_(config, 'post', 'search', payload);
    if (!result.ok) return { ok: false, error: result.error, databases: [] };

    var results = result.body.results || [];
    for (var i = 0; i < results.length; i++) {
      var summary = summarizeDatabase_(results[i], config);
      if (summary) databases.push(summary);
    }
    if (!result.body.has_more) break;
    cursor = result.body.next_cursor;
    if (!cursor) break;
  }
  return { ok: true, error: '', databases: databases };
}

/** 期限とみなしてよい列名。「期限」寄りの名前を優先する。 */
var DUE_PROPERTY_STRONG = /期限|締切|締め切り|deadline|due/i;
var DUE_PROPERTY_WEAK = /^date$|日付|実施日|予定日/i;

/** Slackリンクを入れてよい列名。 */
var URL_PROPERTY_PATTERN = /slack|link|url|リンク/i;

/**
 * 検索結果のデータベースから、モーダルとページ作成に必要な情報だけ抜き出す。
 * @param {!Object} database Notionのdatabaseオブジェクト。
 * @param {!Object} options {urlPropertyName, duePropertyName} を持つ設定。
 * @return {?Object} 使えないデータベースなら null。
 */
function summarizeDatabase_(database, options) {
  if (!database || database.object !== 'database') return null;
  if (database.archived || database.in_trash) return null;

  var preferredUrl = (options || {}).urlPropertyName || '';
  var preferredDue = (options || {}).duePropertyName || '';
  var properties = database.properties || {};
  var titleProperty = '';
  var urlProperty = '';
  var dueProperty = '';
  var guessedUrl = '';
  var strongDue = '';
  var weakDue = '';

  for (var name in properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) continue;
    var type = (properties[name] || {}).type;
    if (type === 'title' && !titleProperty) titleProperty = name;
    if (type === 'url') {
      if (preferredUrl && name === preferredUrl) urlProperty = name;
      if (!guessedUrl && URL_PROPERTY_PATTERN.test(name)) guessedUrl = name;
    }
    if (type === 'date') {
      if (preferredDue && name === preferredDue) dueProperty = name;
      if (!strongDue && DUE_PROPERTY_STRONG.test(name)) strongDue = name;
      if (!weakDue && DUE_PROPERTY_WEAK.test(name)) weakDue = name;
    }
  }
  if (!titleProperty) return null;

  // 列名を明示している場合は、その列が無ければ何も書かない（勝手に別の列を埋めない）。
  if (!urlProperty && !preferredUrl) urlProperty = guessedUrl;
  if (!dueProperty && !preferredDue) dueProperty = strongDue || weakDue;

  return {
    id: database.id,
    title: plainTextOf_(database.title) || '(無題のデータベース)',
    titleProperty: titleProperty,
    urlProperty: urlProperty,
    dueProperty: dueProperty,
    url: database.url || ''
  };
}

/**
 * Notionのrich_text配列を素のテキストにする。
 * @param {?Array<!Object>} richText
 * @return {string}
 */
function plainTextOf_(richText) {
  if (!richText || !richText.length) return '';
  return richText.map(function (part) {
    return (part && part.plain_text) || '';
  }).join('').trim();
}

/**
 * ページ作成リクエストの中身を組み立てる（純粋関数）。
 * @param {!Object} database summarizeDatabase_ の戻り値。
 * @param {!Object} task {title, text, permalink, authorName, channelName, postedAt}
 * @return {!Object}
 */
function buildNotionPagePayload_(database, task) {
  var properties = {};
  properties[database.titleProperty] = {
    title: [{ type: 'text', text: { content: truncate_(task.title, TITLE_MAX_LENGTH) } }]
  };
  if (database.urlProperty && task.permalink) {
    properties[database.urlProperty] = { url: task.permalink };
  }
  if (database.dueProperty && task.dueDate) {
    properties[database.dueProperty] = { date: { start: task.dueDate } };
  }
  return {
    parent: { database_id: database.id },
    properties: properties,
    children: buildNotionBlocks_(task)
  };
}

/**
 * ページ本文のブロックを組み立てる（純粋関数）。
 * 1行目にSlackへのリンクと投稿者などのメタ情報、その下に本文を引用で置く。
 * @param {!Object} task
 * @return {!Array<!Object>}
 */
function buildNotionBlocks_(task) {
  var blocks = [];
  var meta = [];
  if (task.dueDate) meta.push('期限: ' + task.dueDate);
  if (task.authorName) meta.push('投稿者: ' + task.authorName);
  if (task.channelName) meta.push('チャンネル: #' + task.channelName);
  if (task.postedAt) meta.push('投稿日時: ' + task.postedAt);

  var richText = [];
  if (task.permalink) {
    richText.push({
      type: 'text',
      text: { content: 'Slackで開く', link: { url: task.permalink } }
    });
    if (meta.length) richText.push({ type: 'text', text: { content: '  |  ' } });
  }
  if (meta.length) {
    richText.push({ type: 'text', text: { content: meta.join('  |  ') } });
  }
  if (richText.length) {
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText } });
  }

  var body = slackTextToPlain_(task.text);
  var chunks = chunkText_(body, RICH_TEXT_CHUNK_SIZE);
  for (var i = 0; i < chunks.length && blocks.length < 100; i++) {
    blocks.push({
      object: 'block',
      type: 'quote',
      quote: { rich_text: [{ type: 'text', text: { content: chunks[i] } }] }
    });
  }
  return blocks;
}

/**
 * Notionにタスクを1件作る。
 * @param {!Object} config
 * @param {!Object} database
 * @param {!Object} task
 * @return {{ok: boolean, error: string, url: string}}
 */
function createNotionTask_(config, database, task) {
  var result = callNotionApi_(config, 'post', 'pages', buildNotionPagePayload_(database, task));
  if (!result.ok) return { ok: false, error: result.error, url: '' };
  return { ok: true, error: '', url: String(result.body.url || '') };
}
