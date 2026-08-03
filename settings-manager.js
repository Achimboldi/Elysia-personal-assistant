const { ipcRenderer } = require('electron');

class SettingsManager {
  constructor(appController) {
    this.appController = appController;
    
    this.savedTheme = 'light';
    this.savedTaskOpacity = '80';
    this.savedExpenseOpacity = '80';
    this.savedFinanceOpacity = '80';
    
    this.savedAutoSync = false;
    this.savedSyncInterval = 10;
    
    this.savedCloudToken = '';
    this.savedCloudRefreshToken = '';
    this.savedCloudTokenExpireTime = 0;
  }

  async openSettingsModal() {
    await this.saveCurrentSettings();
    await this.appController.themeManager.loadTheme();
    await this.loadCloudConfig();
    await this.loadCloudUserList();
    await this.loadCurrentCloudUser();
    
    const modal = document.getElementById('settingsModal');
    const content = modal.querySelector('.modal-content');
    
    content.style.left = '50%';
    content.style.top = '50%';
    content.style.transform = 'translate(-50%, -50%)';
    content.style.width = '600px';
    content.style.height = 'auto';
    
    modal.classList.add('show');
    this.switchSettingsPanel('interface');
    this.appController.setupModalDrag('settingsModal');
    
    this.setupCloudUserManagement();
  }

  setupCloudUserManagement() {
    const switchBtn = document.getElementById('switchCloudUserBtn');
    const addBtn = document.getElementById('addCloudUserBtn');
    const importBtn = document.getElementById('importDataBtn');
    
    if (addBtn) {
      addBtn.onclick = () => {
        this.addCloudUser();
      };
    }
    
    if (switchBtn) {
      switchBtn.onclick = () => {
        this.switchCloudUser();
      };
    }
    
    if (importBtn) {
      importBtn.onclick = () => {
        this.importData();
      };
    }
  }

  async importData() {
    try {
      const result = await ipcRenderer.invoke('import-data-file');
      if (result.success) {
        alert(result.message);
        await this.appController.loadAllData();
      } else {
        alert('导入失败: ' + result.message);
      }
    } catch (e) {
      alert('导入数据时发生错误: ' + e.message);
    }
  }

