/**
 * 「自分のタスク」一覧と、完了操作。
 *
 * 一覧はNotionを複数回引くので3秒に収まらない。先に読み込み中のモーダルを開き、
 * キュー側で集め終わってから views.update で中身を差し替える。
 */

/**
 * ⚡ メニューから「自分のタスク」が呼ばれたとき。
 * @param {!Object} config
 * @param {!Object} payload
 * @return {!Object}
 */
function handleTaskListShortcut_(config, payload) {
  var userId = userId_(payload);
  var opened = openModal_(config, payload.trigger_id,
      buildLoadingModal_('Notionからタスクを読み込んでいます…'));
  if (!opened.ok) {
    logError_('一覧モーダルを開けませんでした: ' + opened.error, null);
    return textResponse_('');
  }

  var viewId = ((opened.body.view || {}).id) || '';
  if (!viewId) return textResponse_('');

  try {
    enqueueJob_({ type: 'list', uid: userId, view: viewId });
  } catch (err) {
    logError_('一覧ジョブの保存に失敗', err);
    updateModal_(config, viewId,
        buildNoticeModal_('読み込めませんでした', '時間をおいてもう一度お試しください。'));
    return textResponse_('');
  }
  scheduleQueueRun_();
  return textResponse_('');
}

/**
 * 一覧を集めてモーダルを差し替える。キューから呼ばれる。
 * @param {!Object} config
 * @param {!Object} job
 */
function processListJob_(config, job) {
  var viewId = String(job.view || '');
  if (!viewId) return;

  var result = collectOpenTasks_(config, String(job.uid || ''));
  if (!result.ok) {
    updateModal_(config, viewId, buildNoticeModal_('読み込めませんでした', result.error));
    return;
  }
  updateModal_(config, viewId, buildTaskListModal_(result.tasks, {
    truncated: result.truncated,
    skipped: result.skipped
  }));
}

/**
 * 登録済みのデータベースを横断して、自分が担当の未完了タスクを集める。
 * @param {!Object} config
 * @param {string} slackUserId
 * @return {{ok: boolean, error: string, tasks: !Array<!Object>,
 *           truncated: boolean, skipped: !Array<string>}}
 */
function collectOpenTasks_(config, slackUserId) {
  var failed = function (message) {
    return { ok: false, error: message, tasks: [], truncated: false, skipped: [] };
  };

  var databases = getUserDatabases_(config, slackUserId);
  if (!databases.length) {
    return failed('追加先のデータベースが未登録です。\n' +
        '⚡ メニューの「Notion DBの設定」から登録してください。');
  }

  var email = lookupUserEmail_(config, slackUserId);
  var notionUser = email ? findNotionUserByEmail_(config, email) : null;
  if (!notionUser) {
    return failed('Notion側であなたを特定できませんでした。\n' +
        'SlackとNotionで同じメールアドレスを使っているか確認してください。');
  }

  var tasks = [];
  var skipped = [];
  var errors = [];
  var targets = databases.slice(0, MAX_TASK_LIST_DATABASES);

  for (var i = 0; i < targets.length; i++) {
    var database = targets[i];
    if (!database.assigneeProperty || !database.doneProperty) {
      skipped.push(database.title);
      continue;
    }
    var result = queryOpenTasks_(config, database, notionUser.id, MAX_TASK_LIST_ITEMS);
    if (!result.ok) {
      logError_('タスクの取得に失敗（' + database.title + '）: ' + result.error, null);
      errors.push(database.title);
      continue;
    }
    tasks = tasks.concat(result.tasks);
  }

  if (!tasks.length && errors.length && errors.length === targets.length) {
    return failed('Notionからの取得に失敗しました: ' + errors.join(' / '));
  }
  if (databases.length > targets.length) {
    skipped.push('ほか' + (databases.length - targets.length) + '件（一度に見るのは' +
        MAX_TASK_LIST_DATABASES + 'DBまで）');
  }

  return {
    ok: true,
    error: '',
    tasks: sortTasksByDueDate_(tasks).slice(0, MAX_TASK_LIST_ITEMS),
    truncated: tasks.length > MAX_TASK_LIST_ITEMS,
    skipped: skipped
  };
}

/**
 * 期限の近い順。期限なしは後ろ（純粋関数）。
 * @param {!Array<!Object>} tasks
 * @return {!Array<!Object>}
 */
function sortTasksByDueDate_(tasks) {
  return tasks.slice().sort(function (a, b) {
    if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : (a.dueDate > b.dueDate ? 1 : 0);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
}

/**
 * 「完了にする」ボタンが押されたとき。
 * 一覧の中ならその行だけ差し替え、通知メッセージからならSlackに結果を返す。
 * @param {!Object} config
 * @param {!Object} payload
 * @param {!Object} action
 * @return {!Object}
 */
function handleCompleteAction_(config, payload, action) {
  var target = safeJsonParse_(action.value) || {};
  if (!target.p) return textResponse_('');

  var database = pickDatabase_(getDatabases_(config), normalizeNotionId_(String(target.d || '')));
  var result = database
      ? completeNotionTask_(config, database, String(target.p))
      : { ok: false, error: '追加先のデータベースが見つかりませんでした', url: '' };

  var view = payload.view || {};
  if (view.id) {
    updateModal_(config, view.id, result.ok
        ? completedListView_(view, 'task_' + target.p)
        : buildNoticeModal_('完了にできませんでした', result.error));
    return textResponse_('');
  }

  postToResponseUrl_(String(payload.response_url || ''), result.ok
      ? '✅ Notionのタスクを完了にしました。'
      : '⚠️ 完了にできませんでした: ' + result.error);
  return textResponse_('');
}

/**
 * 一覧モーダルの該当行だけを「完了」表示に置き換える（純粋関数）。
 * 再取得せずに済むよう、いま表示しているブロックをそのまま使う。
 * @param {!Object} view block_actions が持ってきた現在のモーダル。
 * @param {string} blockId
 * @return {!Object}
 */
function completedListView_(view, blockId) {
  var blocks = (view.blocks || []).map(function (block) {
    return block.block_id === blockId ? markRowCompleted_(block) : block;
  });
  return {
    type: 'modal',
    callback_id: view.callback_id || 'notion_task_list',
    title: view.title || { type: 'plain_text', text: '自分のタスク', emoji: true },
    close: view.close || { type: 'plain_text', text: '閉じる', emoji: true },
    blocks: blocks
  };
}
