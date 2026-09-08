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

/** 担当者とみなしてよい列名（people型）。 */
var ASSIGNEE_PROPERTY_PATTERN = /担当|assignee|owner|アサイン|responsible/i;

/** 優先度とみなしてよい列名（select / status型）。 */
var PRIORITY_PROPERTY_PATTERN = /優先|priority|重要度/i;

/**
 * 検索結果のデータベースから、モーダルとページ作成に必要な情報だけ抜き出す。
 * @param {!Object} database Notionのdatabaseオブジェクト。
 * @param {!Object} options 列名の指定を持つ設定。
 * @return {?Object} 使えないデータベースなら null。
 */
function summarizeDatabase_(database, options) {
  if (!database || database.object !== 'database') return null;
  if (database.archived || database.in_trash) return null;

  var preferred = options || {};
  var properties = database.properties || {};
  var found = {
    title: '',
    url: '',
    due: '',
    assignee: '',
    priority: null
  };
  var guessed = {
    url: '',
    strongDue: '',
    weakDue: '',
    assignee: '',
    peopleProperties: [],
    priority: null
  };

  for (var name in properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) continue;
    var property = properties[name] || {};
    var type = property.type;

    if (type === 'title' && !found.title) found.title = name;

    if (type === 'url') {
      if (preferred.urlPropertyName === name) found.url = name;
      if (!guessed.url && URL_PROPERTY_PATTERN.test(name)) guessed.url = name;
    }

    if (type === 'date') {
      if (preferred.duePropertyName === name) found.due = name;
      if (!guessed.strongDue && DUE_PROPERTY_STRONG.test(name)) guessed.strongDue = name;
      if (!guessed.weakDue && DUE_PROPERTY_WEAK.test(name)) guessed.weakDue = name;
    }

    if (type === 'people') {
      guessed.peopleProperties.push(name);
      if (preferred.assigneePropertyName === name) found.assignee = name;
      if (!guessed.assignee && ASSIGNEE_PROPERTY_PATTERN.test(name)) guessed.assignee = name;
    }

    if (type === 'select' || type === 'status') {
      var choice = { name: name, type: type, options: selectOptionsOf_(property) };
      if (preferred.priorityPropertyName === name) found.priority = choice;
      if (!guessed.priority && PRIORITY_PROPERTY_PATTERN.test(name) && choice.options.length) {
        guessed.priority = choice;
      }
    }
  }
  if (!found.title) return null;

  // 列名を明示している場合は、その列が無ければ何も書かない（勝手に別の列を埋めない）。
  if (!found.url && !preferred.urlPropertyName) found.url = guessed.url;
  if (!found.due && !preferred.duePropertyName) {
    found.due = guessed.strongDue || guessed.weakDue;
  }
  if (!found.assignee && !preferred.assigneePropertyName) {
    // 名前で当たらなくても people 型がひとつだけなら、それが担当者とみなせる。
    found.assignee = guessed.assignee ||
        (guessed.peopleProperties.length === 1 ? guessed.peopleProperties[0] : '');
  }
  if (!found.priority && !preferred.priorityPropertyName) found.priority = guessed.priority;

  return {
    id: database.id,
    title: plainTextOf_(database.title) || '(無題のデータベース)',
    titleProperty: found.title,
    urlProperty: found.url,
    dueProperty: found.due,
    assigneeProperty: found.assignee,
    priorityProperty: found.priority,
    url: database.url || ''
  };
}

/**
 * select / status 列の選択肢名を取り出す。
 * @param {!Object} property Notionのプロパティ定義。
 * @return {!Array<string>}
 */
function selectOptionsOf_(property) {
  var container = property[property.type] || {};
  return (container.options || []).map(function (option) {
    return String((option && option.name) || '');
  }).filter(function (name) { return !!name; });
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
  if (database.assigneeProperty && task.assigneeNotionUserId) {
    properties[database.assigneeProperty] = {
      people: [{ object: 'user', id: task.assigneeNotionUserId }]
    };
  }
  if (database.priorityProperty && task.priority) {
    var priority = database.priorityProperty;
    properties[priority.name] = priority.type === 'status'
        ? { status: { name: task.priority } }
        : { select: { name: task.priority } };
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
  if (task.priority) meta.push('優先度: ' + task.priority);
  if (task.assigneeName) meta.push('担当: ' + task.assigneeName);
  if (task.authorName) meta.push('投稿者: ' + task.authorName);
  if (task.threadCount > 1) meta.push('スレッド: ' + task.threadCount + '件');
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
 * Notionのワークスペースメンバーを取得する（メール付きの人だけ）。
 * @param {!Object} config
 * @return {{ok: boolean, error: string, users: !Array<{id: string, email: string, name: string}>}}
 */
function searchNotionUsers_(config) {
  var users = [];
  var cursor = null;
  for (var page = 0; page < 10; page++) {
    var path = 'users?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    var result = callNotionApi_(config, 'get', path, null);
    if (!result.ok) return { ok: false, error: result.error, users: [] };

    var results = result.body.results || [];
    for (var i = 0; i < results.length; i++) {
      var user = results[i] || {};
      var email = ((user.person || {}).email || '').toLowerCase();
      if (user.type !== 'person' || !email) continue;
      users.push({ id: user.id, email: email, name: String(user.name || '') });
    }
    if (!result.body.has_more) break;
    cursor = result.body.next_cursor;
    if (!cursor) break;
  }
  return { ok: true, error: '', users: users };
}

/**
 * Notionのページを書き換える。
 * @param {!Object} config
 * @param {string} pageId
 * @param {!Object} properties 書き換える列。
 * @return {{ok: boolean, error: string, url: string}}
 */
function updateNotionPage_(config, pageId, properties) {
  var result = callNotionApi_(config, 'patch', 'pages/' + encodeURIComponent(pageId),
      { properties: properties });
  if (!result.ok) return { ok: false, error: result.error, url: '' };
  return { ok: true, error: '', url: String(result.body.url || '') };
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
  if (!result.ok) return { ok: false, error: result.error, url: '', pageId: '' };
  return {
    ok: true,
    error: '',
    url: String(result.body.url || ''),
    pageId: String(result.body.id || '')
  };
}
