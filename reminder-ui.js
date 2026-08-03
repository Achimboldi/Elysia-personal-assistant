/**
 * reminder-ui.js — Elysia「提醒」模块（渲染端）
 *
 * 职责：提醒列表页渲染、创建/编辑表单弹窗、暂停/恢复、删除、立即触发、导航角标。
 * 被 app.js require（`const { ReminderUI } = require('./reminder-ui.js')`），
 * 在 AppController.onDOMReady 中调用 init()。
 *
 * 依赖：
 *   - IPC：reminders-get / save / delete / set-enabled / trigger-now；事件 reminders-updated
 *   - 全局：window.__xilianPresets（XilianSettings.init 注入）、
 *           appController.chatRoomManager.chatRooms（聊天室列表）
 */

const { ipcRenderer } = require('electron');

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PERIOD_LABELS = {
  daily: '每天',
  weekly: '每周',
  workday: '工作日',
  restday: '休息日',
  monthly: '每月',
  yearly: '每年'
};
const STATUS_LABELS = {
  pending: '未触发',
  triggered: '已触发',
  paused: '已停用',
  expired: '已过期'
};
const HISTORY_STATUS_LABELS = {
  ok: '成功',
  degraded: '降级',
  failed: '失败'
};

class ReminderUI {
  constructor(appController) {
    this.appController = appController;
    this.reminders = [];
    this.editingId = null;
    this._currentPresetId = '';
    this._scheduleType = 'period';   // period | interval | once
    this._periodType = 'daily';      // daily | weekly | workday | restday | monthly | yearly
  }

