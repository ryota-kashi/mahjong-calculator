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
      var summary = summarizeDatabase_(results[i], config.urlPropertyName);
      if (summary) databases.push(summary);
    }
    if (!result.body.has_more) break;
    cursor = result.body.next_cursor;
    if (!cursor) break;
  }
  return { ok: true, error: '', databases: databases };
}

/**
 * 検索結果のデータベースから、モーダルとページ作成に必要な情報だけ抜き出す。
 * @param {!Object} database Notionのdatabaseオブジェクト。
 * @param {string} preferredUrlProperty NOTION_URL_PROPERTY の設定値。
 * @return {?Object} 使えないデータベースなら null。
 */
function summarizeDatabase_(database, preferredUrlProperty) {
  if (!database || database.object !== 'database') return null;
  if (database.archived || database.in_trash) return null;

  var properties = database.properties || {};
  var titleProperty = '';
  var urlProperty = '';
  var fallbackUrlProperty = '';

  for (var name in properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) continue;
    var type = (properties[name] || {}).type;
    if (type === 'title' && !titleProperty) titleProperty = name;
    if (type === 'url') {
      if (preferredUrlProperty && name === preferredUrlProperty) urlProperty = name;
      if (!fallbackUrlProperty && /slack|link|url|リンク/i.test(name)) fallbackUrlProperty = name;
    }
  }
  if (!titleProperty) return null;
  if (!urlProperty && !preferredUrlProperty) urlProperty = fallbackUrlProperty;

  return {
    id: database.id,
    title: plainTextOf_(database.title) || '(無題のデータベース)',
    titleProperty: titleProperty,
    urlProperty: urlProperty,
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
