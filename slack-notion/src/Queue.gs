/**
 * 非同期処理のキュー。
 *
 * AIの解析（1〜2秒）とNotionへの書き込みをSlackへの応答中にやると
 * 3秒制限を超えてしまうため、送信時はジョブを預けてすぐ返し、
 * 直後に走る使い捨てトリガーで実際の作成を行う。
 */

var JOB_PROPERTY_PREFIX = 'JOB_';

/** 使い捨てトリガー（送信直後に1回だけ走る）と、取りこぼし用の定期トリガー。 */
var QUEUE_TRIGGER_HANDLER = 'runQueuedTasksNow';
var QUEUE_SWEEP_HANDLER = 'sweepQueuedTasks';

/** 1回の実行で処理する上限。GASの6分制限に余裕を持たせる。 */
var MAX_JOBS_PER_RUN = 10;
var MAX_RUN_MILLIS = 240000;

/** 待機中の使い捨てトリガーの上限（GASのトリガー数上限は20）。 */
var MAX_PENDING_QUEUE_TRIGGERS = 5;

/**
 * ジョブを預ける。
 * スクリプトプロパティは1件9KBまでなので、本文はキャッシュ側に置き、
 * ここには先頭だけを保険として持つ。
 * @param {!Object} job
 * @return {string} 預けたキー。
 */
function enqueueJob_(job) {
  var key = JOB_PROPERTY_PREFIX + Utilities.getUuid();
  job.q = Date.now();
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(job));
  return key;
}

/**
 * 直後に1回だけ走るトリガーを作る。
 * 溜まりすぎているときは作らない（既存のトリガーがまとめて処理する）。
 * @return {boolean} 作れたかどうか。
 */
function scheduleQueueRun_() {
  try {
    var pending = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === QUEUE_TRIGGER_HANDLER;
    });
    if (pending.length >= MAX_PENDING_QUEUE_TRIGGERS) return false;
    ScriptApp.newTrigger(QUEUE_TRIGGER_HANDLER).timeBased().after(1000).create();
    return true;
  } catch (err) {
    logError_('処理トリガーの作成に失敗', err);
    return false;
  }
}

/** 送信直後に走る。処理し終えて空になったら自分たちを片付ける。 */
function runQueuedTasksNow() {
  drainQueue_();
  deleteFinishedQueueTriggers_();
}

/**
 * 取りこぼし用。定期的に走ってキューを空にする。
 * 発火済みのまま残った使い捨てトリガーもここで片付ける。
 * （溜まったままだと上限に当たり、次の送信で即時処理を作れなくなる）
 */
function sweepQueuedTasks() {
  drainQueue_();
  deleteFinishedQueueTriggers_();
}

/**
 * キューに溜まったジョブを処理する。
 * 同じジョブを2回処理しないよう、ロックを取り、取り出した時点で消す。
 */