  switchSettingsPanel(section) {
    document.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelector(`[data-section="${section}"]`).classList.add('active');

    document.querySelectorAll('.settings-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    document.getElementById(`settings${section.charAt(0).toUpperCase() + section.slice(1)}`).classList.add('active');

    if (section === 'finance') {
      this.loadFinanceStats();
    }
    
    if (section === 'cloud') {
      console.log('[DEBUG] switchSettingsPanel: cloud section');
      this.loadVersionInfo();
      this.loadCloudUserList();
      this.loadCurrentCloudUser();
      this.setupCloudUserManagement();
    }
    
    // 隐藏/显示共享的备份管理器（它不属于任何特定面板）
    const backupManager = document.getElementById('backup-manager');
    const sectionDivider = document.querySelector('.settings-section-divider');
    if (section === 'cloud') {
      if (backupManager) backupManager.style.display = '';
      if (sectionDivider) sectionDivider.style.display = '';
    } else {
      if (backupManager) backupManager.style.display = 'none';
      if (sectionDivider) sectionDivider.style.display = 'none';
    }
    
    if (section === 'elysia') {
      console.log('[SettingsPanel] 激活 Elysia 设置面板，调用 onPanelActivated + setupChatRoomPresetsUI');
      // 防护：确保 XilianSettings 存在
      if (typeof XilianSettings !== 'undefined' && XilianSettings.onPanelActivated) {
        XilianSettings.onPanelActivated();
      } else {
        console.warn('[SettingsPanel] XilianSettings 未定义或无 onPanelActivated 方法');
      }
      this.setupChatRoomPresetsUI();
    }
  }

  async saveCurrentSettings() {
    try {
      const settings = await ipcRenderer.invoke('get-settings');
      this.savedTheme = settings.theme || 'light';
      this.savedTaskOpacity = settings.taskCardOpacity || '80';
      this.savedExpenseOpacity = settings.expenseCardOpacity || '80';
      this.savedFinanceOpacity = settings.financeCardOpacity || '80';
      this.savedReminderOpacity = settings.reminderCardOpacity || '80';
      this.savedMemoOpacity = settings.memoCardOpacity || '80';
    } catch {
      this.savedTheme = 'light';
      this.savedTaskOpacity = '80';
      this.savedExpenseOpacity = '80';
      this.savedFinanceOpacity = '80';
      this.savedReminderOpacity = '80';
      this.savedMemoOpacity = '80';
    }
    
    try {
      const cloudConfig = await ipcRenderer.invoke('cloud-sync-get-config');
      this.savedAutoSync = cloudConfig.autoSync || false;
      this.savedSyncInterval = cloudConfig.syncInterval || 10;
      this.savedCloudToken = cloudConfig.token || '';
      this.savedCloudRefreshToken = cloudConfig.refreshToken || '';
      this.savedCloudTokenExpireTime = cloudConfig.tokenExpireTime || 0;
    } catch {
      this.savedAutoSync = false;
      this.savedSyncInterval = 10;
      this.savedCloudToken = '';
      this.savedCloudRefreshToken = '';
      this.savedCloudTokenExpireTime = 0;
    }
  }

  closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const content = modal.querySelector('.modal-content');
    
    modal.classList.remove('show');
    
    setTimeout(() => {
      content.style.left = '50%';
      content.style.top = '50%';
      content.style.transform = 'translate(-50%, -50%)';
      content.style.width = '600px';
      content.style.height = 'auto';
    }, 300);
    
    this.restoreSettings();
  }

  restoreSettings() {
    this.appController.themeManager.toggleDarkMode(this.savedTheme === 'dark');
    document.getElementById('taskCardOpacity').value = this.savedTaskOpacity;
    document.getElementById('taskCardOpacityValue').textContent = this.savedTaskOpacity + '%';
    document.getElementById('expenseCardOpacity').value = this.savedExpenseOpacity;
    document.getElementById('expenseCardOpacityValue').textContent = this.savedExpenseOpacity + '%';
    document.getElementById('financeCardOpacity').value = this.savedFinanceOpacity;
    document.getElementById('financeCardOpacityValue').textContent = this.savedFinanceOpacity + '%';
    document.getElementById('reminderCardOpacity').value = this.savedReminderOpacity;
    document.getElementById('reminderCardOpacityValue').textContent = this.savedReminderOpacity + '%';
    document.getElementById('memoCardOpacity').value = this.savedMemoOpacity;
    document.getElementById('memoCardOpacityValue').textContent = this.savedMemoOpacity + '%';
    this.appController.themeManager.applyCardOpacity();
    
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    if (autoSyncToggle) {
      autoSyncToggle.checked = this.savedAutoSync || false;
    }
    const autoSyncInterval = document.getElementById('autoSyncInterval');
    if (autoSyncInterval) {
      autoSyncInterval.value = this.savedSyncInterval || 10;
      document.getElementById('autoSyncIntervalValue').textContent = this.savedSyncInterval || 10;
    }
  }

