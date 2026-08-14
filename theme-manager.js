const { ipcRenderer } = require('electron');

// ★ Linux 适配：把 Windows 盘符路径（如 D:/妙妙小工具/...）映射到 Linux 实际挂载路径
//   （D: 盘在此机器上挂载于 /mnt/data，即 D:/X → /mnt/data/X）
//   云同步可能把 Windows 端保存的背景图路径带到 Linux，需转换后才能加载。
function normalizeBgPath(p) {
  if (!p) return '';
  // 已经存在则直接用
  const fs = require('fs');
  try {
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  if (process.platform === 'linux') {
    // Windows 路径: D:/foo → /mnt/data/foo ；D:\foo → /mnt/data/foo
    const m = /^([A-Za-z]):[/\\]/.exec(p);
    if (m) {
      const rest = p.slice(2).replace(/\\/g, '/');
      const linuxPath = '/mnt/data' + rest;
      try {
        if (fs.existsSync(linuxPath)) return linuxPath;
      } catch (_) {}
    }
  }
  return p;
}

class ThemeManager {
  constructor(appController) {
    this.appController = appController;
    
    this.savedTaskOpacity = '80';
    this.savedExpenseOpacity = '80';
    this.savedFinanceOpacity = '80';
    this.savedCalendarOpacity = '80';
    this.savedBudgetOpacity = '80';
    this.savedSecretOpacity = '80';
    
    this.savedDarkBackgroundImage = '';
    this.savedDarkBackgroundPositionX = '50';
    this.savedDarkBackgroundPositionY = '100';
    this.savedDarkBackgroundSizeWidth = '70';
    this.savedDarkBackgroundOpacity = '100';
    this.savedDarkOverlayColor = '#000000';
    this.savedDarkOverlayOpacity = '0';
    this.savedDarkInvert = 'invert';
    
    this.savedLightBackgroundImage = '';
    this.savedLightBackgroundPositionX = '50';
    this.savedLightBackgroundPositionY = '100';
    this.savedLightBackgroundSizeWidth = '70';
    this.savedLightBackgroundOpacity = '100';
    this.savedLightOverlayColor = '#000000';
    this.savedLightOverlayOpacity = '0';
    this.savedLightInvert = 'none';
  }

  toggleDarkMode(isDark) {
    const root = document.documentElement;
    const titleEl = document.querySelector('.titlebar-title');
    const isTest = window.isTestVersion === true;
    
    if (isDark) {
      root.classList.add('dark-mode');
      localStorage.setItem('theme', 'dark');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Philia Beta' : 'Philia';
      }
    } else {
      root.classList.remove('dark-mode');
      localStorage.setItem('theme', 'light');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Elysia Beta' : 'Elysia';
      }
    }
  }

  async loadTheme() {
    let savedTheme = 'light';
    try {
      const settings = await ipcRenderer.invoke('get-settings');
      savedTheme = settings.theme || 'light';
    } catch {
      savedTheme = localStorage.getItem('theme') || 'light';
    }
    
    const root = document.documentElement;
    const titleEl = document.querySelector('.titlebar-title');
    const isTest = window.isTestVersion === true;
    
    if (savedTheme === 'dark') {
      root.classList.add('dark-mode');
      document.querySelector('input[name="themeMode"][value="dark"]').checked = true;
      if (titleEl) {
        titleEl.textContent = isTest ? 'Philia Beta' : 'Philia';
      }
    } else {
      root.classList.remove('dark-mode');
      document.querySelector('input[name="themeMode"][value="light"]').checked = true;
      if (titleEl) {
        titleEl.textContent = isTest ? 'Elysia Beta' : 'Elysia';
      }
    }
  }

  async loadCardOpacitySettings() {
    try {
      const settings = await ipcRenderer.invoke('get-settings');
      this.savedTaskOpacity = settings.taskCardOpacity || '80';
      this.savedExpenseOpacity = settings.expenseCardOpacity || '80';
      this.savedFinanceOpacity = settings.financeCardOpacity || '80';
      this.savedCalendarOpacity = settings.calendarOpacity || '80';
      this.savedBudgetOpacity = settings.budgetOpacity || '80';
      this.savedSecretOpacity = settings.secretCardOpacity || '80';
      this.savedReminderOpacity = settings.reminderCardOpacity || '80';
      this.savedMemoOpacity = settings.memoCardOpacity || '80';
      
      this.savedDarkBackgroundImage = settings.darkBackgroundImage ? normalizeBgPath(decodeURIComponent(settings.darkBackgroundImage)) : '';
      this.savedDarkBackgroundPositionX = settings.darkBackgroundPositionX !== undefined ? settings.darkBackgroundPositionX : '50';
      this.savedDarkBackgroundPositionY = settings.darkBackgroundPositionY !== undefined ? settings.darkBackgroundPositionY : '100';
      this.savedDarkBackgroundSizeWidth = settings.darkBackgroundSizeWidth !== undefined ? settings.darkBackgroundSizeWidth : '70';
      this.savedDarkBackgroundOpacity = settings.darkBackgroundOpacity || '100';
      this.savedDarkOverlayColor = settings.darkOverlayColor || '#000000';
      this.savedDarkOverlayOpacity = settings.darkOverlayOpacity || '0';
      this.savedDarkInvert = settings.darkInvert !== undefined ? settings.darkInvert : 'invert';
      
      this.savedLightBackgroundImage = settings.lightBackgroundImage ? normalizeBgPath(decodeURIComponent(settings.lightBackgroundImage)) : '';
      this.savedLightBackgroundPositionX = settings.lightBackgroundPositionX !== undefined ? settings.lightBackgroundPositionX : '50';
      this.savedLightBackgroundPositionY = settings.lightBackgroundPositionY !== undefined ? settings.lightBackgroundPositionY : '100';
      this.savedLightBackgroundSizeWidth = settings.lightBackgroundSizeWidth !== undefined ? settings.lightBackgroundSizeWidth : '70';
      this.savedLightBackgroundOpacity = settings.lightBackgroundOpacity || '100';
      this.savedLightOverlayColor = settings.lightOverlayColor || '#000000';
      this.savedLightOverlayOpacity = settings.lightOverlayOpacity || '0';
      this.savedLightInvert = settings.lightInvert !== undefined ? settings.lightInvert : 'none';

      this.savedChatBackgroundImage = settings.chatBackgroundImage ? normalizeBgPath(decodeURIComponent(settings.chatBackgroundImage)) : '';
      this.savedChatBackgroundPositionX = settings.chatBackgroundPositionX !== undefined ? settings.chatBackgroundPositionX : '50';
      this.savedChatBackgroundPositionY = settings.chatBackgroundPositionY !== undefined ? settings.chatBackgroundPositionY : '100';
      this.savedChatBackgroundSizeWidth = settings.chatBackgroundSizeWidth !== undefined ? settings.chatBackgroundSizeWidth : '70';
      this.savedChatBackgroundOpacity = settings.chatBackgroundOpacity || '100';
      this.savedChatBackgroundBlur = settings.chatBackgroundBlur !== undefined ? settings.chatBackgroundBlur : '0';
      this.savedChatOverlayColor = settings.chatOverlayColor || '#000000';
      this.savedChatOverlayOpacity = settings.chatOverlayOpacity || '0';
    } catch {
      console.warn('从主进程获取设置失败，使用默认值');
      this._resetToDefaults();
    }
    
    this._updateUIElements();
    this.applyBackgroundSettings();
    this.applyCardOpacity();
    this.applyChatBackground();
  }

  _resetToDefaults() {
    this.savedTaskOpacity = '80';
    this.savedExpenseOpacity = '80';
    this.savedFinanceOpacity = '80';
    this.savedCalendarOpacity = '80';
    this.savedBudgetOpacity = '80';
    this.savedSecretOpacity = '80';
    this.savedReminderOpacity = '80';
    this.savedMemoOpacity = '80';
    
    this.savedDarkBackgroundImage = '';
    this.savedDarkBackgroundPositionX = '50';
    this.savedDarkBackgroundPositionY = '100';
    this.savedDarkBackgroundSizeWidth = '70';
    this.savedDarkBackgroundOpacity = '100';
    this.savedDarkOverlayColor = '#000000';
    this.savedDarkOverlayOpacity = '0';
    this.savedDarkInvert = 'invert';
    
    this.savedLightBackgroundImage = '';
    this.savedLightBackgroundPositionX = '50';
    this.savedLightBackgroundPositionY = '100';
    this.savedLightBackgroundSizeWidth = '70';
    this.savedLightBackgroundOpacity = '100';
    this.savedLightOverlayColor = '#000000';
    this.savedLightOverlayOpacity = '0';
    this.savedLightInvert = 'none';

    this.savedChatBackgroundImage = '';
    this.savedChatBackgroundPositionX = '50';
    this.savedChatBackgroundPositionY = '100';
    this.savedChatBackgroundSizeWidth = '70';
    this.savedChatBackgroundOpacity = '100';
    this.savedChatBackgroundBlur = '0';
    this.savedChatOverlayColor = '#000000';
    this.savedChatOverlayOpacity = '0';
  }

  _updateUIElements() {
    document.getElementById('taskCardOpacity').value = this.savedTaskOpacity;
    document.getElementById('taskCardOpacityValue').textContent = this.savedTaskOpacity + '%';
    document.getElementById('expenseCardOpacity').value = this.savedExpenseOpacity;
    document.getElementById('expenseCardOpacityValue').textContent = this.savedExpenseOpacity + '%';
    document.getElementById('financeCardOpacity').value = this.savedFinanceOpacity;
    document.getElementById('financeCardOpacityValue').textContent = this.savedFinanceOpacity + '%';
    document.getElementById('calendarOpacity').value = this.savedCalendarOpacity;
    document.getElementById('calendarOpacityValue').textContent = this.savedCalendarOpacity + '%';
    document.getElementById('budgetOpacity').value = this.savedBudgetOpacity;
    document.getElementById('budgetOpacityValue').textContent = this.savedBudgetOpacity + '%';
    document.getElementById('secretCardOpacity').value = this.savedSecretOpacity;
    document.getElementById('secretCardOpacityValue').textContent = this.savedSecretOpacity + '%';
    document.getElementById('reminderCardOpacity').value = this.savedReminderOpacity;
    document.getElementById('reminderCardOpacityValue').textContent = this.savedReminderOpacity + '%';
    document.getElementById('memoCardOpacity').value = this.savedMemoOpacity;
    document.getElementById('memoCardOpacityValue').textContent = this.savedMemoOpacity + '%';
    
    document.getElementById('darkBackgroundPositionX').value = this.savedDarkBackgroundPositionX;
    document.getElementById('darkBackgroundPositionXValue').textContent = this.savedDarkBackgroundPositionX + '%';
    document.getElementById('darkBackgroundPositionY').value = this.savedDarkBackgroundPositionY;
    document.getElementById('darkBackgroundPositionYValue').textContent = this.savedDarkBackgroundPositionY + '%';
    document.getElementById('darkBackgroundSizeWidth').value = this.savedDarkBackgroundSizeWidth;
    document.getElementById('darkBackgroundSizeWidthValue').textContent = this.savedDarkBackgroundSizeWidth + '%';
    document.getElementById('darkBackgroundOpacity').value = this.savedDarkBackgroundOpacity;
    document.getElementById('darkBackgroundOpacityValue').textContent = this.savedDarkBackgroundOpacity + '%';
    document.getElementById('darkBackgroundBlur').value = '0';
    document.getElementById('darkBackgroundBlurValue').textContent = '0px';
    document.getElementById('darkOverlayColor').value = this.savedDarkOverlayColor;
    document.getElementById('darkOverlayOpacity').value = this.savedDarkOverlayOpacity;
    document.getElementById('darkOverlayOpacityValue').textContent = this.savedDarkOverlayOpacity + '%';
    document.querySelector(`input[name="darkInvert"][value="${this.savedDarkInvert}"]`).checked = true;
    
    document.getElementById('lightBackgroundPositionX').value = this.savedLightBackgroundPositionX;
    document.getElementById('lightBackgroundPositionXValue').textContent = this.savedLightBackgroundPositionX + '%';
    document.getElementById('lightBackgroundPositionY').value = this.savedLightBackgroundPositionY;
    document.getElementById('lightBackgroundPositionYValue').textContent = this.savedLightBackgroundPositionY + '%';
    document.getElementById('lightBackgroundSizeWidth').value = this.savedLightBackgroundSizeWidth;
    document.getElementById('lightBackgroundSizeWidthValue').textContent = this.savedLightBackgroundSizeWidth + '%';
    document.getElementById('lightBackgroundOpacity').value = this.savedLightBackgroundOpacity;
    document.getElementById('lightBackgroundOpacityValue').textContent = this.savedLightBackgroundOpacity + '%';
    document.getElementById('lightBackgroundBlur').value = '0';
    document.getElementById('lightBackgroundBlurValue').textContent = '0px';
    document.getElementById('lightOverlayColor').value = this.savedLightOverlayColor;
    document.getElementById('lightOverlayOpacity').value = this.savedLightOverlayOpacity;
    document.getElementById('lightOverlayOpacityValue').textContent = this.savedLightOverlayOpacity + '%';
    document.querySelector(`input[name="lightInvert"][value="${this.savedLightInvert}"]`).checked = true;
    
    if (this.savedDarkBackgroundImage) {
      document.getElementById('darkCurrentBackgroundPath').textContent = this.savedDarkBackgroundImage;
    }
    if (this.savedLightBackgroundImage) {
      document.getElementById('lightCurrentBackgroundPath').textContent = this.savedLightBackgroundImage;
    }

    document.getElementById('chatBackgroundPositionX').value = this.savedChatBackgroundPositionX;
    document.getElementById('chatBackgroundPositionXValue').textContent = this.savedChatBackgroundPositionX + '%';
    document.getElementById('chatBackgroundPositionY').value = this.savedChatBackgroundPositionY;
    document.getElementById('chatBackgroundPositionYValue').textContent = this.savedChatBackgroundPositionY + '%';
    document.getElementById('chatBackgroundSizeWidth').value = this.savedChatBackgroundSizeWidth;
    document.getElementById('chatBackgroundSizeWidthValue').textContent = this.savedChatBackgroundSizeWidth + '%';
    document.getElementById('chatBackgroundOpacity').value = this.savedChatBackgroundOpacity;
    document.getElementById('chatBackgroundOpacityValue').textContent = this.savedChatBackgroundOpacity + '%';
    document.getElementById('chatBackgroundBlur').value = this.savedChatBackgroundBlur;
    document.getElementById('chatBackgroundBlurValue').textContent = this.savedChatBackgroundBlur + 'px';
    document.getElementById('chatOverlayColor').value = this.savedChatOverlayColor;
    document.getElementById('chatOverlayOpacity').value = this.savedChatOverlayOpacity;
    document.getElementById('chatOverlayOpacityValue').textContent = this.savedChatOverlayOpacity + '%';
    if (this.savedChatBackgroundImage) {
      document.getElementById('chatCurrentBackgroundPath').textContent = this.savedChatBackgroundImage;
    }
  }

  applyBackgroundSettings() {
    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    
    let backgroundImage, posX, posY, sizeW, backgroundOpacity, overlayColor, overlayOpacity, invert;
    
    if (isDarkMode) {
      backgroundImage = this.savedDarkBackgroundImage || '';
      posX = parseInt(this.savedDarkBackgroundPositionX || '50');
      posY = parseInt(this.savedDarkBackgroundPositionY || '100');
      sizeW = parseInt(this.savedDarkBackgroundSizeWidth || '70');
      backgroundOpacity = (this.savedDarkBackgroundOpacity || 100) / 100;
      overlayColor = this.savedDarkOverlayColor || '#000000';
      overlayOpacity = (this.savedDarkOverlayOpacity || 0) / 100;
      invert = this.savedDarkInvert || 'none';
    } else {
      backgroundImage = this.savedLightBackgroundImage || '';
      posX = parseInt(this.savedLightBackgroundPositionX || '50');
      posY = parseInt(this.savedLightBackgroundPositionY || '100');
      sizeW = parseInt(this.savedLightBackgroundSizeWidth || '70');
      backgroundOpacity = (this.savedLightBackgroundOpacity || 100) / 100;
      overlayColor = this.savedLightOverlayColor || '#000000';
      overlayOpacity = (this.savedLightOverlayOpacity || 0) / 100;
      invert = this.savedLightInvert || 'none';
    }
    
    const backgroundPosition = `${posX}% ${posY}%`;
    const backgroundSize = `${sizeW}% auto`;
    const backgroundBlur = '0px';
    
    let filterValue = 'none';
    if (invert === 'invert') {
      filterValue = 'invert(1)';
    } else if (invert === 'grayscale') {
      filterValue = 'grayscale(1)';
    }
    
    if (backgroundImage) {
      document.documentElement.style.setProperty('--background-image', `url('${backgroundImage}')`);
    } else {
      document.documentElement.style.removeProperty('--background-image');
    }
    
    document.documentElement.style.setProperty('--background-position', backgroundPosition);
    document.documentElement.style.setProperty('--background-size', backgroundSize);
    document.documentElement.style.setProperty('--background-opacity', backgroundOpacity);
    document.documentElement.style.setProperty('--background-blur', backgroundBlur);
    document.documentElement.style.setProperty('--background-filter', filterValue);
    
    if (overlayOpacity > 0) {
      document.documentElement.style.setProperty('--overlay-color', `${overlayColor}${Math.round(overlayOpacity * 255).toString(16).padStart(2, '0')}`);
    } else {
      document.documentElement.style.setProperty('--overlay-color', 'transparent');
    }
  }

  applyChatBackground() {
    const image = this.savedChatBackgroundImage || '';
    const posX = parseInt(this.savedChatBackgroundPositionX || '50');
    const posY = parseInt(this.savedChatBackgroundPositionY || '100');
    const sizeW = parseInt(this.savedChatBackgroundSizeWidth || '70');
    const opacity = (this.savedChatBackgroundOpacity || 100) / 100;
    const blur = parseInt(this.savedChatBackgroundBlur || '0') || 0;
    const overlayColor = this.savedChatOverlayColor || '#000000';
    const overlayOpacity = (this.savedChatOverlayOpacity || 0) / 100;

    if (image) {
      document.documentElement.style.setProperty('--chat-background-image', `url('${image}')`);
    } else {
      document.documentElement.style.removeProperty('--chat-background-image');
    }
    document.documentElement.style.setProperty('--chat-background-position', `${posX}% ${posY}%`);
    document.documentElement.style.setProperty('--chat-background-size', `${sizeW}% auto`);
    document.documentElement.style.setProperty('--chat-background-opacity', opacity);
    document.documentElement.style.setProperty('--chat-background-blur', `${blur}px`);
    if (overlayOpacity > 0) {
      document.documentElement.style.setProperty('--chat-overlay-color', `${overlayColor}${Math.round(overlayOpacity * 255).toString(16).padStart(2, '0')}`);
    } else {
      document.documentElement.style.setProperty('--chat-overlay-color', 'transparent');
    }
  }

  applyCardOpacity() {
    const taskOpacity = document.getElementById('taskCardOpacity').value / 100;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value / 100;
    const financeOpacity = document.getElementById('financeCardOpacity').value / 100;
    const calendarOpacity = document.getElementById('calendarOpacity').value / 100;
    const budgetOpacity = document.getElementById('budgetOpacity').value / 100;
    const secretOpacity = document.getElementById('secretCardOpacity').value / 100;
    const reminderOpacity = document.getElementById('reminderCardOpacity').value / 100;
    const memoOpacity = document.getElementById('memoCardOpacity').value / 100;
    
    document.documentElement.style.setProperty('--task-card-opacity', taskOpacity);
    document.documentElement.style.setProperty('--expense-card-opacity', expenseOpacity);
    document.documentElement.style.setProperty('--finance-card-opacity', financeOpacity);
    document.documentElement.style.setProperty('--calendar-opacity', calendarOpacity);
    document.documentElement.style.setProperty('--budget-opacity', budgetOpacity);
    document.documentElement.style.setProperty('--secret-card-opacity', secretOpacity);
    document.documentElement.style.setProperty('--reminder-card-opacity', reminderOpacity);
    document.documentElement.style.setProperty('--memo-card-opacity', memoOpacity);
    
    document.querySelectorAll('.task-card, .task-group').forEach(card => {
      card.style.opacity = taskOpacity;
    });
    
    document.querySelectorAll('.expense-item, .expenses-list .item-card.expense-card').forEach(card => {
      card.style.opacity = expenseOpacity;
    });
    
    document.querySelectorAll('.statistics-panel').forEach(panel => {
      panel.style.opacity = financeOpacity;
    });
    
    document.querySelectorAll('.expenses-calendar-section, .calendar-grid, .calendar-weekdays').forEach(calendar => {
      calendar.style.opacity = calendarOpacity;
    });
    
    document.querySelectorAll('.category-budget-panel, .category-budget-list, .category-budget-item-display').forEach(budget => {
      budget.style.opacity = budgetOpacity;
    });
    
    document.querySelectorAll('.secret-card').forEach(card => {
      card.style.opacity = secretOpacity;
    });

    document.querySelectorAll('.reminder-card').forEach(card => {
      card.style.opacity = reminderOpacity;
    });

    document.querySelectorAll('.memo-card').forEach(card => {
      card.style.opacity = memoOpacity;
    });
  }

  getSavedSettings() {
    return {
      taskOpacity: this.savedTaskOpacity,
      expenseOpacity: this.savedExpenseOpacity,
      financeOpacity: this.savedFinanceOpacity,
      calendarOpacity: this.savedCalendarOpacity,
      budgetOpacity: this.savedBudgetOpacity,
      secretOpacity: this.savedSecretOpacity,
      reminderOpacity: this.savedReminderOpacity,
      memoOpacity: this.savedMemoOpacity,
      darkBackgroundImage: this.savedDarkBackgroundImage,
      darkBackgroundPositionX: this.savedDarkBackgroundPositionX,
      darkBackgroundPositionY: this.savedDarkBackgroundPositionY,
      darkBackgroundSizeWidth: this.savedDarkBackgroundSizeWidth,
      darkBackgroundOpacity: this.savedDarkBackgroundOpacity,
      darkOverlayColor: this.savedDarkOverlayColor,
      darkOverlayOpacity: this.savedDarkOverlayOpacity,
      darkInvert: this.savedDarkInvert,
      lightBackgroundImage: this.savedLightBackgroundImage,
      lightBackgroundPositionX: this.savedLightBackgroundPositionX,
      lightBackgroundPositionY: this.savedLightBackgroundPositionY,
      lightBackgroundSizeWidth: this.savedLightBackgroundSizeWidth,
      lightBackgroundOpacity: this.savedLightBackgroundOpacity,
      lightOverlayColor: this.savedLightOverlayColor,
      lightOverlayOpacity: this.savedLightOverlayOpacity,
      lightInvert: this.savedLightInvert,
      chatBackgroundImage: this.savedChatBackgroundImage,
      chatBackgroundPositionX: this.savedChatBackgroundPositionX,
      chatBackgroundPositionY: this.savedChatBackgroundPositionY,
      chatBackgroundSizeWidth: this.savedChatBackgroundSizeWidth,
      chatBackgroundOpacity: this.savedChatBackgroundOpacity,
      chatBackgroundBlur: this.savedChatBackgroundBlur,
      chatOverlayColor: this.savedChatOverlayColor,
      chatOverlayOpacity: this.savedChatOverlayOpacity
    };
  }

  previewThemeChange(isDark) {
    const root = document.documentElement;
    const titleEl = document.querySelector('.titlebar-title');
    const isTest = window.isTestVersion === true;
    
    if (isDark) {
      root.classList.add('dark-mode');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Philia Beta' : 'Philia';
      }
    } else {
      root.classList.remove('dark-mode');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Elysia Beta' : 'Elysia';
      }
    }
    this.applyBackgroundSettings();
  }

  previewCardOpacity() {
    const taskOpacity = document.getElementById('taskCardOpacity').value / 100;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value / 100;
    const financeOpacity = document.getElementById('financeCardOpacity').value / 100;
    const calendarOpacity = document.getElementById('calendarOpacity').value / 100;
    const budgetOpacity = document.getElementById('budgetOpacity').value / 100;
    const secretOpacity = document.getElementById('secretCardOpacity').value / 100;
    const reminderOpacity = document.getElementById('reminderCardOpacity').value / 100;
    const memoOpacity = document.getElementById('memoCardOpacity').value / 100;
    
    document.documentElement.style.setProperty('--task-card-opacity', taskOpacity);
    document.documentElement.style.setProperty('--expense-card-opacity', expenseOpacity);
    document.documentElement.style.setProperty('--finance-card-opacity', financeOpacity);
    document.documentElement.style.setProperty('--calendar-opacity', calendarOpacity);
    document.documentElement.style.setProperty('--budget-opacity', budgetOpacity);
    document.documentElement.style.setProperty('--secret-card-opacity', secretOpacity);
    document.documentElement.style.setProperty('--reminder-card-opacity', reminderOpacity);
    document.documentElement.style.setProperty('--memo-card-opacity', memoOpacity);
    
    document.querySelectorAll('.task-card, .task-group').forEach(card => {
      card.style.opacity = taskOpacity;
    });
    
    document.querySelectorAll('.expense-item, .expenses-list .item-card.expense-card').forEach(card => {
      card.style.opacity = expenseOpacity;
    });
    
    document.querySelectorAll('.statistics-panel').forEach(panel => {
      panel.style.opacity = financeOpacity;
    });
    
    document.querySelectorAll('.expenses-calendar-section, .calendar-grid, .calendar-weekdays').forEach(calendar => {
      calendar.style.opacity = calendarOpacity;
    });
    
    document.querySelectorAll('.category-budget-panel, .category-budget-list, .category-budget-item-display').forEach(budget => {
      budget.style.opacity = budgetOpacity;
    });
    
    document.querySelectorAll('.secret-card').forEach(card => {
      card.style.opacity = secretOpacity;
    });

    document.querySelectorAll('.reminder-card').forEach(card => {
      card.style.opacity = reminderOpacity;
    });

    document.querySelectorAll('.memo-card').forEach(card => {
      card.style.opacity = memoOpacity;
    });
  }

  async saveBackgroundSettings() {
    // ★ 防抖：滑块拖拽时 input 事件高频触发，合并为 300ms 后一次保存
    if (this._bgSaveTimer) clearTimeout(this._bgSaveTimer);
    return new Promise((resolve) => {
      this._bgSaveTimer = setTimeout(async () => {
        try {
          const themeMode = document.querySelector('input[name="themeMode"]:checked').value;
      const taskOpacity = document.getElementById('taskCardOpacity').value;
      const expenseOpacity = document.getElementById('expenseCardOpacity').value;
      const financeOpacity = document.getElementById('financeCardOpacity').value;
      const calendarOpacity = document.getElementById('calendarOpacity').value;
      const budgetOpacity = document.getElementById('budgetOpacity').value;
      const secretOpacity = document.getElementById('secretCardOpacity').value;
      const reminderOpacity = document.getElementById('reminderCardOpacity').value;
      const memoOpacity = document.getElementById('memoCardOpacity').value;
      
      const darkBackgroundPositionX = document.getElementById('darkBackgroundPositionX').value;
      const darkBackgroundPositionY = document.getElementById('darkBackgroundPositionY').value;
      const darkBackgroundSizeWidth = document.getElementById('darkBackgroundSizeWidth').value;
      const darkBackgroundOpacity = document.getElementById('darkBackgroundOpacity').value;
      const darkOverlayColor = document.getElementById('darkOverlayColor').value;
      const darkOverlayOpacity = document.getElementById('darkOverlayOpacity').value;
      const darkInvert = document.querySelector('input[name="darkInvert"]:checked').value;
      
      const lightBackgroundPositionX = document.getElementById('lightBackgroundPositionX').value;
      const lightBackgroundPositionY = document.getElementById('lightBackgroundPositionY').value;
      const lightBackgroundSizeWidth = document.getElementById('lightBackgroundSizeWidth').value;
      const lightBackgroundOpacity = document.getElementById('lightBackgroundOpacity').value;
      const lightOverlayColor = document.getElementById('lightOverlayColor').value;
      const lightOverlayOpacity = document.getElementById('lightOverlayOpacity').value;
      const lightInvert = document.querySelector('input[name="lightInvert"]:checked').value;

      const chatBackgroundPositionX = document.getElementById('chatBackgroundPositionX').value;
      const chatBackgroundPositionY = document.getElementById('chatBackgroundPositionY').value;
      const chatBackgroundSizeWidth = document.getElementById('chatBackgroundSizeWidth').value;
      const chatBackgroundOpacity = document.getElementById('chatBackgroundOpacity').value;
      const chatBackgroundBlur = document.getElementById('chatBackgroundBlur').value;
      const chatOverlayColor = document.getElementById('chatOverlayColor').value;
      const chatOverlayOpacity = document.getElementById('chatOverlayOpacity').value;

      await ipcRenderer.invoke('save-settings', {
        theme: themeMode,
        taskCardOpacity: taskOpacity,
        expenseCardOpacity: expenseOpacity,
        financeCardOpacity: financeOpacity,
        calendarOpacity: calendarOpacity,
        budgetOpacity: budgetOpacity,
        secretCardOpacity: secretOpacity,
        reminderCardOpacity: reminderOpacity,
        memoCardOpacity: memoOpacity,
        darkBackgroundImage: this.savedDarkBackgroundImage ? encodeURIComponent(this.savedDarkBackgroundImage) : '',
        darkBackgroundPositionX: darkBackgroundPositionX,
        darkBackgroundPositionY: darkBackgroundPositionY,
        darkBackgroundSizeWidth: darkBackgroundSizeWidth,
        darkBackgroundOpacity: darkBackgroundOpacity,
        darkOverlayColor: darkOverlayColor,
        darkOverlayOpacity: darkOverlayOpacity,
        darkInvert: darkInvert,
        lightBackgroundImage: this.savedLightBackgroundImage ? encodeURIComponent(this.savedLightBackgroundImage) : '',
        lightBackgroundPositionX: lightBackgroundPositionX,
        lightBackgroundPositionY: lightBackgroundPositionY,
        lightBackgroundSizeWidth: lightBackgroundSizeWidth,
        lightBackgroundOpacity: lightBackgroundOpacity,
        lightOverlayColor: lightOverlayColor,
        lightOverlayOpacity: lightOverlayOpacity,
        lightInvert: lightInvert,
        chatBackgroundImage: this.savedChatBackgroundImage ? encodeURIComponent(this.savedChatBackgroundImage) : '',
        chatBackgroundPositionX: chatBackgroundPositionX,
        chatBackgroundPositionY: chatBackgroundPositionY,
        chatBackgroundSizeWidth: chatBackgroundSizeWidth,
        chatBackgroundOpacity: chatBackgroundOpacity,
        chatBackgroundBlur: chatBackgroundBlur,
        chatOverlayColor: chatOverlayColor,
        chatOverlayOpacity: chatOverlayOpacity
      });

      this.savedDarkBackgroundPositionX = darkBackgroundPositionX;
      this.savedDarkBackgroundPositionY = darkBackgroundPositionY;
      this.savedDarkBackgroundSizeWidth = darkBackgroundSizeWidth;
      this.savedDarkBackgroundOpacity = darkBackgroundOpacity;
      this.savedDarkOverlayColor = darkOverlayColor;
      this.savedDarkOverlayOpacity = darkOverlayOpacity;
      this.savedDarkInvert = darkInvert;
      
      this.savedLightBackgroundPositionX = lightBackgroundPositionX;
      this.savedLightBackgroundPositionY = lightBackgroundPositionY;
      this.savedLightBackgroundSizeWidth = lightBackgroundSizeWidth;
      this.savedLightBackgroundOpacity = lightBackgroundOpacity;
      this.savedLightOverlayColor = lightOverlayColor;
      this.savedLightOverlayOpacity = lightOverlayOpacity;
      this.savedLightInvert = lightInvert;

      this.savedChatBackgroundPositionX = chatBackgroundPositionX;
      this.savedChatBackgroundPositionY = chatBackgroundPositionY;
      this.savedChatBackgroundSizeWidth = chatBackgroundSizeWidth;
      this.savedChatBackgroundOpacity = chatBackgroundOpacity;
      this.savedChatBackgroundBlur = chatBackgroundBlur;
      this.savedChatOverlayColor = chatOverlayColor;
      this.savedChatOverlayOpacity = chatOverlayOpacity;
          resolve(true);
        } catch (e) {
          console.error('保存背景设置失败:', e);
          resolve(false);
        }
      }, 300);
    });
  }
}

module.exports = { ThemeManager };
