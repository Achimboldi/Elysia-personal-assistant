const { ipcRenderer } = require('electron');

class JournalManager {
  constructor(appController) {
    this.appController = appController;
    this.journals = [];
  }

  async loadJournals() {
    try {
      this.journals = await ipcRenderer.invoke('get-journals');
      return this.journals;
    } catch (error) {
      console.error('[JournalManager] 加载日记失败:', error);
      this.journals = [];
      return [];
    }
  }

  async saveJournal(journal) {
    try {
      const now = new Date().toISOString();
      
      const index = this.journals.findIndex(j => j.date === journal.date);
      const oldJournal = index !== -1 ? { ...this.journals[index] } : null;
      
      if (index !== -1) {
        journal.id = this.journals[index].id;
        journal.createdAt = this.journals[index].createdAt;
        // ★ 创建者标签不可变：编辑时保留原 creator
        if (this.journals[index].creator !== undefined) {
          journal.creator = this.journals[index].creator;
        }
      } else {
        journal.id = require('uuid').v4();
        journal.createdAt = now;
      }
      journal.updatedAt = now;
      
      if (index !== -1) {
        // ★ 保留原 creator，避免被 journal 中的值覆盖
        const originalCreator = this.journals[index].creator;
        this.journals[index] = { ...this.journals[index], ...journal };
        if (originalCreator !== undefined) {
          this.journals[index].creator = originalCreator;
        }
      } else {
        this.journals.push(journal);
      }
      
      const result = await ipcRenderer.invoke('save-journal', journal);
      if (!result.success && oldJournal) {
        if (index !== -1) {
          this.journals[index] = oldJournal;
        } else {
          this.journals.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[JournalManager] 保存日记失败:', error);
      return { success: false, message: '保存日记失败: ' + error.message };
    }
  }

  async deleteJournal(id) {
    try {
      const index = this.journals.findIndex(j => String(j.id) === String(id));
      const deletedJournal = index !== -1 ? this.journals[index] : null;
      
      if (index !== -1) {
        this.journals.splice(index, 1);
      }
      
      const result = await ipcRenderer.invoke('delete-journal', id);
      if (!result.success && deletedJournal) {
        this.journals.splice(index, 0, deletedJournal);
      }
      return result;
    } catch (error) {
      console.error('[JournalManager] 删除日记失败:', error);
      return { success: false, message: '删除日记失败: ' + error.message };
    }
  }

  getJournals() {
    return this.journals;
  }

  getJournalByDate(dateStr) {
    return this.journals.find(j => j.date === dateStr || j.date.startsWith(dateStr));
  }

  getJournalById(id) {
    return this.journals.find(j => String(j.id) === String(id));
  }

  getJournalsByMonth(year, month) {
    const monthStr = String(month).padStart(2, '0');
    const pattern = `${year}-${monthStr}-`;
    return this.journals.filter(j => j.date.startsWith(pattern));
  }

  searchJournals(keyword) {
    if (!keyword) return this.journals;
    const lowerKeyword = keyword.toLowerCase();
    return this.journals.filter(journal => 
      journal.content.toLowerCase().includes(lowerKeyword)
    );
  }

  hasJournalForDate(dateStr) {
    return this.journals.some(j => j.date === dateStr || j.date.startsWith(dateStr));
  }
}

module.exports = { JournalManager };