  async saveSettings() {
    const themeMode = document.querySelector('input[name="themeMode"]:checked').value;
    const taskOpacity = document.getElementById('taskCardOpacity').value;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value;
    const financeOpacity = document.getElementById('financeCardOpacity').value;
    const calendarOpacity = document.getElementById('calendarOpacity').value;
    const budgetOpacity = document.getElementById('budgetOpacity').value;
    const secretOpacity = document.getElementById('secretCardOpacity').value;
    const reminderOpacity = document.getElementById('reminderCardOpacity').value;
    const memoOpacity = document.getElementById('memoCardOpacity').value;
    
    const themeManager = this.appController.themeManager;
    const darkBackgroundImage = themeManager.savedDarkBackgroundImage || '';
    const darkBackgroundPositionX = document.getElementById('darkBackgroundPositionX').value;
    const darkBackgroundPositionY = document.getElementById('darkBackgroundPositionY').value;
    const darkBackgroundSizeWidth = document.getElementById('darkBackgroundSizeWidth').value;
    const darkBackgroundOpacity = document.getElementById('darkBackgroundOpacity').value;
    const darkOverlayColor = document.getElementById('darkOverlayColor').value;
    const darkOverlayOpacity = document.getElementById('darkOverlayOpacity').value;
    const darkInvert = document.querySelector('input[name="darkInvert"]:checked').value;
    
    const lightBackgroundImage = themeManager.savedLightBackgroundImage || '';
    const lightBackgroundPositionX = document.getElementById('lightBackgroundPositionX').value;
    const lightBackgroundPositionY = document.getElementById('lightBackgroundPositionY').value;
    const lightBackgroundSizeWidth = document.getElementById('lightBackgroundSizeWidth').value;
    const lightBackgroundOpacity = document.getElementById('lightBackgroundOpacity').value;
    const lightOverlayColor = document.getElementById('lightOverlayColor').value;
    const lightOverlayOpacity = document.getElementById('lightOverlayOpacity').value;
    const lightInvert = document.querySelector('input[name="lightInvert"]:checked').value;
    
    const chatBackgroundImage = themeManager.savedChatBackgroundImage || '';
    const chatBackgroundPositionX = document.getElementById('chatBackgroundPositionX').value;
    const chatBackgroundPositionY = document.getElementById('chatBackgroundPositionY').value;
    const chatBackgroundSizeWidth = document.getElementById('chatBackgroundSizeWidth').value;
    const chatBackgroundOpacity = document.getElementById('chatBackgroundOpacity').value;
    const chatBackgroundBlur = document.getElementById('chatBackgroundBlur').value;
    const chatOverlayColor = document.getElementById('chatOverlayColor').value;
    const chatOverlayOpacity = document.getElementById('chatOverlayOpacity').value;
    
    try {
      // 一次性收集所有设置（界面 + Elysia AI），合并保存
      XilianSettings._syncFormToPreset();
      const elysiaConfig = XilianSettings.collectFromForm();
      // 关键保护：直接读取 API Key 输入框，确保拿到用户填的值
      const apiKeyInput = document.getElementById('aiApiKey');
      if (apiKeyInput && apiKeyInput.value) {
        elysiaConfig.aiApiKey = apiKeyInput.value;
      }
      
      await ipcRenderer.invoke('save-settings', {
        theme: themeMode,
        taskCardOpacity: taskOpacity, expenseCardOpacity: expenseOpacity,
        financeCardOpacity: financeOpacity, calendarOpacity: calendarOpacity,
        budgetOpacity: budgetOpacity, secretCardOpacity: secretOpacity,
        reminderCardOpacity: reminderOpacity, memoCardOpacity: memoOpacity,
        darkBackgroundImage: darkBackgroundImage ? encodeURIComponent(darkBackgroundImage) : '',
        darkBackgroundPositionX, darkBackgroundPositionY, darkBackgroundSizeWidth,
        darkBackgroundOpacity, darkOverlayColor, darkOverlayOpacity, darkInvert,
        lightBackgroundImage: lightBackgroundImage ? encodeURIComponent(lightBackgroundImage) : '',
        lightBackgroundPositionX, lightBackgroundPositionY, lightBackgroundSizeWidth,
        lightBackgroundOpacity, lightOverlayColor, lightOverlayOpacity, lightInvert,
        chatBackgroundImage: chatBackgroundImage ? encodeURIComponent(chatBackgroundImage) : '',
        chatBackgroundPositionX, chatBackgroundPositionY, chatBackgroundSizeWidth,
        chatBackgroundOpacity, chatBackgroundBlur, chatOverlayColor, chatOverlayOpacity,
        ...elysiaConfig,
        aiPresets: XilianSettings._presets,
        aiCurrentPresetId: XilianSettings._currentPresetId
      });
      
      themeManager.savedTaskOpacity = taskOpacity;
      themeManager.savedExpenseOpacity = expenseOpacity;
      themeManager.savedFinanceOpacity = financeOpacity;
      themeManager.savedCalendarOpacity = calendarOpacity;
      themeManager.savedBudgetOpacity = budgetOpacity;
      themeManager.savedSecretOpacity = secretOpacity;
      themeManager.savedReminderOpacity = reminderOpacity;
      themeManager.savedMemoOpacity = memoOpacity;
      themeManager.applyBackgroundSettings();
      themeManager.applyCardOpacity();
      themeManager.applyChatBackground();
      
      this.savedTheme = themeMode;
      this.savedTaskOpacity = taskOpacity;
      this.savedExpenseOpacity = expenseOpacity;
      this.savedFinanceOpacity = financeOpacity;
      this.savedReminderOpacity = reminderOpacity;
      this.savedMemoOpacity = memoOpacity;
      
      const modal = document.getElementById('settingsModal');
      modal.classList.remove('show');
      const content = modal.querySelector('.modal-content');
      content.style.left = '50%';
      content.style.top = '50%';
      content.style.transform = 'translate(-50%, -50%)';
      content.style.width = '600px';
      content.style.height = 'auto';

      // ★ 修复：保存后立即刷新昔涟设置内存状态和聊天头部头像
      if (typeof XilianSettings !== 'undefined') {
        XilianSettings._config = { ...XilianSettings._config, ...elysiaConfig };
        XilianSettings.updateChatHeader();
      }
    } catch (error) {
      console.error('保存设置失败:', error);
    }
    
    await this.saveCloudConfigSilently();
  }

