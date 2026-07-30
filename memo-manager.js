const { ipcRenderer } = require('electron');
const { dom } = require('./dom-utils');

class MemoManager {
  constructor(appController) {
    this.appController = appController;
    this.memos = [];
    this.showPrivateMemos = false;
  }

  async loadMemos() {
    try {
      this.memos = await ipcRenderer.invoke('get-memos');
      return this.memos;
    } catch (error) {
      console.error('[MemoManager] 加载备忘录失败:', error);
      this.memos = [];
      return [];
    }
  }

  async saveMemo(memo) {
    try {
      const now = new Date().toISOString();
      if (!memo.id) {
        memo.id = require('uuid').v4();
        memo.createdAt = now;
      }
      memo.lastModified = now;

      const index = this.memos.findIndex(m => String(m.id) === String(memo.id));
      const oldMemo = index !== -1 ? { ...this.memos[index] } : null;
      
      if (index !== -1) {
        this.memos[index] = { ...this.memos[index], ...memo };
      } else {
        this.memos.push(memo);
      }
      
      const result = await ipcRenderer.invoke('save-memo', memo);
      if (!result.success && oldMemo) {
        if (index !== -1) {
          this.memos[index] = oldMemo;
        } else {
          this.memos.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[MemoManager] 保存备忘录失败:', error);
      return { success: false, message: '保存备忘录失败: ' + error.message };
    }
  }

  async deleteMemo(memoId) {
    try {
      const index = this.memos.findIndex(m => String(m.id) === String(memoId));
      const deletedMemo = index !== -1 ? this.memos[index] : null;
      if (index !== -1) {
        this.memos.splice(index, 1);
      }

      const result = await ipcRenderer.invoke('delete-memo', memoId);
      if (!result.success && deletedMemo) {
        this.memos.splice(index, 0, deletedMemo);
      }
      return result;
    } catch (error) {
      console.error('[MemoManager] 删除备忘录失败:', error);
      return { success: false, message: '删除备忘录失败: ' + error.message };
    }
  }

  async pinMemo(memoId) {
    try {
      const index = this.memos.findIndex(m => String(m.id) === String(memoId));
      if (index !== -1) {
        this.memos[index].pinned = !this.memos[index].pinned;
      }

      const result = await ipcRenderer.invoke('pin-memo', memoId);
      if (!result.success && index !== -1) {
        this.memos[index].pinned = !this.memos[index].pinned;
      }
      return result;
    } catch (error) {
      console.error('[MemoManager] 置顶备忘录失败:', error);
      return { success: false, message: '置顶失败: ' + error.message };
    }
  }

  async togglePrivateMemo(memoId) {
    try {
      const index = this.memos.findIndex(m => String(m.id) === String(memoId));
      if (index !== -1) {
        this.memos[index].isPrivate = !this.memos[index].isPrivate;
      }

      const result = await ipcRenderer.invoke('toggle-private-memo', memoId);
      if (!result.success && index !== -1) {
        this.memos[index].isPrivate = !this.memos[index].isPrivate;
      }
      return result;
    } catch (error) {
      console.error('[MemoManager] 切换私密状态失败:', error);
      return { success: false, message: '切换状态失败: ' + error.message };
    }
  }

  async saveMemoOrder(memosWithOrder) {
    try {
      const oldMemos = [...this.memos];
      this.memos = memosWithOrder;
      
      const result = await ipcRenderer.invoke('save-memo-order', memosWithOrder);
      if (!result.success) {
        this.memos = oldMemos;
      }
      return result;
    } catch (error) {
      console.error('[MemoManager] 保存备忘录顺序失败:', error);
      return { success: false, message: '保存顺序失败: ' + error.message };
    }
  }

  async createStickyNote(memo) {
    try {
      const result = await ipcRenderer.invoke('create-sticky-note', memo);
      return result;
    } catch (error) {
      console.error('[MemoManager] 创建便签失败:', error);
      return { success: false, message: '创建便签失败: ' + error.message };
    }
  }

  async closeStickyNote(memoId) {
    try {
      const result = await ipcRenderer.invoke('close-sticky-note', memoId);
      return result;
    } catch (error) {
      console.error('[MemoManager] 关闭便签失败:', error);
      return { success: false, message: '关闭便签失败: ' + error.message };
    }
  }

  getMemos() {
    if (this.showPrivateMemos) {
      return this.memos;
    }
    return this.memos.filter(m => !m.isPrivate);
  }

  getAllMemos() {
    return this.memos;
  }

  getMemoById(memoId) {
    return this.memos.find(m => String(m.id) === String(memoId));
  }

  getPinnedMemos() {
    const memos = this.showPrivateMemos ? this.memos : this.memos.filter(m => !m.isPrivate);
    return memos.filter(m => m.pinned === true);
  }

  getUnpinnedMemos() {
    const memos = this.showPrivateMemos ? this.memos : this.memos.filter(m => !m.isPrivate);
    return memos.filter(m => m.pinned !== true);
  }

  searchMemos(keyword) {
    const memos = this.showPrivateMemos ? this.memos : this.memos.filter(m => !m.isPrivate);
    if (!keyword) return memos;
    const lowerKeyword = keyword.toLowerCase();
    return memos.filter(memo => 
      memo.title.toLowerCase().includes(lowerKeyword) ||
      (memo.content || '').toLowerCase().includes(lowerKeyword) ||
      ((memo.htmlContent || '').replace(/<[^>]*>/g, '')).toLowerCase().includes(lowerKeyword)
    );
  }

  setShowPrivateMemos(value) {
    this.showPrivateMemos = value;
  }

  getShowPrivateMemos() {
    return this.showPrivateMemos;
  }
}

module.exports = { MemoManager };