function drainQueue_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    var startedAt = Date.now();
    var store = PropertiesService.getScriptProperties();
    var all = store.getProperties();
    var config = readConfig_(all);

    var jobs = [];
    for (var key in all) {
      if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
      if (key.indexOf(JOB_PROPERTY_PREFIX) !== 0) continue;
      jobs.push({ key: key, job: safeJsonParse_(all[key]) });
    }
    jobs.sort(function (a, b) {
      return ((a.job && a.job.q) || 0) - ((b.job && b.job.q) || 0);
    });

    for (var i = 0; i < jobs.length && i < MAX_JOBS_PER_RUN; i++) {
      if (Date.now() - startedAt > MAX_RUN_MILLIS) break;
      // 取り出した時点で消す。失敗しても無限に再試行しない。
      store.deleteProperty(jobs[i].key);
      if (!jobs[i].job) continue;
      try {
        processJob_(config, jobs[i].job);
      } catch (err) {
        logError_('タスクの作成に失敗', err);
        postToResponseUrl_(jobs[i].job.r,
            '⚠️ Notionへの追加に失敗しました。時間をおいてもう一度お試しください。');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * ジョブを1件処理する。AIで名前と期限を読み取り、Notionにページを作る。
 * @param {!Object} config
 * @param {!Object} job
 */
function processJob_(config, job) {
  var database = findUserDatabase_(config, job.uid, job.db);
  if (!database) {
    postToResponseUrl_(job.r,
        '⚠️ 追加先のデータベースが見つかりませんでした。⚡ メニューの「Notion DBの設定」を確認してください。');
    return;
  }

  var cached = readCache_(String(job.k || '')) || {};
  var messageText = String(cached.text || job.th || '');
  var task = {
    title: String(job.t || 'Slackメッセージ'),
    text: messageText,
    rawText: messageText,
    threadCount: 0,
    permalink: String(job.u || ''),
    channelName: String(job.c || ''),
    authorName: String(job.n || '') || lookupUserName_(config, String(job.a || '')),
    postedAt: String(job.d || ''),
    dueDate: '',
    priority: '',
    assigneeName: '',
    assigneeNotionUserId: ''
  };

  // スレッド内のメッセージなら、会話全体を読んで判断する。
  if (job.tt) {
    var messages = fetchThreadMessages_(config, String(job.ch || ''), String(job.tt || ''));
    if (messages) {
      var thread = buildThreadTranscript_(config, messages);
      if (thread.count > 1) {
        task.text = thread.transcript;
        task.rawText = thread.raw;
        task.threadCount = thread.count;
      }
    }
  }

  // 追加先に該当する列があるときだけ、担当者と優先度も読み取らせる。
  var candidates = database.assigneeProperty
      ? buildAssigneeCandidates_(config, task.rawText, job)
      : [];
  var priorityOptions = (database.priorityProperty || {}).options || [];

  // AIが使えないときや読み取れなかったときは、本文の1行目をそのまま使う。
  var extracted = extractTaskFields_(config, {
    text: task.text,
    postedAt: task.postedAt,
    channelName: task.channelName,
    authorName: task.authorName,
    assigneeCandidates: candidates,
    priorityOptions: priorityOptions
  });
  if (extracted.ok) {
    if (extracted.title) task.title = extracted.title;
    task.dueDate = extracted.dueDate;
    task.priority = extracted.priority;
  }

  if (database.assigneeProperty) {
    applyAssignee_(config, task, extracted.assignee || defaultAssigneeId_(candidates, job));
  }

  var result = createNotionTask_(config, database, task);
  if (!result.ok) {
    postToResponseUrl_(job.r, '⚠️ Notionへの追加に失敗しました: ' + result.error);
    return;
  }
  var message = buildSuccessMessage_(database, task, result.url);
  postToResponseUrl_(job.r, message, buildCreatedBlocks_(message, {
    pageId: result.pageId,
    databaseId: database.id,
    title: task.title,
    dueDate: task.dueDate
  }));
}

/**
 * 担当者になりうる人を、メンション → 投稿者 → 追加した人の順に並べる。
 * @param {!Object} config
 * @param {string} rawText Slackの生の本文。
 * @param {!Object} job
 * @return {!Array<{id: string, name: string, role: string}>}
 */
function buildAssigneeCandidates_(config, rawText, job) {
  var mentioned = extractMentionedUserIds_(rawText);
  var entries = mentioned.map(function (id) {
    return { id: id, role: 'メンションされた人' };
  });
  addCandidate_(entries, String(job.a || ''), 'メッセージの投稿者');
  addCandidate_(entries, String(job.uid || ''), 'タスクを追加した人');

  return entries.slice(0, 5).map(function (entry) {
    return { id: entry.id, name: lookupUserName_(config, entry.id), role: entry.role };
  });
}

/**
 * @param {!Array<!Object>} entries
 * @param {string} id
 * @param {string} role
 */
function addCandidate_(entries, id, role) {
  if (!id) return;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].id === id) return;
  }
  entries.push({ id: id, role: role });
}

/**
 * AIが選ばなかったときの担当者。名指しされた人がいればその人、いなければ追加した人。
 * @param {!Array<!Object>} candidates
 * @param {!Object} job
 * @return {string}
 */
function defaultAssigneeId_(candidates, job) {
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].role === 'メンションされた人') return candidates[i].id;
  }
  return String(job.uid || '');
}

/**
 * SlackユーザーIDをメールアドレス経由でNotionのメンバーに突き合わせる。
 * 突き合わせられなければ担当者は空のままにする。
 * @param {!Object} config
 * @param {!Object} task 書き換える対象。
 * @param {string} slackUserId
 */
function applyAssignee_(config, task, slackUserId) {
  if (!slackUserId) return;
  var email = lookupUserEmail_(config, slackUserId);
  if (!email) return;
  var notionUser = findNotionUserByEmail_(config, email);
  if (!notionUser) {
    logError_('Notionに同じメールのメンバーがいません: ' + email, null);
    return;
  }
  task.assigneeNotionUserId = notionUser.id;
  task.assigneeName = notionUser.name || lookupUserName_(config, slackUserId);
}

/**
 * キューが空になっていれば、使い捨てトリガーをまとめて消す。
 * 空でなければ残す（まだ処理すべきジョブがあるため）。
 */
function deleteFinishedQueueTriggers_() {
  try {
    if (hasQueuedJobs_()) return;
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  } catch (err) {
    logError_('使い終わったトリガーの削除に失敗', err);
  }
}

/**
 * @return {boolean} 未処理のジョブが残っているか。
 */
function hasQueuedJobs_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  for (var key in all) {
    if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
    if (key.indexOf(JOB_PROPERTY_PREFIX) === 0) return true;
  }
  return false;
}
