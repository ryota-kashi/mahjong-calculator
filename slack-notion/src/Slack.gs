/**
 * Slack Web API とのやり取り。
 */

var SLACK_API_BASE = 'https://slack.com/api/';

/**
 * リクエストがSlackから来たものか確かめる。
 *
 * Apps Script の doPost はリクエストヘッダーを読めないため、署名
 * (X-Slack-Signature) による検証ができない。代わりに
 *   1) ペイロードに含まれる Verification Token
 *   2) リクエストURLに付けた合言葉（?s=...）
 * の2つで照合する。詳しくは README の「既知の制約」を参照。
 *
 * @param {!Object} config
 * @param {!Object} e doPost のイベント。
 * @param {!Object} payload パース済みのペイロード。
 * @return {{ok: boolean, error: string}}
 */
function verifyRequest_(config, e, payload) {
  if (config.webhookSecret) {
    var provided = (e && e.parameter && e.parameter.s) || '';
    if (!secureEquals_(provided, config.webhookSecret)) {
      return { ok: false, error: 'WEBHOOK_SECRET が一致しません' };
    }
  }
  if (!config.slackVerificationToken) {
    return { ok: false, error: 'SLACK_VERIFICATION_TOKEN が未設定です' };
  }
  if (!secureEquals_(String(payload.token || ''), config.slackVerificationToken)) {
    return { ok: false, error: 'Verification Token が一致しません' };
  }
  return { ok: true, error: '' };
}

/**
 * 実行時間が入力に依存しない文字列比較。
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function secureEquals_(a, b) {
  var left = String(a == null ? '' : a);
  var right = String(b == null ? '' : b);
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Slack Web API を JSON で呼ぶ。views.* や chat.* 向け。
 * @param {!Object} config
 * @param {string} method 例: 'views.open'
 * @param {!Object} payload
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function callSlackApi_(config, method, payload) {
  return requestSlack_(config, method, {
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload)
  });
}

/**
 * Slack Web API をフォーム形式で呼ぶ。
 * users.info や conversations.replies のような取得系は
 * application/x-www-form-urlencoded しか受け付けないため、こちらを使う。
 * @param {!Object} config
 * @param {string} method 例: 'users.info'
 * @param {!Object<string,string>} params
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function callSlackFormApi_(config, method, params) {
  return requestSlack_(config, method, { payload: params });
}

/**
 * @param {!Object} config
 * @param {string} method
 * @param {!Object} options UrlFetchApp に渡す追加のオプション。
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function requestSlack_(config, method, options) {
  var request = {
    method: 'post',
    headers: { Authorization: 'Bearer ' + config.slackBotToken },
    muteHttpExceptions: true
  };
  for (var key in options) {
    if (Object.prototype.hasOwnProperty.call(options, key)) request[key] = options[key];
  }
  var response = UrlFetchApp.fetch(SLACK_API_BASE + method, request);
  var body = safeJsonParse_(response.getContentText()) || {};
  if (!body.ok) {
    return { ok: false, error: String(body.error || 'unknown_error'), body: body };
  }
  return { ok: true, error: '', body: body };
}

/**
 * モーダルを開く。trigger_id は発行から3秒で失効するので最短経路で呼ぶ。
 * @param {!Object} config
 * @param {string} triggerId
 * @param {!Object} view
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function openModal_(config, triggerId, view) {
  return callSlackApi_(config, 'views.open', { trigger_id: triggerId, view: view });
}

/**
 * 開いているモーダルの上に別のモーダルを重ねる。
 * @param {!Object} config
 * @param {string} triggerId
 * @param {!Object} view
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function pushModal_(config, triggerId, view) {
  return callSlackApi_(config, 'views.push', { trigger_id: triggerId, view: view });
}

/**
 * 投稿者の表示名を返す。users.info の結果はキャッシュする。
 * @param {!Object} config
 * @param {string} userId
 * @return {string} 取得できない場合はユーザーID。
 */
