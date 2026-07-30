const { ipcRenderer } = require('electron');

class SecretManager {
  constructor(appController) {
    this.appController = appController;
    this.secrets = [];
  }

  async loadSecrets() {
    try {
      this.secrets = await ipcRenderer.invoke('get-secrets');
      return this.secrets;
    } catch (error) {
      console.error('[SecretManager] 加载密钥失败:', error);
      this.secrets = [];
      return [];
    }
  }

  async saveSecret(secret) {
    try {
      const now = new Date().toISOString();
      if (!secret.id) {
        secret.id = require('uuid').v4();
        secret.createdAt = now;
      }
      secret.lastModified = now;
      
      const index = this.secrets.findIndex(s => String(s.id) === String(secret.id));
      const oldSecret = index !== -1 ? { ...this.secrets[index] } : null;
      
      if (index !== -1) {
        this.secrets[index] = { ...this.secrets[index], ...secret };
      } else {
        this.secrets.push(secret);
      }
      
      const result = await ipcRenderer.invoke('save-secret', secret);
      if (!result.success && oldSecret) {
        if (index !== -1) {
          this.secrets[index] = oldSecret;
        } else {
          this.secrets.pop();
        }
      }
      return result;
    } catch (error) {
      console.error('[SecretManager] 保存密钥失败:', error);
      return { success: false, message: '保存密钥失败: ' + error.message };
    }
  }

  async deleteSecret(id) {
    try {
      const index = this.secrets.findIndex(s => String(s.id) === String(id));
      const deletedSecret = index !== -1 ? this.secrets[index] : null;
      
      if (index !== -1) {
        this.secrets.splice(index, 1);
      }
      
      const result = await ipcRenderer.invoke('delete-secret', id);
      if (!result.success && deletedSecret) {
        this.secrets.splice(index, 0, deletedSecret);
      }
      return result;
    } catch (error) {
      console.error('[SecretManager] 删除密钥失败:', error);
      return { success: false, message: '删除密钥失败: ' + error.message };
    }
  }

  async pinSecret(id) {
    try {
      const index = this.secrets.findIndex(s => String(s.id) === String(id));
      if (index !== -1) {
        const oldPinned = this.secrets[index].pinned;
        this.secrets[index].pinned = true;
        this.secrets[index].lastModified = new Date().toISOString();
        
        const result = await ipcRenderer.invoke('save-secret', this.secrets[index]);
        if (!result.success) {
          this.secrets[index].pinned = oldPinned;
        }
        return result;
      }
      return { success: false, message: '密钥不存在' };
    } catch (error) {
      console.error('[SecretManager] 置顶密钥失败:', error);
      return { success: false, message: '置顶密钥失败: ' + error.message };
    }
  }

  getSecrets() {
    return this.secrets;
  }

  getSecretById(id) {
    return this.secrets.find(s => String(s.id) === String(id));
  }

  getPinnedSecrets() {
    return this.secrets.filter(s => s.pinned === true);
  }

  getUnpinnedSecrets() {
    return this.secrets.filter(s => s.pinned !== true);
  }

  searchSecrets(keyword) {
    if (!keyword) return this.secrets;
    const lowerKeyword = keyword.toLowerCase();
    return this.secrets.filter(secret => 
      secret.name.toLowerCase().includes(lowerKeyword) ||
      secret.categories?.some(cat => cat.toLowerCase().includes(lowerKeyword)) ||
      secret.fields?.some(f => f.label.toLowerCase().includes(lowerKeyword) || f.value.toLowerCase().includes(lowerKeyword))
    );
  }
}

module.exports = { SecretManager };