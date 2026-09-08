/**
 * エディタから手で実行するための補助関数。Slackからは呼ばれない。
 */

/**
 * 設定状況を確認する。値そのものは伏せて、設定済みかどうかだけ出す。
 * Apps Scriptエディタで実行してログを見る。
 */
function showSetupStatus() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var config = readConfig_(props);
  var lines = ['--- 設定状況 ---'];
  [
    PROP_KEYS.slackBotToken,
    PROP_KEYS.slackVerificationToken,
    PROP_KEYS.webhookSecret,
    PROP_KEYS.notionToken
  ].forEach(function (key) {
    lines.push(key + ': ' + (props[key] ? '設定済み (' + String(props[key]).length + '文字)' : '未設定'));
  });
  lines.push(PROP_KEYS.notionVersion + ': ' + config.notionVersion);
  lines.push(PROP_KEYS.databaseAllowlist + ': ' +
      (config.databaseAllowlist.length ? config.databaseAllowlist.length + '件' : '未設定（全件）'));
  lines.push(PROP_KEYS.urlPropertyName + ': ' + (config.urlPropertyName || '未設定（自動判定）'));

  var missing = missingConfigKeys_(config);
  lines.push(missing.length ? '⚠ 未設定の必須項目: ' + missing.join(', ') : '✅ 必須項目はすべて設定済み');

  var snapshot = safeJsonParse_(config.databaseCacheRaw);
  lines.push('データベースのキャッシュ: ' + (snapshot && snapshot.databases
      ? snapshot.databases.length + '件 (更新: ' + snapshot.updatedAt + ')'
      : 'なし'));
  console.log(lines.join('\n'));
}

/**
 * Notionのデータベース一覧を取り直す。時間主導トリガーの実行対象。
 */
function refreshDatabaseCache() {
  var config = readConfig_(PropertiesService.getScriptProperties().getProperties());
  var result = refreshDatabases_(config);
  if (!result.ok) throw new Error('Notionの検索に失敗しました: ' + result.error);
  console.log(result.databases.length + '件のデータベースを取得しました。');
  result.databases.forEach(function (database) {
    console.log('  - ' + database.title + ' (' + database.id + ') ' +
        'タイトル列: ' + database.titleProperty +
        (database.urlProperty ? ' / URL列: ' + database.urlProperty : ''));
  });
}

/**
 * 1時間ごとにデータベース一覧を取り直すトリガーを作る。
 * モーダルを開くときにNotionを呼ばずに済ませるための仕込み。
 */
function installDatabaseRefreshTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'refreshDatabaseCache') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('refreshDatabaseCache').timeBased().everyHours(1).create();
  console.log('トリガーを作成しました: refreshDatabaseCache (1時間ごと)');
  refreshDatabaseCache();
}

/**
 * 誰がどのデータベースを登録しているかを一覧する（管理用）。
 */
function listUserRegistrations() {
  var config = readConfig_(PropertiesService.getScriptProperties().getProperties());
  var users = listRegisteredUsers_(config);
  if (!users.length) {
    console.log('登録している利用者はいません。');
    return;
  }
  var catalog = getDatabases_(config);
  console.log(users.length + '人が登録しています。');
  users.forEach(function (user) {
    var names = filterDatabasesByIds_(catalog, user.ids).map(function (database) {
      return database.title;
    });
    var unknown = user.ids.length - names.length;
    console.log('  - ' + user.userId + ': ' + (names.join(' / ') || 'なし') +
        (unknown > 0 ? '（共有が外れたDB ' + unknown + '件）' : '') +
        ' [更新: ' + (user.updatedAt || '不明') + ']');
  });
}

/**
 * 指定した利用者の登録を消す（退職者の整理など）。
 * @param {string} userId SlackのユーザーID（例: U0123ABCD）。
 */
function deleteUserRegistration(userId) {
  if (!userId) throw new Error('SlackのユーザーIDを渡してください。');
  PropertiesService.getScriptProperties().deleteProperty(userPropertyKey_(userId));
  console.log(userId + ' の登録を削除しました。');
}

/**
 * キャッシュを捨てる。データベースを追加/共有した直後の確認に使う。
 */
function clearCaches() {
  try {
    CacheService.getScriptCache().remove(DATABASE_CACHE_KEY);
  } catch (err) {
    logError_('キャッシュの削除に失敗', err);
  }
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.databaseCache);
  console.log('キャッシュを削除しました。');
}