function lookupUserName_(config, userId) {
  if (!userId) return '';
  var cacheKey = 'slack_user_' + userId;
  var cached = readCache_(cacheKey);
  if (cached && cached.name) return cached.name;

  var result;
  try {
    result = callSlackFormApi_(config, 'users.info', { user: userId });
  } catch (err) {
    return userId;
  }
  if (!result.ok) return userId;

  var user = result.body.user || {};
  var profile = user.profile || {};
  var name = profile.display_name || profile.real_name || user.real_name || user.name || userId;
  writeCache_(cacheKey, { name: name }, USER_CACHE_TTL_SECONDS);
  return name;
}

/**
 * ユーザーのメールアドレスを返す。Notionのメンバーと突き合わせるために使う。
 * users:read.email スコープが要る。取れなければ空文字。
 * @param {!Object} config
 * @param {string} userId
 * @return {string}
 */
function lookupUserEmail_(config, userId) {
  if (!userId) return '';
  var cacheKey = 'slack_email_' + userId;
  var cached = readCache_(cacheKey);
  if (cached) return cached.email || '';

  var result;
  try {
    result = callSlackFormApi_(config, 'users.info', { user: userId });
  } catch (err) {
    logError_('users.info の呼び出しに失敗', err);
    return '';
  }
  if (!result.ok) {
    logError_('users.info が失敗: ' + result.error, null);
    return '';
  }
  var email = String((((result.body.user || {}).profile) || {}).email || '').toLowerCase();
  writeCache_(cacheKey, { email: email }, USER_CACHE_TTL_SECONDS);
  return email;
}

/** スレッドから読み込むメッセージ数の上限。 */
var THREAD_MESSAGE_LIMIT = 50;

/** スレッド全体の文字数の上限。 */
var THREAD_TRANSCRIPT_MAX_LENGTH = 12000;

/**
 * スレッドの投稿をまとめて取得する。
 * botがチャンネルに参加していない場合などは取得できないので null を返し、
 * 呼び出し側は元の1件だけで処理を続ける。
 * @param {!Object} config
 * @param {string} channelId
 * @param {string} threadTs
 * @return {?Array<!Object>}
 */
function fetchThreadMessages_(config, channelId, threadTs) {
  if (!channelId || !threadTs) return null;
  var result;
  try {
    result = callSlackFormApi_(config, 'conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: THREAD_MESSAGE_LIMIT
    });
  } catch (err) {
    logError_('conversations.replies の呼び出しに失敗', err);
    return null;
  }
  if (!result.ok) {
    logError_('スレッドを取得できませんでした: ' + result.error +
        '（botがチャンネルに参加しているか、履歴スコープがあるか確認してください）', null);
    return null;
  }
  var messages = result.body.messages || [];
  return messages.length ? messages : null;
}

/**
 * スレッドの投稿を「名前: 本文」の形に並べる。
 * @param {!Object} config
 * @param {!Array<!Object>} messages
 * @return {{transcript: string, raw: string, count: number}}
 */
function buildThreadTranscript_(config, messages) {
  var lines = [];
  var raw = [];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i] || {};
    var body = String(message.text || '').trim();
    if (!body) continue;
    var name = message.username || lookupUserName_(config, String(message.user || '')) || '不明';
    lines.push(name + ': ' + slackTextToPlain_(body));
    raw.push(body);
  }
  return {
    transcript: truncate_(lines.join('\n\n'), THREAD_TRANSCRIPT_MAX_LENGTH),
    raw: raw.join('\n'),
    count: lines.length
  };
}

/**
 * response_url に本人だけに見えるメッセージを返す。
 * @param {string} responseUrl
 * @param {string} text 通知やフォールバックに使う素のテキスト。
 * @param {Array<!Object>=} blocks ボタンなどを付けたい場合のBlock Kit。
 */
function postToResponseUrl_(responseUrl, text, blocks) {
  if (!responseUrl) return;
  var message = { response_type: 'ephemeral', replace_original: false, text: text };
  if (blocks && blocks.length) message.blocks = blocks;
  try {
    UrlFetchApp.fetch(responseUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(message),
      muteHttpExceptions: true
    });
  } catch (err) {
    logError_('response_url への通知に失敗', err);
  }
}