  async saveCloudConfigSilently() {
    try {
      const cloudAppId = document.getElementById('cloudAppId');
      const cloudAppKey = document.getElementById('cloudAppKey');
      const cloudAppSecret = document.getElementById('cloudAppSecret');
      
      if (!cloudAppId || !cloudAppKey || !cloudAppSecret) {
        return;
      }
      
      const autoSyncToggle = document.getElementById('autoSyncToggle');
      const autoSyncInterval = document.getElementById('autoSyncInterval');
      
      const config = {
        appId: cloudAppId.value,
        appKey: cloudAppKey.value,
        appSecret: cloudAppSecret.value,
        autoSync: autoSyncToggle ? autoSyncToggle.checked : false,
        syncInterval: autoSyncInterval ? parseInt(autoSyncInterval.value) : 10,
        token: this.savedCloudToken || '',
        refreshToken: this.savedCloudRefreshToken || '',
        tokenExpireTime: this.savedCloudTokenExpireTime || 0
      };
      
      const result = await ipcRenderer.invoke('cloud-sync-save-config', config);
      if (result.success) {
        this.saveCloudConfigToCache(config);
      }
    } catch (e) {
      console.error('自动保存云同步配置失败:', e);
    }
  }

  saveCloudConfigToCache(config) {
    this.savedCloudToken = config.token || '';
    this.savedCloudRefreshToken = config.refreshToken || '';
    this.savedCloudTokenExpireTime = config.tokenExpireTime || 0;
  }