  // ============================================================
  // 初始化
  // ============================================================
  init() {
    this.bindEvents();
    this.loadList();
    // 提醒触发 → 昔涟导航红点亮起（由主进程 reminder-fired 广播驱动）
    ipcRenderer.on('reminder-fired', () => {
      const d = document.getElementById('xilianNotifyDot');
      if (d) d.style.display = 'block';
    });
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  bindEvents() {
    const addBtn = document.getElementById('addReminderBtn');
    if (addBtn) addBtn.addEventListener('click', () => this.openForm(null));

    const closeBtn = document.getElementById('closeReminderModal');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeForm());

    const modal = document.getElementById('reminderModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this.closeForm(); });

    const saveBtn = document.getElementById('saveReminderBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveForm());

    const deleteBtn = document.getElementById('deleteReminderBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => this.removeEditing());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeForm();
    });

    // 频率三选一 Tab
    document.querySelectorAll('.reminder-tab').forEach(tab => {
      tab.addEventListener('click', () => this._setScheduleTab(tab.dataset.scheduleType));
    });

    // 周期六选
    document.querySelectorAll('.reminder-period-option').forEach(opt => {
      opt.addEventListener('click', () => this._setPeriodType(opt.dataset.period));
    });

  }

  // ============================================================
  // 列表
  // ============================================================
  async loadList() {
    try {
      const result = await ipcRenderer.invoke('reminders-get');
      this.reminders = (result && result.reminders) || [];
    } catch (e) {
      console.error('[ReminderUI] 加载提醒失败:', e);
      this.reminders = [];
    }
    this.renderList();
  }

  renderList() {
    const container = document.getElementById('remindersList');
    if (!container) return;

    const sorted = [...this.reminders].sort((a, b) => {
      const aOn = a.enabled === false ? 1 : 0;
      const bOn = b.enabled === false ? 1 : 0;
      if (aOn !== bOn) return aOn - bOn;
      const at = a.nextTriggerAt ? new Date(a.nextTriggerAt).getTime() : Infinity;
      const bt = b.nextTriggerAt ? new Date(b.nextTriggerAt).getTime() : Infinity;
      return at - bt;
    });

    if (sorted.length === 0) {
      container.innerHTML =
        '<div class="empty-state reminders-empty">' +
        '<div>暂无提醒</div>' +
        '<div class="empty-tip">点击右上角「新建提醒」，或在聊天中对昔涟说「每天9点提醒我…」</div>' +
        '</div>';
      return;
    }

    container.innerHTML = sorted.map(r => this.renderCard(r)).join('');
    // 事件委托：卡片内按钮
    container.onclick = (e) => this.handleCardClick(e);
  }

  renderCard(r) {
    const status = this.getStatus(r);
    const statusLabel = STATUS_LABELS[status] || status;
    const nextText = r.nextTriggerAt ? this.formatDateTime(r.nextTriggerAt) : '—';
    const freqText = this.describeSchedule(r.schedule);
    const agentTag = r.createdBy === 'agent'
      ? XilianUI.renderCreatorBadge(r.creator || this._resolveHistoryAgentName(r, null) || '智能体')
      : '';
    const promptTag = r.prompt ? '<span class="reminder-prompt-tag">提示词</span>' : '';
    const triggerInfo = r.triggerCount ? ` · 已触发 ${r.triggerCount} 次` : '';
    const historyHtml = this.renderHistory(r);
    const toggleText = r.enabled === false ? '恢复' : '暂停';

    return (
      '<div class="reminder-card" data-id="' + this.escAttr(r.id) + '">' +
        '<div class="reminder-card-header">' +
          '<span class="reminder-card-name">' + this.esc(r.name || '未命名') + '</span>' +
          agentTag +
          promptTag +
          '<span class="reminder-status-badge status-' + status + '">' + statusLabel + '</span>' +
        '</div>' +
        '<div class="reminder-card-meta">' +
          '<span class="reminder-freq">' + this.esc(freqText) + '</span>' +
          '<span class="reminder-target">' + this.esc(this.describeTarget(r)) + '</span>' +
        '</div>' +
        '<div class="reminder-card-next">下次触发：' + this.esc(nextText) + triggerInfo + '</div>' +
        historyHtml +
        '<div class="reminder-card-actions">' +
          '<button type="button" class="reminder-btn" data-action="edit">编辑</button>' +
          '<button type="button" class="reminder-btn" data-action="toggle">' + toggleText + '</button>' +
          '<button type="button" class="reminder-btn" data-action="trigger">立即触发</button>' +
          '<button type="button" class="reminder-btn reminder-btn-danger" data-action="delete">删除</button>' +
        '</div>' +
      '</div>'
    );
  }

  renderHistory(r) {
    const history = Array.isArray(r.history) ? r.history : [];
    if (history.length === 0) return '';
    const items = history.slice(0, 5).map(h => {
      const hs = HISTORY_STATUS_LABELS[h.status] || h.status || '';
      const agentName = this._resolveHistoryAgentName(r, h);
      return (
        '<div class="reminder-history-item">' +
          '<span class="reminder-history-status hs-' + (h.status || 'ok') + '">' + this.esc(hs) + '</span>' +
          '<span class="reminder-history-agent">' + this.esc(agentName) + '</span>' +
          '<span class="reminder-history-time">' + this.esc(this.formatDateTime(h.triggeredAt)) + '</span>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="reminder-card-history">' +
        '<div class="reminder-history-toggle" data-action="toggle-history">执行历史 (' + history.length + ')</div>' +
        '<div class="reminder-history-list" style="display:none;">' + items + '</div>' +
      '</div>'
    );
  }

  // 执行历史仅展示元信息：优先取条目自带 agentName，缺失时按 reminder.agentPresetId 解析预设名，兜底「昔涟」
  _resolveHistoryAgentName(r, h) {
    if (h && h.agentName) return h.agentName;
    const presetId = (r && (r.agentPresetId || r.targetId)) || this._currentPresetId;
    const presets = window.__xilianPresets || [];
    const found = presets.find(p => p.id === presetId);
    return (found && found.name) ? found.name : '昔涟';
  }

  handleCardClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('.reminder-card');
    const id = card ? card.dataset.id : null;
    if (!id) return;
    const action = btn.dataset.action;
    const reminder = this.reminders.find(r => String(r.id) === String(id));
    if (!reminder) return;

    if (action === 'edit') {
      this.openForm(reminder);
    } else if (action === 'toggle') {
      this.toggleEnabled(id);
    } else if (action === 'trigger') {
      this.triggerNow(id);
    } else if (action === 'delete') {
      this.remove(id);
    } else if (action === 'toggle-history') {
      const list = btn.nextElementSibling;
      if (list) list.style.display = list.style.display === 'none' ? 'block' : 'none';
    }
  }

  // ============================================================
  // 状态 / 描述辅助
  // ============================================================
  getStatus(r) {
    if (r.enabled === false) {
      return r.schedule && r.schedule.type === 'once' ? 'expired' : 'paused';
    }
    if (!r.nextTriggerAt) return 'expired';
    if (r.lastTriggeredAt) return 'triggered';
    return 'pending';
  }

  describeSchedule(schedule) {
    if (!schedule || !schedule.type) return '未设置';
    const t = schedule.time || '';
    switch (schedule.type) {
      case 'daily': return '每天 ' + t;
      case 'weekly': {
        const days = (schedule.weekday || []).map(d => WEEKDAY_NAMES[d]).join('、');
        return days ? '每周' + days + ' ' + t : '每周 ' + t;
      }
      case 'workday': return '工作日 ' + t;
      case 'restday': return '休息日 ' + t;
      case 'monthly': return '每月' + schedule.dayOfMonth + '日 ' + t;
      case 'yearly': return '每年' + schedule.month + '月' + schedule.dayOfMonth + '日 ' + t;
      case 'interval': return '每' + schedule.intervalMinutes + '分钟';
      case 'once': return this.formatDateTime(schedule.datetime);
      default: return schedule.type;
    }
  }

  describeTarget(r) {
    if (r.targetType === 'room') return '→ 聊天室';
    return '→ 私聊';
  }

  formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  esc(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  escAttr(str) {
    return this.esc(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================================
  // 表单：打开 / 关闭 / 保存
  // ============================================================
  openForm(reminder) {
    this.editingId = reminder ? String(reminder.id) : null;
    const titleEl = document.getElementById('reminderModalTitle');
    if (titleEl) titleEl.textContent = this.editingId ? '编辑提醒' : '新建提醒';
    const deleteBtn = document.getElementById('deleteReminderBtn');
    if (deleteBtn) deleteBtn.style.display = this.editingId ? 'inline-block' : 'none';

    document.getElementById('reminderName').value = reminder ? (reminder.name || '') : '';
    document.getElementById('reminderPrompt').value = reminder ? (reminder.prompt || '') : '';

    // schedule
    this._resetScheduleUI();
    const s = reminder ? reminder.schedule : null;
    if (s && s.type === 'interval') {
      this._setScheduleTab('interval');
      if (s.intervalMinutes) document.getElementById('reminderIntervalMinutes').value = s.intervalMinutes;
      if (s.startAt) document.getElementById('reminderIntervalStart').value = this._toDateTimeLocal(s.startAt);
    } else if (s && s.type === 'once') {
      this._setScheduleTab('once');
      if (s.datetime) document.getElementById('reminderOnceDatetime').value = this._toDateTimeLocal(s.datetime);
    } else {
      this._setScheduleTab('period');
      const ptype = s && PERIOD_LABELS[s.type] ? s.type : 'daily';
      this._setPeriodType(ptype);
      if (s) {
        if (s.time) {
          document.getElementById('reminderTime').value = s.time;
          if (document.getElementById('reminderWeeklyTime')) document.getElementById('reminderWeeklyTime').value = s.time;
          if (document.getElementById('reminderMonthlyTime')) document.getElementById('reminderMonthlyTime').value = s.time;
          if (document.getElementById('reminderYearlyTime')) document.getElementById('reminderYearlyTime').value = s.time;
        }
        if (Array.isArray(s.weekday)) this._setWeekdayCheckboxes('reminderWeekdayGroup', s.weekday);
        if (s.dayOfMonth) {
          document.getElementById('reminderMonthDay').value = s.dayOfMonth;
          document.getElementById('reminderYearDay').value = s.dayOfMonth;
        }
        if (s.month) document.getElementById('reminderYearMonth').value = s.month;
      }
    }

    // dateRange
    document.getElementById('reminderRangeStart').value =
      reminder && reminder.dateRange && reminder.dateRange.start ? reminder.dateRange.start : '';
    document.getElementById('reminderRangeEnd').value =
      reminder && reminder.dateRange && reminder.dateRange.end ? reminder.dateRange.end : '';

    // 触发频道
    this._populateTargetSelect(reminder);

    this._clearErrors();
    const modal = document.getElementById('reminderModal');
    if (modal) modal.style.display = 'flex';
  }

  closeForm() {
    const modal = document.getElementById('reminderModal');
    if (modal) modal.style.display = 'none';
    this.editingId = null;
  }

  async saveForm() {
    const nameEl = document.getElementById('reminderName');
    const name = nameEl.value.trim();
    const prompt = document.getElementById('reminderPrompt').value.trim();

    this._clearErrors();
    if (!name) {
      this._showError('reminderNameError', '请输入提醒名称');
      nameEl.focus();
      return;
    }
    if (name.length > 50) {
      this._showError('reminderNameError', '名称不能超过 50 字');
      nameEl.focus();
      return;
    }

    const schedule = this._collectSchedule();
    if (!schedule) return;

    // dateRange 校验
    const rangeStart = document.getElementById('reminderRangeStart').value || null;
    const rangeEnd = document.getElementById('reminderRangeEnd').value || null;
    if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
      this._showError('reminderRangeError', '开始日期不能晚于结束日期');
      return;
    }

    // 触发频道（value 形如 private:xxx / room:xxx）
    const targetValue = document.getElementById('reminderTargetSelect').value || '';
    let targetType = 'private';
    let targetId = '';
    if (targetValue) {
      const sep = targetValue.indexOf(':');
      if (sep !== -1) {
        targetType = targetValue.slice(0, sep) === 'room' ? 'room' : 'private';
        targetId = targetValue.slice(sep + 1);
      } else {
        targetId = targetValue;
      }
    } else {
      // ★ 兜底：下拉为空时回退当前活跃预设私聊，保证永远有目标频道
      targetType = 'private';
      targetId = this._currentPresetId || 'default';
    }

    const payload = {
      id: this.editingId || undefined,
      name,
      prompt,
      schedule,
      dateRange: { start: rangeStart, end: rangeEnd },
      // 提醒始终按执行频率触发，不再需要独立的"是否需要提醒"开关
      notifyEnabled: true,
      notifyTime: '',
      notifyWeekday: [],
      targetType,
      targetId,
      agentPresetId: targetType === 'private' ? targetId : (this._currentPresetId || targetId)
    };

    const result = await ipcRenderer.invoke('reminders-save', { reminder: payload });
    if (!result.success) {
      alert('保存失败：' + (result.message || '未知错误'));
      return;
    }
    this.closeForm();
    await this.loadList();
  }

  async removeEditing() {
    if (!this.editingId) return;
    const r = this.reminders.find(x => String(x.id) === this.editingId);
    if (!confirm('确定删除提醒「' + (r ? r.name : '') + '」吗？')) return;
    try {
      const result = await ipcRenderer.invoke('reminders-delete', this.editingId);
      if (!result.success) alert('删除失败：' + (result.message || '未知错误'));
    } catch (e) {
      console.error('[ReminderUI] 删除提醒异常:', e);
      alert('删除失败：' + (e.message || '未知错误') + '（若应用长期未重启，请重启后重试）');
    }
    this.closeForm();
    await this.loadList();
  }

  // ============================================================
  // 列表行内操作
  // ============================================================
  async toggleEnabled(id) {
    const r = this.reminders.find(x => String(x.id) === String(id));
    if (!r) return;
    try {
      const result = await ipcRenderer.invoke('reminders-set-enabled', { id, enabled: r.enabled === false });
      if (!result.success) alert('操作失败：' + (result.message || '未知错误'));
    } catch (e) {
      console.error('[ReminderUI] 暂停/恢复异常:', e);
      alert('操作失败：' + (e.message || '未知错误'));
    }
    await this.loadList();
  }

  async remove(id) {
    const r = this.reminders.find(x => String(x.id) === String(id));
    if (!r) return;
    if (!confirm('确定删除提醒「' + r.name + '」吗？')) return;
    try {
      const result = await ipcRenderer.invoke('reminders-delete', id);
      if (!result.success) alert('删除失败：' + (result.message || '未知错误'));
    } catch (e) {
      console.error('[ReminderUI] 删除提醒异常:', e);
      alert('删除失败：' + (e.message || '未知错误') + '（若应用长期未重启，请重启后重试）');
    }
    await this.loadList();
  }

  async triggerNow(id) {
    const r = this.reminders.find(x => String(x.id) === String(id));
    if (!r) return;
    if (!confirm('立即触发提醒「' + r.name + '」？\n（会向绑定频道发送一条触发消息）')) return;
    try {
      const result = await ipcRenderer.invoke('reminders-trigger-now', id);
      if (!result.success) alert('触发失败：' + (result.message || '未知错误'));
    } catch (e) {
      console.error('[ReminderUI] 立即触发异常:', e);
      alert('触发失败：' + (e.message || '未知错误'));
    }
    await this.loadList();
  }

  // ============================================================
  // 表单内部逻辑：schedule 收集 / Tab / 周期
  // ============================================================
  _collectSchedule() {
    const tab = this._scheduleType;
    if (tab === 'interval') {
      const intervalMinutes = parseInt(document.getElementById('reminderIntervalMinutes').value, 10);
      if (!intervalMinutes || intervalMinutes < 1) {
        this._showError('reminderScheduleError', '间隔分钟数必须为正整数');
        return null;
      }
      const startAtVal = document.getElementById('reminderIntervalStart').value;
      const schedule = { type: 'interval', intervalMinutes };
      if (startAtVal) schedule.startAt = new Date(startAtVal).toISOString();
      return schedule;
    }
    if (tab === 'once') {
      const dtVal = document.getElementById('reminderOnceDatetime').value;
      if (!dtVal) {
        this._showError('reminderScheduleError', '请选择单次触发时间');
        return null;
      }
      const dt = new Date(dtVal).getTime();
      if (isNaN(dt)) {
        this._showError('reminderScheduleError', '单次触发时间无效');
        return null;
      }
      if (dt <= Date.now()) {
        this._showError('reminderScheduleError', '单次触发时间必须晚于当前时间');
        return null;
      }
      return { type: 'once', datetime: new Date(dtVal).toISOString() };
    }
    // period
    const ptype = this._periodType;
    const timeVal =
      ptype === 'monthly' ? document.getElementById('reminderMonthlyTime').value :
      ptype === 'yearly' ? document.getElementById('reminderYearlyTime').value :
      ptype === 'weekly' ? document.getElementById('reminderWeeklyTime').value :
      document.getElementById('reminderTime').value;
    if (!timeVal) {
      this._showError('reminderScheduleError', '请选择触发时间');
      return null;
    }
    if (ptype === 'daily' || ptype === 'workday' || ptype === 'restday') {
      return { type: ptype, time: timeVal };
    }
    if (ptype === 'weekly') {
      const weekdays = this._collectWeekday('reminderWeekdayGroup');
      if (weekdays.length === 0) {
        this._showError('reminderScheduleError', '请至少选择一个星期');
        return null;
      }
      return { type: 'weekly', weekday: weekdays, time: timeVal };
    }
    if (ptype === 'monthly') {
      const day = parseInt(document.getElementById('reminderMonthDay').value, 10);
      if (!day || day < 1 || day > 31) {
        this._showError('reminderScheduleError', '每月日期需在 1-31 之间');
        return null;
      }
      return { type: 'monthly', dayOfMonth: day, time: timeVal };
    }
    if (ptype === 'yearly') {
      const month = parseInt(document.getElementById('reminderYearMonth').value, 10);
      const day = parseInt(document.getElementById('reminderYearDay').value, 10);
      if (!month || month < 1 || month > 12) {
        this._showError('reminderScheduleError', '月份需在 1-12 之间');
        return null;
      }
      if (!day || day < 1 || day > 31) {
        this._showError('reminderScheduleError', '日期需在 1-31 之间');
        return null;
      }
      return { type: 'yearly', month, dayOfMonth: day, time: timeVal };
    }
    return { type: 'daily', time: timeVal };
  }

  _setScheduleTab(type) {
    this._scheduleType = type;
    document.querySelectorAll('.reminder-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.scheduleType === type);
    });
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? 'block' : 'none';
    };
    show('reminderPeriodPanel', type === 'period');
    show('reminderIntervalPanel', type === 'interval');
    show('reminderOncePanel', type === 'once');
  }

  _setPeriodType(type) {
    this._periodType = type;
    document.querySelectorAll('.reminder-period-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.period === type);
    });
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? 'flex' : 'none';
    };
    // daily / workday / restday 共用时间行
    const isTimeOnly = type === 'daily' || type === 'workday' || type === 'restday';
    show('reminderTimeRow', isTimeOnly);
    show('reminderWeekdayRow', type === 'weekly');
    show('reminderMonthlyRow', type === 'monthly');
    show('reminderYearlyRow', type === 'yearly');
  }

