const { ipcRenderer } = require('electron');

class ExpenseManager {
  constructor(appController) {
    this.appController = appController;
    this.expenses = [];
  }

  async loadExpenses() {
    try {
      const rawExpenses = await ipcRenderer.invoke('get-expenses');
      this.expenses = rawExpenses.map(expense => {
        let type = expense.type;
        if (type === 0 || type === '0') {
          type = 'expense';
        } else if (type === 1 || type === '1') {
          type = 'income';
        }
        return {
          ...expense,
          amount: typeof expense.amount === 'string' ? parseFloat(expense.amount) || 0 : expense.amount,
          type: type
        };
      });
      return this.expenses;
    } catch (error) {
      console.error('[ExpenseManager] 加载收支失败:', error);
      this.expenses = [];
      return [];
    }
  }

  async addExpense(expenseData) {
    try {
      const now = new Date().toISOString();
      const expense = {
        ...expenseData,
        createdAt: now,
        updatedAt: now
      };
      
      const tempIndex = this.expenses.length;
      this.expenses.push(expense);
      
      const result = await ipcRenderer.invoke('add-expense', expense);
      if (result.success && result.expense) {
        this.expenses[tempIndex] = { ...this.expenses[tempIndex], id: result.expense.id };
      } else if (!result.success) {
        this.expenses.pop();
      }
      return result;
    } catch (error) {
      this.expenses.pop();
      console.error('[ExpenseManager] 添加收支失败:', error);
      return { success: false, message: '添加收支失败: ' + error.message };
    }
  }

  async updateExpense(expenseId, updates) {
    try {
      const index = this.expenses.findIndex(e => String(e.id) === String(expenseId));
      const oldExpense = index !== -1 ? { ...this.expenses[index] } : null;
      
      if (index !== -1) {
        this.expenses[index] = { ...this.expenses[index], ...updates, updatedAt: new Date().toISOString() };
      }
      
      const result = await ipcRenderer.invoke('update-expense', expenseId, updates);
      if (!result.success && oldExpense) {
        if (index !== -1) {
          this.expenses[index] = oldExpense;
        }
      }
      return result;
    } catch (error) {
      console.error('[ExpenseManager] 更新收支失败:', error);
      return { success: false, message: '更新收支失败: ' + error.message };
    }
  }

  async deleteExpense(expenseId) {
    try {
      const index = this.expenses.findIndex(e => String(e.id) === String(expenseId));
      const deletedExpense = index !== -1 ? this.expenses[index] : null;
      
      if (index !== -1) {
        this.expenses.splice(index, 1);
      }
      
      const result = await ipcRenderer.invoke('delete-expense', expenseId);
      if (!result.success && deletedExpense) {
        this.expenses.splice(index, 0, deletedExpense);
      }
      return result;
    } catch (error) {
      console.error('[ExpenseManager] 删除收支失败:', error);
      return { success: false, message: '删除收支失败: ' + error.message };
    }
  }

  async saveExpense(expense) {
    try {
      const now = new Date().toISOString();
      if (!expense.id) {
        expense.id = require('uuid').v4();
        expense.createdAt = now;
      }
      expense.updatedAt = now;
      
      const index = this.expenses.findIndex(e => String(e.id) === String(expense.id));
      const oldExpense = index !== -1 ? { ...this.expenses[index] } : null;
      
      if (index !== -1) {
        this.expenses[index] = { ...this.expenses[index], ...expense };
      } else {
        this.expenses.push(expense);
      }
      
      const result = await ipcRenderer.invoke('save-expense', expense);
      if (!result.success && oldExpense) {
        if (index !== -1) {
          this.expenses[index] = oldExpense;
        } else {
          this.expenses.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[ExpenseManager] 保存收支失败:', error);
      return { success: false, message: '保存收支失败: ' + error.message };
    }
  }

  getExpenses() {
    return this.expenses;
  }

  getExpenseById(expenseId) {
    return this.expenses.find(e => String(e.id) === String(expenseId));
  }

  getExpensesByDate(dateStr) {
    return this.expenses.filter(expense => {
      return expense.date === dateStr;
    });
  }

  getExpensesByMonth(year, month) {
    const monthStr = String(month + 1).padStart(2, '0');
    return this.expenses.filter(expense => {
      return expense.date.startsWith(`${year}-${monthStr}`);
    });
  }

  getIncomeTotal(startDate, endDate) {
    return this.expenses
      .filter(e => e.type === 'income' && e.date >= startDate && e.date <= endDate)
      .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  }

  getExpenseTotal(startDate, endDate) {
    return this.expenses
      .filter(e => e.type === 'expense' && e.date >= startDate && e.date <= endDate)
      .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  }

  getExpensesByCategory(category) {
    return this.expenses.filter(e => e.category === category);
  }

  searchExpenses(keyword) {
    if (!keyword) return this.expenses;
    const lowerKeyword = keyword.toLowerCase();
    return this.expenses.filter(expense => 
      expense.description.toLowerCase().includes(lowerKeyword) ||
      expense.category.toLowerCase().includes(lowerKeyword)
    );
  }
}

module.exports = { ExpenseManager };