  async loadCloudConfig() {
    try {
      const cloudConfig = await ipcRenderer.invoke('cloud-sync-get-config');
      const cloudAppId = document.getElementById('cloudAppId');
      const cloudAppKey = document.getElementById('cloudAppKey');
      const cloudAppSecret = document.getElementById('cloudAppSecret');
      
      if (cloudAppId && cloudConfig.appId) {
        cloudAppId.value = cloudConfig.appId;
      }
      if (cloudAppKey && cloudConfig.appKey) {
        cloudAppKey.value = cloudConfig.appKey;
      }
      if (cloudAppSecret && cloudConfig.appSecret) {
        cloudAppSecret.value = cloudConfig.appSecret;
      }
      
      const autoSyncToggle = document.getElementById('autoSyncToggle');
      const autoSyncInterval = document.getElementById('autoSyncInterval');
      
      if (autoSyncToggle) {
        autoSyncToggle.checked = cloudConfig.autoSync || false;
      }
      if (autoSyncInterval) {
        autoSyncInterval.value = cloudConfig.syncInterval || 10;
        document.getElementById('autoSyncIntervalValue').textContent = cloudConfig.syncInterval || 10;
      }
      
      this.savedCloudToken = cloudConfig.token || '';
      this.savedCloudRefreshToken = cloudConfig.refreshToken || '';
      this.savedCloudTokenExpireTime = cloudConfig.tokenExpireTime || 0;
    } catch (e) {
      console.error('加载云同步配置失败:', e);
    }
  }

