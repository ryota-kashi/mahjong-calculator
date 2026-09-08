/**
 * Slackからのリクエストの入口。
 *
 * 流れ:
 *   1. ⚡ メニュー →「Notion DBの設定」→ shortcut
 *      → 利用者ごとに追加先データベースを登録する
 *   2. メッセージの […] メニュー →「Notionに追加」→ message_action
 *      → 本人が登録したデータベースだけを候補にモーダルを開く
 *        （未登録の人には候補を出さず、登録への案内だけ出す）
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
      case 'shortcut':
        return handleGlobalShortcut_(config, payload);
      case 'message_action':
        return handleMessageAction_(config, payload);
      case 'block_actions':
        return handleBlockActions_(config, payload);
      case 'view_submission':
        return handleViewSubmission_(config, payload);
      default:
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

  // 候補は「本人が登録したデータベース」だけ。
  // 使っていない人にはほかの人の候補が見えないようにする。
  var databases = getUserDatabases_(config, userId_(payload));
  if (!databases.length) {
    openModal_(config, triggerId, buildRegistrationNoticeModal_());
    return textResponse_('');
  }

  var opened = openModal_(config, triggerId, buildTaskModal_(databases, metadata, text));
  if (!opened.ok) logError_('views.open に失敗: ' + opened.error, null);
  return textResponse_('');
}

/**
 * ⚡ メニューのショートカットから呼ばれたとき。設定モーダルを開く。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleGlobalShortcut_(config, payload) {
  if (payload.callback_id !== SETTINGS_SHORTCUT_CALLBACK_ID) return textResponse_('');
  var triggerId = payload.trigger_id;
  if (!triggerId) return textResponse_('');

  var missing = missingConfigKeys_(config);
  if (missing.length) {
    logError_('必須のスクリプトプロパティが未設定: ' + missing.join(', '), null);
    if (config.slackBotToken) {
      openModal_(config, triggerId, buildNoticeModal_(
          '設定が未完了です',
          '次のスクリプトプロパティを設定してください。\n`' + missing.join('`, `') + '`'));
    }
    return textResponse_('');
  }

  var view = settingsViewFor_(config, userId_(payload));
  var opened = openModal_(config, triggerId, view);
  if (!opened.ok) logError_('views.open に失敗: ' + opened.error, null);
  return textResponse_('');
}

/**
 * モーダル内のボタンが押されたとき。「データベースを登録」だけを扱う。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleBlockActions_(config, payload) {
  var actions = payload.actions || [];
  var opensSettings = actions.some(function (action) {
    return action && action.action_id === OPEN_SETTINGS_ACTION_ID;
  });
  if (!opensSettings || !payload.trigger_id) return textResponse_('');

  var pushed = pushModal_(config, payload.trigger_id, settingsViewFor_(config, userId_(payload)));
  if (!pushed.ok) logError_('views.push に失敗: ' + pushed.error, null);
  return textResponse_('');
}

/**
 * 設定モーダル、または開けない理由を伝えるモーダルを組み立てる。
 * @param {!Object} config
 * @param {string} userId
 * @return {!Object}
 */
function settingsViewFor_(config, userId) {
  var catalog = getDatabases_(config);
  if (!catalog.length) {
    return buildNoticeModal_(
        '選べるDBがありません',
        'Notion側でデータベースをこのインテグレーションに共有してください。\n' +
        'タイトル列を持つデータベースだけが候補になります。');
  }
  return buildSettingsModal_(catalog, readUserDatabaseIds_(config, userId));
}

/**
 * モーダルが送信されたとき。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleViewSubmission_(config, payload) {
  var view = payload.view || {};
  if (view.callback_id === SETTINGS_MODAL_CALLBACK_ID) {
    return handleSettingsSubmission_(config, payload);
  }
  if (view.callback_id !== MODAL_CALLBACK_ID) return textResponse_('');
  return handleTaskSubmission_(config, payload);
}

/**
 * 設定モーダルの保存。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleSettingsSubmission_(config, payload) {
  var userId = userId_(payload);
  if (!userId) return textResponse_('');

  var catalog = getDatabases_(config);
  // 画面に出していない（＝選べないはずの）IDが送られてきても弾く。
  var databases = filterDatabasesByIds_(catalog, readRegisteredDatabaseIds_(payload.view || {}));
  var ids = databases.map(function (database) { return database.id; });

  try {
    saveUserDatabaseIds_(userId, ids);
  } catch (err) {
    logError_('登録内容の保存に失敗', err);
    var errors = {};
    errors[SETTINGS_BLOCK_ID] = '保存に失敗しました。時間をおいてもう一度お試しください。';
    return jsonResponse_({ response_action: 'errors', errors: errors });
  }

  return jsonResponse_({
    response_action: 'update',
    view: buildSettingsSavedModal_(databases)
  });
}

/**
 * タスク追加モーダルの送信。ここでNotionにページを作る。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleTaskSubmission_(config, payload) {
  var view = payload.view || {};
  var databaseId = readSelectedDatabaseId_(view);
  if (!databaseId) {
    return jsonResponse_(buildValidationError_('データベースを選択してください。'));
  }

  var database = findUserDatabase_(config, userId_(payload), databaseId);
  if (!database) {
    return jsonResponse_(buildValidationError_(
        '選択したデータベースが見つかりません。⚡ メニューの「Notion DBの設定」から登録し直してください。'));
  }

  // AIの解析とNotionへの書き込みは3秒に収まらないので、ここでは預けるだけにする。
  var metadata = safeJsonParse_(view.private_metadata) || {};
  var job = {
    uid: userId_(payload),
    db: database.id,
    k: String(metadata.k || ''),
    t: String(metadata.t || 'Slackメッセージ'),
    th: truncate_(String((readCache_(String(metadata.k || '')) || {}).text || ''), 1000),
    u: String(metadata.u || ''),
    c: String(metadata.c || ''),
    a: String(metadata.a || ''),
    n: String(metadata.n || ''),
    d: String(metadata.d || ''),
    r: String(metadata.r || '')
  };

  try {
    enqueueJob_(job);
  } catch (err) {
    logError_('ジョブの保存に失敗', err);
    return jsonResponse_(buildValidationError_(
        '受け付けに失敗しました。時間をおいてもう一度お試しください。'));
  }
  scheduleQueueRun_();

  postToResponseUrl_(job.r, '⏳ *' + database.title + '* に追加しています…');
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
  if (task.dueDate) text += '（期限: ' + task.dueDate + '）';
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

/**
 * 操作した人のSlackユーザーID。
 * @param {!Object} payload
 * @return {string}
 */
function userId_(payload) {
  return String(((payload && payload.user) || {}).id || '');
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
