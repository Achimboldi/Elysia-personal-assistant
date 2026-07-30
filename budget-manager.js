const { ipcRenderer } = require('electron');

class BudgetManager {
  constructor(appController) {
    this.appController = appController;
    this.budgets = [];
    this.categoryBudgets = [];
  }

  async saveBudgets(budgets, selectedIndex) {
    try {
      const oldBudgets = [...this.budgets];
      this.budgets = budgets;
      
      const result = await ipcRenderer.invoke('save-budgets', { budgets, selectedIndex });
      if (!result.success) {
        this.budgets = oldBudgets;
      } else if (result.categoryBudgets) {
        this.categoryBudgets = result.categoryBudgets;
      }
      return result;
    } catch (error) {
      console.error('[BudgetManager] 保存预算列表失败:', error);
      return { success: false, message: '保存预算列表失败: ' + error.message };
    }
  }

  async loadBudgets() {
    try {
      this.budgets = await ipcRenderer.invoke('get-budgets');
      this.categoryBudgets = await ipcRenderer.invoke('get-category-budgets');
      return { budgets: this.budgets || [], categoryBudgets: this.categoryBudgets || [] };
    } catch (error) {
      console.error('[BudgetManager] 加载预算失败:', error);
      this.budgets = [];
      this.categoryBudgets = [];
      return { budgets: [], categoryBudgets: [] };
    }
  }

  async saveBudget(budget) {
    try {
      const now = new Date().toISOString();
      if (!budget.id) {
        budget.id = require('uuid').v4();
        budget.createdAt = now;
      }
      budget.updatedAt = now;
      
      const index = this.budgets.findIndex(b => String(b.id) === String(budget.id));
      const oldBudget = index !== -1 ? { ...this.budgets[index] } : null;
      
      if (index !== -1) {
        this.budgets[index] = { ...this.budgets[index], ...budget };
      } else {
        this.budgets.push(budget);
      }
      
      const result = await ipcRenderer.invoke('save-budget', budget);
      if (!result.success && oldBudget) {
        if (index !== -1) {
          this.budgets[index] = oldBudget;
        } else {
          this.budgets.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[BudgetManager] 保存预算失败:', error);
      return { success: false, message: '保存预算失败: ' + error.message };
    }
  }

  async deleteBudget(budgetId) {
    try {
      const index = this.budgets.findIndex(b => String(b.id) === String(budgetId));
      const deletedBudget = index !== -1 ? this.budgets[index] : null;
      
      if (index !== -1) {
        this.budgets.splice(index, 1);
      }
      
      const result = await ipcRenderer.invoke('delete-budget', budgetId);
      if (!result.success && deletedBudget) {
        this.budgets.splice(index, 0, deletedBudget);
      }
      return result;
    } catch (error) {
      console.error('[BudgetManager] 删除预算失败:', error);
      return { success: false, message: '删除预算失败: ' + error.message };
    }
  }

  async saveCategoryBudget(categoryBudget) {
    try {
      const now = new Date().toISOString();
      if (!categoryBudget.id) {
        categoryBudget.id = require('uuid').v4();
        categoryBudget.createdAt = now;
      }
      categoryBudget.updatedAt = now;
      
      const index = this.categoryBudgets.findIndex(cb => String(cb.id) === String(categoryBudget.id));
      const oldCategoryBudget = index !== -1 ? { ...this.categoryBudgets[index] } : null;
      
      if (index !== -1) {
        this.categoryBudgets[index] = { ...this.categoryBudgets[index], ...categoryBudget };
      } else {
        this.categoryBudgets.push(categoryBudget);
      }
      
      const result = await ipcRenderer.invoke('save-category-budget', categoryBudget);
      if (!result.success && oldCategoryBudget) {
        if (index !== -1) {
          this.categoryBudgets[index] = oldCategoryBudget;
        } else {
          this.categoryBudgets.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[BudgetManager] 保存分类预算失败:', error);
      return { success: false, message: '保存分类预算失败: ' + error.message };
    }
  }

  async deleteCategoryBudget(categoryBudgetId) {
    try {
      const index = this.categoryBudgets.findIndex(cb => String(cb.id) === String(categoryBudgetId));
      const deletedCategoryBudget = index !== -1 ? this.categoryBudgets[index] : null;
      
      if (index !== -1) {
        this.categoryBudgets.splice(index, 1);
      }
      
      const result = await ipcRenderer.invoke('delete-category-budget', categoryBudgetId);
      if (!result.success && deletedCategoryBudget) {
        this.categoryBudgets.splice(index, 0, deletedCategoryBudget);
      }
      return result;
    } catch (error) {
      console.error('[BudgetManager] 删除分类预算失败:', error);
      return { success: false, message: '删除分类预算失败: ' + error.message };
    }
  }

  getBudgets() {
    return this.budgets;
  }

  getCategoryBudgets() {
    return this.categoryBudgets;
  }

  getBudgetById(budgetId) {
    return this.budgets.find(b => String(b.id) === String(budgetId));
  }

  getCategoryBudgetById(categoryBudgetId) {
    return this.categoryBudgets.find(cb => String(cb.id) === String(categoryBudgetId));
  }

  getBudgetsByPeriod(period) {
    return this.budgets.filter(b => b.period === period);
  }

  getCategoryBudgetsByBudgetId(budgetId) {
    return this.categoryBudgets.filter(cb => cb.budgetId === budgetId);
  }

  getCurrentBudget() {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    return this.budgets.find(b => {
      if (b.period === 'monthly') {
        return true;
      }
      if (b.period === 'yearly') {
        return b.startDate && b.startDate.startsWith(String(now.getFullYear()));
      }
      if (b.period === 'custom') {
        return b.startDate && b.endDate && currentMonth >= b.startDate && currentMonth <= b.endDate;
      }
      return false;
    });
  }
}

module.exports = { BudgetManager };
