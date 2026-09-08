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
  lines.push(PROP_KEYS.geminiApiKey + ': ' +
      (props[PROP_KEYS.geminiApiKey] ? '設定済み（AIでタスク名と期限を抽出します）' : '未設定（本文の1行目をタスク名にします）'));
  lines.push(PROP_KEYS.geminiModel + ': ' + config.geminiModel);
  lines.push(PROP_KEYS.geminiThinkingBudget + ': ' +
      (config.geminiThinkingBudget < 0 ? '送らない（モデルの既定）' : config.geminiThinkingBudget));
  lines.push(PROP_KEYS.notionVersion + ': ' + config.notionVersion);
  lines.push(PROP_KEYS.databaseAllowlist + ': ' +
      (config.databaseAllowlist.length ? config.databaseAllowlist.length + '件' : '未設定（全件）'));
  lines.push(PROP_KEYS.urlPropertyName + ': ' + (config.urlPropertyName || '未設定（自動判定）'));
  lines.push(PROP_KEYS.duePropertyName + ': ' + (config.duePropertyName || '未設定（自動判定）'));
  lines.push(PROP_KEYS.assigneePropertyName + ': ' + (config.assigneePropertyName || '未設定（自動判定）'));
  lines.push(PROP_KEYS.priorityPropertyName + ': ' + (config.priorityPropertyName || '未設定（自動判定）'));
  lines.push(PROP_KEYS.donePropertyName + ': ' + (config.donePropertyName || '未設定（自動判定）'));
  lines.push(PROP_KEYS.doneValueName + ': ' + (config.doneValueName || '未設定（自動判定）'));

  var missing = missingConfigKeys_(config);
  lines.push(missing.length ? '⚠ 未設定の必須項目: ' + missing.join(', ') : '✅ 必須項目はすべて設定済み');

  var snapshot = safeJsonParse_(config.databaseCacheRaw);
  lines.push('データベースのキャッシュ: ' + (snapshot && snapshot.databases
      ? snapshot.databases.length + '件 (更新: ' + snapshot.updatedAt + ')'
      : 'なし'));

  var userSnapshot = safeJsonParse_(config.notionUserCacheRaw);
  lines.push('Notionメンバーのキャッシュ: ' + (userSnapshot && userSnapshot.users
      ? userSnapshot.users.length + '人 (更新: ' + userSnapshot.updatedAt + ')'
      : 'なし'));

  var handlers = ScriptApp.getProjectTriggers().map(function (trigger) {
    return trigger.getHandlerFunction();
  });
  lines.push('トリガー: ' + (handlers.length ? handlers.join(', ') : 'なし'));
  if (handlers.indexOf('refreshCaches') === -1 || handlers.indexOf(QUEUE_SWEEP_HANDLER) === -1) {
    lines.push('⚠ installTriggers を実行してください');
  }
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
    var columns = ['タイトル列: ' + database.titleProperty];
    if (database.urlProperty) columns.push('URL列: ' + database.urlProperty);
    if (database.dueProperty) columns.push('期限列: ' + database.dueProperty);
    if (database.assigneeProperty) columns.push('担当者列: ' + database.assigneeProperty);
    if (database.priorityProperty) {
      columns.push('優先度列: ' + database.priorityProperty.name +
          ' [' + database.priorityProperty.options.join(', ') + ']');
    }
    if (database.doneProperty) {
      columns.push('完了列: ' + database.doneProperty.name +
          (database.doneProperty.doneValue ? ' → ' + database.doneProperty.doneValue : ' (チェック)'));
    }
    console.log('  - ' + database.title + ' (' + database.id + ') ' + columns.join(' / '));
  });
}

/**
 * Notionのメンバー一覧を取り直す。担当者の突き合わせに使う。
 */
function refreshNotionUserCache() {
  var config = readConfig_(PropertiesService.getScriptProperties().getProperties());
  var result = refreshNotionUsers_(config);
  if (!result.ok) throw new Error('Notionのメンバー取得に失敗しました: ' + result.error);
  console.log(result.users.length + '人のメンバーを取得しました（メールがある人のみ）。');
}

/**
 * データベース一覧とメンバー一覧をまとめて取り直す。時間主導トリガーの実行対象。
 */
function refreshCaches() {
  refreshDatabaseCache();
  try {
    refreshNotionUserCache();
  } catch (err) {
    // 担当者を使わない運用でも一覧更新は止めない。
    logError_('メンバー一覧の更新に失敗', err);
  }
}

/**
 * 必要なトリガーをまとめて作る。初回セットアップで1回実行する。
 *
 * - refreshDatabaseCache: 1時間ごと。データベース一覧を取り直す
 * - sweepQueuedTasks: 5分ごと。取りこぼしたジョブを拾う保険
 *
 * 送信直後の処理は、そのつど作られる使い捨てトリガーが行う。
 */
function installTriggers() {
  var managed = ['refreshDatabaseCache', 'refreshCaches', QUEUE_SWEEP_HANDLER];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (managed.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('refreshCaches').timeBased().everyHours(1).create();
  ScriptApp.newTrigger(QUEUE_SWEEP_HANDLER).timeBased().everyMinutes(5).create();
  console.log('トリガーを作成しました: refreshCaches (1時間ごと) / ' +
      QUEUE_SWEEP_HANDLER + ' (5分ごと)');
  refreshCaches();
}

/**
 * 未処理のジョブを確認する。動かないときの切り分け用。
 */
function showQueue() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var jobs = [];
  for (var key in all) {
    if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
    if (key.indexOf(JOB_PROPERTY_PREFIX) !== 0) continue;
    jobs.push(safeJsonParse_(all[key]) || {});
  }
  if (!jobs.length) {
    console.log('未処理のジョブはありません。');
    return;
  }
  console.log(jobs.length + '件が未処理です。');
  jobs.forEach(function (job) {
    console.log('  - ' + (job.t || '(名前なし)') + ' / 依頼者: ' + (job.uid || '不明') +
        ' / 受付: ' + (job.q ? new Date(job.q).toISOString() : '不明'));
  });
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