  _collectWeekday(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return [];
    const result = [];
    group.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      const v = parseInt(cb.value, 10);
      if (!isNaN(v)) result.push(v);
    });
    return result;
  }

  _setWeekdayCheckboxes(groupId, weekdays) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const set = new Set(weekdays.map(Number));
    group.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = set.has(parseInt(cb.value, 10));
    });
  }

  _resetScheduleUI() {
    this._setScheduleTab('period');
    this._setPeriodType('daily');
    document.getElementById('reminderTime').value = '09:00';
    if (document.getElementById('reminderWeeklyTime')) document.getElementById('reminderWeeklyTime').value = '09:00';
    if (document.getElementById('reminderMonthlyTime')) document.getElementById('reminderMonthlyTime').value = '09:00';
    if (document.getElementById('reminderYearlyTime')) document.getElementById('reminderYearlyTime').value = '09:00';
    document.getElementById('reminderMonthDay').value = '1';
    document.getElementById('reminderYearMonth').value = '1';
    document.getElementById('reminderYearDay').value = '1';
    this._setWeekdayCheckboxes('reminderWeekdayGroup', [1]);
    document.getElementById('reminderIntervalMinutes').value = '90';
    document.getElementById('reminderIntervalStart').value = '';
    document.getElementById('reminderOnceDatetime').value = '';
  }

  _populateTargetSelect(reminder) {
    const sel = document.getElementById('reminderTargetSelect');
    if (!sel) return;
    const presets = window.__xilianPresets || [];
    const rooms =
      (this.appController && this.appController.chatRoomManager && this.appController.chatRoomManager.chatRooms) || [];
    const currentPresetId = window.__xilianCurrentPresetId || (presets[0] && presets[0].id) || 'default';
    this._currentPresetId = currentPresetId;

    let html = '<optgroup label="私聊频道">';
    (presets.length ? presets : []).forEach(p => {
      const label = p.name || '未命名';
      const selected = !reminder && p.id === currentPresetId ? ' selected' : '';
      html += '<option value="private:' + this.escAttr(p.id) + '"' + selected + '>' +
        this.esc(label) + '（私聊）</option>';
    });
    html += '</optgroup>';
    if (rooms.length) {
      html += '<optgroup label="聊天室">';
      rooms.forEach(room => {
        html += '<option value="room:' + this.escAttr(room.id) + '">' +
          this.esc(room.name || '未命名聊天室') + '（聊天室）</option>';
      });
      html += '</optgroup>';
    }
    sel.innerHTML = html;

    if (reminder && reminder.targetId) {
      const val = (reminder.targetType === 'room' ? 'room' : 'private') + ':' + reminder.targetId;
      const escaped = val.replace(/"/g, '&quot;');
      if (sel.querySelector('option[value="' + escaped + '"]')) sel.value = val;
    }
  }

  _toDateTimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  _clearErrors() {
    document.querySelectorAll('#reminderModal .form-error').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('#reminderModal .form-input, #reminderModal .form-textarea').forEach(el => {
      el.classList.remove('input-error');
    });
  }

  _showError(id, message) {
    const el = document.getElementById(id);
    if (el) el.textContent = message;
    if (id === 'reminderNameError') {
      const nameEl = document.getElementById('reminderName');
      if (nameEl) nameEl.classList.add('input-error');
    } else if (id === 'reminderScheduleError') {
      const timeEl = document.getElementById('reminderTime');
      if (timeEl) timeEl.classList.add('input-error');
    }
  }
}

module.exports = { ReminderUI };