  async loadCloudUserList() {
    try {
      const result = await ipcRenderer.invoke('cloud-sync-get-user-list');
      if (result.success && result.users && Array.isArray(result.users)) {
        const userList = document.getElementById('cloudUserList');
        const userSelect = document.getElementById('cloudUserSelect');
        
        if (!userList || !userSelect) {
          console.error('用户管理界面元素未找到');
          return;
        }
        
        userList.innerHTML = '';
        userSelect.innerHTML = '';
        
        result.users.forEach(user => {
          const userItem = document.createElement('div');
          userItem.className = `user-item ${user.id === 'admin' ? 'admin-user' : ''}`;
          userItem.innerHTML = `
            <div class="user-info">
              <span class="user-name">${user.name}</span>
              <span class="user-id">${user.id}</span>
            </div>
            <div class="user-actions">
              ${user.isDefault ? '<span class="user-default">默认</span>' : ''}
              ${user.id !== 'admin' ? '<button class="remove-user-btn" data-user-id="' + user.id + '">删除</button>' : ''}
            </div>
          `;
          userList.appendChild(userItem);
          
          const option = document.createElement('option');
          option.value = user.id;
          option.textContent = user.id === 'admin' ? `${user.name} (默认路径)` : user.name;
          userSelect.appendChild(option);
        });
        
        userList.querySelectorAll('.remove-user-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const userId = e.target.dataset.userId;
            this.removeCloudUser(userId);
          });
        });
      }
    } catch (e) {
      console.error('加载云用户列表失败:', e);
    }
  }

  async loadCurrentCloudUser() {
    try {
      const result = await ipcRenderer.invoke('cloud-sync-get-config');
      if (result.success) {
        const userId = result.currentUserId || 'admin';
        const userName = userId === 'admin' ? '管理员' : userId;
        const userPath = userId === 'admin' ? '/apps/Elysia/data.json' : `/apps/Elysia/users/${encodeURIComponent(userId)}/data.json`;
        
        const currentUserIdEl = document.getElementById('currentCloudUserId');
        const currentUserPathEl = document.getElementById('currentCloudUserPath');
        const userSelect = document.getElementById('cloudUserSelect');
        
        if (currentUserIdEl) {
          currentUserIdEl.textContent = userName;
        }
        if (currentUserPathEl) {
          currentUserPathEl.textContent = userPath;
        }
        if (userSelect) {
          userSelect.value = userId;
        }
      }
    } catch (e) {
      console.error('加载当前云用户失败:', e);
    }
  }

  async loadVersionInfo() {
    try {
      const result = await ipcRenderer.invoke('get-version-type');
      const versionEl = document.getElementById('versionInfo');
      if (versionEl) {
        versionEl.textContent = result.isTest ? 'Philia Beta' : 'Elysia';
      }
    } catch (e) {
      console.error('加载版本信息失败:', e);
    }
  }

  async loadFinanceStats() {
    await this.appController.loadFinanceStats();
  }

  addCloudUser() {
    document.getElementById('newUserId').value = '';
    document.getElementById('newUserName').value = '';
    document.getElementById('addUserModal').style.display = 'flex';
    document.getElementById('newUserId').focus();
  }
  
  async submitAddUser() {
    const userId = document.getElementById('newUserId').value.trim();
    const userName = document.getElementById('newUserName').value.trim() || userId;
    
    if (!userId) {
      alert('请输入用户ID');
      return;
    }
    
    if (userId === 'admin') {
      alert('不能创建名为 "admin" 的用户');
      return;
    }
    
    document.getElementById('addUserModal').style.display = 'none';
    
    try {
      const result = await ipcRenderer.invoke('cloud-sync-add-user', { id: userId, name: userName });
      if (result.success) {
        alert(`用户 ${userName} 创建成功`);
        await this.loadCloudUserList();
      } else {
        alert('创建用户失败: ' + result.message);
      }
    } catch (e) {
      alert('创建用户时发生错误: ' + e.message);
    }
  }

  async switchCloudUser() {
    const userSelect = document.getElementById('cloudUserSelect');
    const newUserId = userSelect ? userSelect.value : null;
    
    if (!newUserId) {
      alert('请选择一个用户');
      return;
    }
    
    const result = await ipcRenderer.invoke('cloud-sync-set-user', newUserId);
    if (result.success) {
      alert(`已切换到用户: ${newUserId === 'admin' ? '管理员' : newUserId}`);
      await this.loadCurrentCloudUser();
      await this.appController.loadAllData();
    } else {
      alert('切换用户失败: ' + result.message);
    }
  }

  removeCloudUser(userId) {
    this.appController.pendingAction = {
      action: 'removeUser',
      userId: userId
    };
    document.getElementById('confirmMessage').textContent = `确定要删除用户 "${userId}" 吗？`;
    document.getElementById('confirmModal').style.display = 'flex';
  }

  // ============================================================
  // 聊天室预设 UI（增强版 — onclick 覆盖绑定 + 全面 debug 日志）
  // ============================================================
  setupChatRoomPresetsUI() {
    console.log('[CRPreset] setupChatRoomPresetsUI 被调用');
    const self = this;
    const presetSelect = document.getElementById('chatRoomPresetSelect');
    const nameInput = document.getElementById('chatRoomName');
    const agentList = document.getElementById('chatRoomAgentList');
    const agentSelect = document.getElementById('chatRoomAddAgentSelect');
    const addAgentBtn = document.getElementById('chatRoomAddAgentBtn');
    const newBtn = document.getElementById('chatRoomPresetNewBtn');
    const delBtn = document.getElementById('chatRoomPresetDelBtn');

    const crm = window._chatRoomManager;
    console.log('[CRPreset] crm =', !!crm, ', presetSelect =', !!presetSelect, ', newBtn =', !!newBtn, ', nameInput =', !!nameInput);
    if (!crm) {
      console.warn('[CRPreset] window._chatRoomManager 未初始化，延迟 300ms 重试...');
      setTimeout(() => this.setupChatRoomPresetsUI(), 300);
      return;
    }
    if (!presetSelect || !newBtn || !nameInput) {
      console.warn('[CRPreset] DOM 元素缺失，延迟 200ms 重试...');
      setTimeout(() => this.setupChatRoomPresetsUI(), 200);
      return;
    }

    // ★ 每次都重新绑定事件（用 onclick 避免重复绑定累积）
    // 之前的 eventsBound 机制可能导致：第一次绑定失败 → eventsBound=true → 后续调用跳过绑定 → 永远不工作
    console.log('[CRPreset] 开始绑定事件处理函数...');

    let currentRoomId = null;
    const getPresets = () => window.__xilianPresets || (typeof XilianSettings !== 'undefined' && XilianSettings._presets) || [];

    // ★ 聊天室名称：用 blur 保存（在 IME 输入完成后触发，不干扰输入法）
    nameInput.onblur = async () => {
      if (!currentRoomId) return;
      // 如果输入框失去焦点后又立即获得焦点（比如点击下拉菜单），不保存
      // 延迟检查，避免误触发
      await new Promise(r => setTimeout(r, 100));
      if (document.activeElement === nameInput) return; // 焦点又回来了，跳过
      const newName = nameInput.value.trim();
      if (!newName) { nameInput.value = ''; return; }
      const room = crm.chatRooms.find(r => r.id === currentRoomId);
      if (room && room.name === newName) return; // 没变化，跳过
      try {
        await crm.updateChatRoom(currentRoomId, { name: newName });
        refreshPresetSelect();
      } catch (err) {
        console.error('[CRPreset] 保存聊天室名称失败:', err);
      }
    };

    const refreshPresetSelect = () => {
      // ★ 临时关闭 onchange，避免 restore value 时触发连锁反应
      const prevOnChange = presetSelect.onchange;
      presetSelect.onchange = null;
      
      const rooms = crm.chatRooms || [];
      let opts = '<option value="">无聊天室</option>';
      rooms.forEach(room => {
        opts += `<option value="${room.id}">${self.escapeAttr(room.name)} (${room.agentIds.length}个智能体)</option>`;
      });
      presetSelect.innerHTML = opts;
      if (currentRoomId) presetSelect.value = currentRoomId;

      // 恢复 onchange
      presetSelect.onchange = prevOnChange;
    };

    const refreshAgentList = () => {
      console.log('[CRPreset] refreshAgentList: currentRoomId =', currentRoomId);
      if (!currentRoomId) {
        agentList.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">请先选择或创建聊天室</span>';
        return;
      }
      const room = crm.chatRooms.find(r => r.id === currentRoomId);
      const presets = getPresets();
      if (!room) {
        agentList.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">聊天室不存在</span>';
        return;
      }
      let html = '';
      room.agentIds.forEach((aid, idx) => {
        const p = presets.find(pr => pr.id === aid);
        const name = p ? p.name : aid;
        html += `<div class="chat-room-agent-chip">${self.escapeAttr(name)} <button class="chat-room-agent-remove" data-agent-id="${aid}" data-index="${idx}" title="移除">×</button></div>`;
      });
      if (room.agentIds.length >= 10) {
        html += '<span style="color:var(--text-muted); font-size:11px;">已达到上限(10个)</span>';
      }
      agentList.innerHTML = html || '<span style="color:var(--text-muted); font-size:12px;">暂无智能体，请添加</span>';

      const presetsAll = getPresets();
      // ★ 先拼字符串再一次性 innerHTML，避免循环中反复重建原生 select
      let selectOpts = '<option value="">选择要添加的智能体...</option>';
      presetsAll.forEach(p => {
        if (!room.agentIds.includes(p.id)) {
          selectOpts += `<option value="${p.id}">${self.escapeAttr(p.name)}</option>`;
        }
      });
      agentSelect.innerHTML = selectOpts;

      // ★ 重新启用/禁用添加按钮（修复：删除智能体后按钮不恢复的问题）
      if (agentSelect.options.length > 1 && room.agentIds.length < 10) {
        agentSelect.disabled = false;
        addAgentBtn.disabled = false;
      }

      // 移除按钮 — 使用 onclick 避免重复绑定
      agentList.querySelectorAll('.chat-room-agent-remove').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const agentId = btn.dataset.agentId;
          const room = crm.chatRooms.find(r => r.id === currentRoomId);
          if (room) {
            await crm.updateChatRoom(currentRoomId, {
              agentIds: room.agentIds.filter(id => id !== agentId)
            });
            refreshAgentList();
            refreshPresetSelect();
            if (typeof XilianUI !== 'undefined' && XilianUI.updateHeaderDropdown) {
              XilianUI.updateHeaderDropdown();
            }
          }
        };
      });
    };

    // ★ 用 onclick 替换 addEventListener，确保每次调用覆盖旧绑定
    presetSelect.onchange = () => {
      console.log('[CRPreset] presetSelect changed:', presetSelect.value);
      currentRoomId = presetSelect.value || null;
      if (currentRoomId) {
        const room = crm.chatRooms.find(r => r.id === currentRoomId);
        if (room) {
          nameInput.value = room.name;
          
        }
      } else {
        nameInput.value = '';
        }
      refreshAgentList();
    };

    // 保存统一在关闭设置弹窗时处理

    newBtn.onclick = async () => {
      console.log('[CRPreset] newBtn 被点击！');
      try {
        const room = await crm.addChatRoom('新聊天室', []);
        console.log('[CRPreset] 新聊天室创建成功:', room.id);
        currentRoomId = room.id;
        nameInput.value = room.name;
        // ★ refreshPresetSelect 内部已设置 presetSelect.value，无需重复设置（重复会触发 onchange 连锁）
        refreshPresetSelect();
        refreshAgentList();
      } catch (err) {
        console.error('[CRPreset] 创建聊天室失败:', err);
        alert('创建聊天室失败: ' + (err.message || err));
      }
    };

    delBtn.onclick = async () => {
      console.log('[CRPreset] delBtn 被点击！currentRoomId =', currentRoomId);
      if (!currentRoomId) {
        alert('请先选择一个聊天室再删除');
        return;
      }
      const room = crm.chatRooms.find(r => r.id === currentRoomId);
      if (confirm(`确定要删除聊天室「${room?.name || currentRoomId}」吗？聊天记录也会被清除。`)) {
        try {
          await crm.deleteChatRoom(currentRoomId);
          currentRoomId = null;
          nameInput.value = '';
          refreshPresetSelect();
          refreshAgentList();
          if (typeof XilianUI !== 'undefined' && XilianUI.updateHeaderDropdown) {
            XilianUI.updateHeaderDropdown();
          }
        } catch (err) {
          console.error('[CRPreset] 删除聊天室失败:', err);
          alert('删除聊天室失败: ' + (err.message || err));
        }
      }
    };

    addAgentBtn.onclick = async () => {
      console.log('[CRPreset] addAgentBtn 被点击！');
      if (!currentRoomId) return;
      const agentId = agentSelect.value;
      if (!agentId) {
        alert('请先选择一个智能体');
        return;
      }
      const room = crm.chatRooms.find(r => r.id === currentRoomId);
      if (!room || room.agentIds.length >= 10) return;
      try {
        await crm.updateChatRoom(currentRoomId, {
          agentIds: [...room.agentIds, agentId]
        });
        agentSelect.value = '';
        if (room.agentIds.length + 1 >= 10) {
          agentSelect.disabled = true;
          addAgentBtn.disabled = true;
        }
        refreshAgentList();
        refreshPresetSelect();
      } catch (err) {
        console.error('[CRPreset] 添加智能体失败:', err);
        alert('添加智能体失败: ' + (err.message || err));
      }
    };

    // 初始加载
    refreshPresetSelect();
    console.log('[CRPreset] 初始化完成，事件已绑定。crm.chatRooms.length =', (crm.chatRooms || []).length);

    // 如果有当前活跃的聊天室，自动选中
    if (crm.currentRoomId) {
      console.log('[CRPreset] 检测到活跃聊天室:', crm.currentRoomId);
      currentRoomId = crm.currentRoomId;
      presetSelect.value = currentRoomId;
      const room = crm.chatRooms.find(r => r.id === currentRoomId);
      if (room) {
        nameInput.value = room.name;
        
      }
      refreshAgentList();
    }
  }

  escapeAttr(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

module.exports = { SettingsManager };
