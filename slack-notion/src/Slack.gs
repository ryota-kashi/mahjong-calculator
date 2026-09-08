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
 * Slack Web API を呼ぶ。
 * @param {!Object} config
 * @param {string} method 例: 'views.open'
 * @param {!Object} payload
 * @return {{ok: boolean, error: string, body: !Object}}
 */
function callSlackApi_(config, method, payload) {
  var response = UrlFetchApp.fetch(SLACK_API_BASE + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + config.slackBotToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
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
    result = callSlackApi_(config, 'users.info', { user: userId });
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
 * response_url に本人だけに見えるメッセージを返す。
 * @param {string} responseUrl
 * @param {string} text
 */
function postToResponseUrl_(responseUrl, text) {
  if (!responseUrl) return;
  try {
    UrlFetchApp.fetch(responseUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: text }),
      muteHttpExceptions: true
    });
  } catch (err) {
    logError_('response_url への通知に失敗', err);
  }
}
