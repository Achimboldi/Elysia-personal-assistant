const { ipcRenderer } = require('electron');
const { dom } = require('./dom-utils');

class TaskManager {
  constructor(appController) {
    this.appController = appController;
    this.tasks = [];
  }

  async loadTasks() {
    try {
      this.tasks = await ipcRenderer.invoke('get-tasks');
      return this.tasks;
    } catch (error) {
      console.error('[TaskManager] 加载任务失败:', error);
      this.tasks = [];
      return [];
    }
  }

  async addTask(taskData) {
    try {
      const tempIndex = this.tasks.length;
      this.tasks.push(taskData);
      
      const result = await ipcRenderer.invoke('add-task', taskData);
      if (result.success && result.task) {
        this.tasks[tempIndex] = { ...this.tasks[tempIndex], id: result.task.id };
      } else if (!result.success) {
        this.tasks.pop();
      }
      return result;
    } catch (error) {
      this.tasks.pop();
      console.error('[TaskManager] 添加任务失败:', error);
      return { success: false, message: '添加任务失败: ' + error.message };
    }
  }

  async updateTask(taskId, updates) {
    try {
      const index = this.tasks.findIndex(t => String(t.id) === String(taskId));
      const oldTask = index !== -1 ? { ...this.tasks[index] } : null;
      
      if (index !== -1) {
        this.tasks[index] = { ...this.tasks[index], ...updates };
      }

      const result = await ipcRenderer.invoke('update-task', taskId, updates);
      if (!result.success && oldTask) {
        if (index !== -1) {
          // ★ 修复：失败时只回滚本次提交的字段，避免把用户紧接着修改的其他字段（进度/子任务）也冲掉
          const current = this.tasks[index];
          const rollback = {};
          for (const key of Object.keys(updates || {})) {
            rollback[key] = oldTask[key];
          }
          this.tasks[index] = { ...current, ...rollback };
        }
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 更新任务失败:', error);
      return { success: false, message: '更新任务失败: ' + error.message };
    }
  }

  async toggleTaskCompleted(taskId) {
    try {
      const index = this.tasks.findIndex(t => String(t.id) === String(taskId));
      if (index !== -1) {
        this.tasks[index].completed = !this.tasks[index].completed;
        this.tasks[index].completedAt = this.tasks[index].completed ? new Date().toISOString() : null;
        this.tasks[index].progress = this.tasks[index].completed ? 'completed' : 'pending';
      }

      const result = await ipcRenderer.invoke('toggle-task-completed', taskId);
      if (!result.success && index !== -1) {
        this.tasks[index].completed = !this.tasks[index].completed;
        this.tasks[index].completedAt = this.tasks[index].completed ? new Date().toISOString() : null;
        this.tasks[index].progress = this.tasks[index].completed ? 'completed' : 'pending';
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 切换任务完成状态失败:', error);
      return { success: false, message: '切换状态失败: ' + error.message };
    }
  }

  async pinTask(taskId) {
    try {
      const index = this.tasks.findIndex(t => String(t.id) === String(taskId));
      if (index !== -1) {
        this.tasks[index].pinned = !this.tasks[index].pinned;
      }

      const result = await ipcRenderer.invoke('pin-task', taskId);
      if (!result.success && index !== -1) {
        this.tasks[index].pinned = !this.tasks[index].pinned;
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 置顶任务失败:', error);
      return { success: false, message: '置顶失败: ' + error.message };
    }
  }

  async deleteTask(taskId) {
    try {
      const index = this.tasks.findIndex(t => String(t.id) === String(taskId));
      const deletedTask = index !== -1 ? this.tasks[index] : null;
      if (index !== -1) {
        this.tasks.splice(index, 1);
      }

      const result = await ipcRenderer.invoke('delete-task', taskId);
      if (!result.success && deletedTask) {
        this.tasks.splice(index, 0, deletedTask);
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 删除任务失败:', error);
      return { success: false, message: '删除任务失败: ' + error.message };
    }
  }

  async saveTasks(tasks) {
    try {
      const result = await ipcRenderer.invoke('save-tasks', tasks);
      if (result.success) {
        await this.loadTasks();
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 保存任务失败:', error);
      return { success: false, message: '保存任务失败: ' + error.message };
    }
  }

  async saveTasksDirect(task) {
    try {
      const result = await ipcRenderer.invoke('save-task-direct', task);
      if (result.success) {
        await this.loadTasks();
      }
      return result;
    } catch (error) {
      console.error('[TaskManager] 直接保存任务失败:', error);
      return { success: false, message: '保存任务失败: ' + error.message };
    }
  }

  getTasks() {
    return this.tasks;
  }

  getTaskById(taskId) {
    return this.tasks.find(t => String(t.id) === String(taskId));
  }

  getTasksByDate(dateStr) {
    return this.tasks.filter(task => {
      const startDate = task.startDate;
      const endDate = task.endDate;
      return startDate && dateStr >= startDate && (!endDate || dateStr <= endDate);
    });
  }

  getPendingTasks() {
    return this.tasks.filter(t => t.completed !== true);
  }

  getCompletedTasks() {
    return this.tasks.filter(t => t.completed === true);
  }

  getPinnedTasks() {
    return this.tasks.filter(t => t.pinned === true);
  }

  searchTasks(keyword) {
    if (!keyword) return this.tasks;
    const lowerKeyword = keyword.toLowerCase();
    return this.tasks.filter(task => 
      task.title.toLowerCase().includes(lowerKeyword) ||
      task.description.toLowerCase().includes(lowerKeyword)
    );
  }
}

module.exports = { TaskManager };
