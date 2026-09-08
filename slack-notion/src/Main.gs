/**
 * Slackからのリクエストの入口。
 *
 * 流れ:
 *   1. メッセージの […] メニュー → ショートカット → message_action がここに届く
 *   2. Notionのデータベース一覧（キャッシュ）からモーダルを開く
 *   3. 送信されると view_submission が届き、選ばれたデータベースにページを作る
 */

/**
 * @param {!Object} e
 * @return {!Object} ContentService の出力。
 */
function doPost(e) {
  var config;
  try {
    config = readConfig_(PropertiesService.getScriptProperties().getProperties());
  } catch (err) {
    logError_('スクリプトプロパティの読み込みに失敗', err);
    return textResponse_('');
  }

  var payload;
  try {
    payload = readPayload_(e);
  } catch (err) {
    logError_('ペイロードの解析に失敗', err);
    return textResponse_('');
  }
  if (!payload) return textResponse_('');

  var verified = verifyRequest_(config, e, payload);
  if (!verified.ok) {
    logError_('リクエストの検証に失敗: ' + verified.error, null);
    return textResponse_('');
  }

  try {
    switch (payload.type) {
      case 'url_verification':
        return jsonResponse_({ challenge: payload.challenge });
      case 'message_action':
        return handleMessageAction_(config, payload);
      case 'view_submission':
        return handleViewSubmission_(config, payload);
      default:
        // block_actions などは何もせず200を返すだけでよい。
        return textResponse_('');
    }
  } catch (err) {
    logError_('リクエストの処理に失敗', err);
    return textResponse_('');
  }
}

/**
 * 死活確認用。秘密情報は返さない。
 * @return {!Object}
 */
function doGet() {
  return jsonResponse_({ ok: true, service: 'slack-notion-task' });
}

/**
 * リクエストボディからSlackのペイロードを取り出す。
 * インタラクティブ系は application/x-www-form-urlencoded の payload、
 * Events API は生のJSONで届く。
 * @param {!Object} e
 * @return {?Object}
 */
function readPayload_(e) {
  if (e && e.parameter && e.parameter.payload) {
    return safeJsonParse_(e.parameter.payload);
  }
  if (e && e.postData && e.postData.contents) {
    return safeJsonParse_(e.postData.contents);
  }
  return null;
}

/**
 * […] メニューから呼ばれたとき。trigger_id は3秒で失効するので、
 * データベース一覧はキャッシュから引いて views.open まで最短で進む。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleMessageAction_(config, payload) {
  var triggerId = payload.trigger_id;
  if (!triggerId) {
    logError_('trigger_id がないためモーダルを開けません', null);
    return textResponse_('');
  }
  var message = payload.message || {};
  var channel = payload.channel || {};
  var team = payload.team || {};

  var missing = missingConfigKeys_(config);
  if (missing.length) {
    logError_('必須のスクリプトプロパティが未設定: ' + missing.join(', '), null);
    if (config.slackBotToken && triggerId) {
      openModal_(config, triggerId, buildNoticeModal_(
          '設定が未完了です',
          '次のスクリプトプロパティを設定してください。\n`' + missing.join('`, `') + '`'));
    }
    return textResponse_('');
  }

  var text = String(message.text || '');
  var postedAt = formatSlackTimestamp_(message.ts, scriptTimeZone_(), Utilities);
  var contextKey = 'ctx_' + Utilities.getUuid();
  // 本文は private_metadata の3000文字上限を超えうるのでキャッシュに預ける。
  writeCache_(contextKey, { text: text }, CONTEXT_CACHE_TTL_SECONDS);

  var metadata = JSON.stringify({
    k: contextKey,
    t: buildTaskTitle_(text, defaultTaskTitle_(channel.name, postedAt)),
    u: buildPermalink_(team.domain, channel.id, message.ts, message.thread_ts),
    c: String(channel.name || ''),
    a: String(message.user || ''),
    n: String(message.username || ''),
    d: postedAt,
    r: String(payload.response_url || '')
  });

  var databases = getDatabases_(config);
  if (!databases.length) {
    openModal_(config, triggerId, buildNoticeModal_(
        '追加先がありません',
        'Notion側でデータベースをこのIntegrationに共有してください。\n' +
        'タイトル列を持つデータベースだけが候補になります。'));
    return textResponse_('');
  }

  var opened = openModal_(config, triggerId, buildTaskModal_(databases, metadata, text));
  if (!opened.ok) logError_('views.open に失敗: ' + opened.error, null);
  return textResponse_('');
}

/**
 * モーダルが送信されたとき。ここでNotionにページを作る。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleViewSubmission_(config, payload) {
  var view = payload.view || {};
  if (view.callback_id !== MODAL_CALLBACK_ID) return textResponse_('');

  var databaseId = readSelectedDatabaseId_(view);
  if (!databaseId) {
    return jsonResponse_(buildValidationError_('データベースを選択してください。'));
  }

  var database = findDatabase_(config, databaseId);
  if (!database) {
    return jsonResponse_(buildValidationError_(
        '選択したデータベースが見つかりません。Notion側の共有設定を確認してください。'));
  }

  var metadata = safeJsonParse_(view.private_metadata) || {};
  var cached = readCache_(String(metadata.k || '')) || {};
  var task = {
    title: String(metadata.t || 'Slackメッセージ'),
    text: String(cached.text || ''),
    permalink: String(metadata.u || ''),
    channelName: String(metadata.c || ''),
    authorName: String(metadata.n || '') || lookupUserName_(config, String(metadata.a || '')),
    postedAt: String(metadata.d || '')
  };

  var result;
  try {
    result = createNotionTask_(config, database, task);
  } catch (err) {
    logError_('Notionへの追加で例外', err);
    return jsonResponse_(buildValidationError_(
        'Notionへの追加に失敗しました。時間をおいてもう一度お試しください。'));
  }
  if (!result.ok) {
    return jsonResponse_(buildValidationError_('Notionへの追加に失敗しました: ' + result.error));
  }

  postToResponseUrl_(String(metadata.r || ''), buildSuccessMessage_(database, task, result.url));
  return textResponse_('');
}

/**
 * 追加完了をSlackに知らせる文面（純粋関数）。
 * @param {!Object} database
 * @param {!Object} task
 * @param {string} pageUrl
 * @return {string}
 */
function buildSuccessMessage_(database, task, pageUrl) {
  var text = '✅ *' + database.title + '* に「' + task.title + '」を追加しました。';
  if (pageUrl) text += ' <' + pageUrl + '|Notionで開く>';
  return text;
}

/**
 * 本文が空のメッセージ（ファイルのみの投稿など）のタスク名。
 * @param {string} channelName
 * @param {string} postedAt
 * @return {string}
 */
function defaultTaskTitle_(channelName, postedAt) {
  var title = 'Slackメッセージ';
  if (channelName) title += ' #' + channelName;
  if (postedAt) title += ' ' + postedAt;
  return title;
}

/** @return {string} */
function scriptTimeZone_() {
  try {
    return Session.getScriptTimeZone();
  } catch (err) {
    return 'Asia/Tokyo';
  }
}

/**
 * @param {string} text
 * @return {!Object}
 */
function textResponse_(text) {
  return ContentService.createTextOutput(text || '')
      .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * @param {!Object} value
 * @return {!Object}
 */
function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
      .setMimeType(ContentService.MimeType.JSON);
}

/**
 * @param {string} message
 * @param {?Object} err
 */
function logError_(message, err) {
  var detail = err && err.stack ? err.stack : (err ? String(err) : '');
  console.error(detail ? message + ': ' + detail : message);
}
