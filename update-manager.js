/**
 * Elysia 版本同步管理器（Git 版）
 *
 * 使用 GitHub 进行代码版本同步，替代百度网盘的文件传输方案。
 * - git fetch + pull 替代 baidu 下载/合并
 * - git add + commit + push 替代 baidu 上传
 *
 * 前提：已通过 GitHub Desktop 或 git clone 初始化仓库，remote origin 已配置。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class UpdateManager {
  constructor() {
    this.logger = null;
  }

  setLogger(logger) {
    this.logger = logger;
  }

  log(message) {
    if (this.logger) {
      this.logger(message);
    } else {
      console.log(`[UpdateManager] ${message}`);
    }
  }

  error(message) {
    if (this.logger) {
      this.logger(`ERROR: ${message}`);
    } else {
      console.error(`[UpdateManager] ERROR: ${message}`);
    }
  }

  /**
   * 执行 git 命令
   * @param {string} args - git 参数
   * @param {object} options - { cwd, timeout }
   */
  _git(args, options = {}) {
    const cwd = options.cwd || path.resolve(__dirname);
    try {
      const result = execSync(`git ${args}`, {
        cwd,
        encoding: 'utf8',
        timeout: options.timeout || 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output: result.trim() };
    } catch (e) {
      return {
        success: false,
        output: (e.stderr || e.message || '').trim(),
        code: e.status,
      };
    }
  }

  /** 检测当前目录是否为 git 仓库 */
  _isGitRepo(cwd) {
    const dir = cwd || path.resolve(__dirname);
    return fs.existsSync(path.join(dir, '.git'));
  }

  /** 获取当前本地版本（短 commit hash） */
  getCurrentVersion(cwd) {
    const result = this._git('rev-parse --short HEAD', { cwd });
    return result.success ? result.output : 'unknown';
  }

  /**
   * 检查更新：git fetch 后比较本地与远端
   * @param {string} currentVersion - 可选，当前版本号
   * @param {string} cwd - 仓库目录
   * @returns 是否可更新、落后提交数、变更日志
   */
  async checkForUpdate(currentVersion, cwd) {
    const dir = cwd || path.resolve(__dirname);

    if (!this._isGitRepo(dir)) {
      return {
        success: false,
        message:
          '当前目录不是 Git 仓库。请先用 git clone 初始化，或从 GitHub Desktop 添加。',
      };
    }

    // git fetch
    this.log('正在检查远程更新...');
    const fetchResult = this._git('fetch origin', { cwd: dir, timeout: 60000 });
    if (!fetchResult.success) {
      this.error(`git fetch 失败: ${fetchResult.output}`);
      return {
        success: false,
        message: '无法连接 GitHub，请检查网络。\n' + fetchResult.output,
      };
    }

    // 确定远程分支
    const branchResult = this._git('rev-parse --abbrev-ref HEAD', { cwd: dir });
    const branch = branchResult.success ? branchResult.output : 'main';

    // 比较本地与远端落后多少
    const behindResult = this._git(`rev-list --count HEAD..origin/${branch}`, {
      cwd: dir,
    });
    const behindCount = behindResult.success
      ? parseInt(behindResult.output) || 0
      : 0;

    // 获取变更日志
    let changelog = '';
    if (behindCount > 0) {
      const logResult = this._git(`log --oneline -10 HEAD..origin/${branch}`, {
        cwd: dir,
      });
      changelog = logResult.success ? logResult.output : '';
    }

    return {
      success: true,
      hasUpdate: behindCount > 0,
      currentVersion: currentVersion || this.getCurrentVersion(dir),
      behindCount,
      changelog,
    };
  }

  /**
   * 执行更新：git pull
   * @param {string} cwd - 仓库目录
   * @param {string} versionId - 保留兼容，git 不使用
   * @param {function} onProgress - 进度回调
   */
  async performIncrementalUpdate(cwd, versionId, onProgress) {
    const dir = cwd || path.resolve(__dirname);

    if (!this._isGitRepo(dir)) {
      return {
        success: false,
        message: '当前目录不是 Git 仓库。',
      };
    }

    if (onProgress) {
      onProgress({ status: 'started', message: '正在从 GitHub 拉取更新...' });
    }

    // 先 fetch
    const fetchResult = this._git('fetch origin', { cwd: dir, timeout: 60000 });
    if (!fetchResult.success) {
      if (onProgress) {
        onProgress({
          status: 'finished',
          message: '连接 GitHub 失败',
        });
      }
      return {
        success: false,
        message: '无法连接 GitHub，请检查网络。',
        needRestart: false,
      };
    }

    // 获取分支名
    const branchResult = this._git('rev-parse --abbrev-ref HEAD', { cwd: dir });
    const branch = branchResult.success ? branchResult.output : 'main';

    // git pull
    if (onProgress) {
      onProgress({ status: 'downloading', message: '正在下载更新...' });
    }

    const pullResult = this._git(`pull origin ${branch}`, {
      cwd: dir,
      timeout: 120000,
    });

    if (!pullResult.success) {
      this.error(`git pull 失败: ${pullResult.output}`);
      if (onProgress) {
        onProgress({ status: 'finished', message: '更新失败' });
      }
      return {
        success: false,
        message: '代码同步失败:\n' + pullResult.output,
        needRestart: false,
      };
    }

    const output = pullResult.output.toLowerCase();

    // 判断是否实际有更新
    const noUpdate =
      output.includes('already up to date') || output.includes('already up-to-date');

    if (onProgress) {
      onProgress({
        status: 'finished',
        message: noUpdate ? '已是最新版本' : '更新完成，请重启应用使更改生效',
      });
    }

    return {
      success: true,
      hasUpdate: !noUpdate,
      message: noUpdate
        ? '已是最新版本，无需更新。'
        : '代码已更新，请重启应用使更改生效。',
      needRestart: !noUpdate,
      details: pullResult.output,
    };
  }

  /**
   * 推送本地更改到 GitHub
   * @param {string} cwd - 仓库目录
   * @param {string} commitMsg - 提交信息（可选）
   */
  async pushChanges(cwd, commitMsg) {
    const dir = cwd || path.resolve(__dirname);

    if (!this._isGitRepo(dir)) {
      return {
        success: false,
        message: '当前目录不是 Git 仓库。',
      };
    }

    this.log('正在推送本地更改到 GitHub...');

    // ★ 先 fetch 远程，再判断是否需要 pull --rebase
    const branchResult0 = this._git('rev-parse --abbrev-ref HEAD', { cwd: dir });
    const branch = branchResult0.success ? branchResult0.output : 'main';

    const fetchResult = this._git('fetch origin', { cwd: dir, timeout: 60000 });
    if (!fetchResult.success) {
      this.error(`git fetch 失败: ${fetchResult.output}`);
      // 网络问题：仍然尝试推送（push 不需要 fetch）
      // 但 push 失败的话会报告，这里不阻断
    } else {
      // 检查远程是否领先本地
      const aheadRemote = this._git(
        `rev-list --count HEAD..origin/${branch}`,
        { cwd: dir }
      );
      const remoteAhead = aheadRemote.success
        ? parseInt(aheadRemote.output) || 0
        : 0;

      if (remoteAhead > 0) {
        this.log(`远程有 ${remoteAhead} 个新提交，执行 pull --rebase ...`);
        // --autostash 会自动暂存未提交的本地修改，rebase 后恢复
        const pullResult = this._git(
          `pull --rebase --autostash origin ${branch}`,
          { cwd: dir, timeout: 60000 }
        );
        if (!pullResult.success) {
          // 可能是冲突
          if (pullResult.output.includes('CONFLICT') || pullResult.output.includes('cannot rebase')) {
            return {
              success: false,
              message:
                '⚠️ 远程有 ' + remoteAhead + ' 个新提交，但 rebase 时出现冲突。\n' +
                '请手动处理冲突后重试：\n' +
                '  cd D:\\妙妙小工具\\Elysia\\win-unpacked\\resources\\app\n' +
                '  git status   # 查看冲突文件\n' +
                '  git rebase --abort   # 取消 rebase\n' +
                '  或解决冲突后 git rebase --continue\n\n' +
                'git 输出：\n' + pullResult.output,
            };
          }
          // 其他 pull 错误
          this.error(`git pull --rebase 失败: ${pullResult.output}`);
          return {
            success: false,
            message:
              '⚠️ 拉取远程更新失败：' + pullResult.output +
              '\n已取消推送，避免覆盖远程新提交。',
          };
        }
        this.log('pull --rebase 完成');
      }
    }

    // 检查是否有未提交的更改
    const statusResult = this._git('status --porcelain', { cwd: dir });
    if (!statusResult.success) {
      return { success: false, message: '检查本地状态失败。' };
    }

    if (!statusResult.output) {
      // 没有更改需要提交
      // 但可能还有未推送的提交
      const aheadResult = this._git(
        `rev-list --count origin/${branch}..HEAD`,
        { cwd: dir }
      );
      const aheadCount = aheadResult.success
        ? parseInt(aheadResult.output) || 0
        : 0;

      if (aheadCount > 0) {
        // 有未推送的提交
        const pushResult = this._git(`push origin ${branch}`, {
          cwd: dir,
          timeout: 60000,
        });
        if (!pushResult.success) {
          this.error(`git push 失败: ${pushResult.output}`);
          return {
            success: false,
            message: '推送失败：' + (pushResult.output || '请检查网络和认证。'),
          };
        }
        return {
          success: true,
          message: `已推送 ${aheadCount} 个提交到 GitHub。`,
          hasChanges: true,
        };
      }

      return {
        success: true,
        message: '没有需要同步的更改。',
        hasChanges: false,
      };
    }

    // 有未提交的更改：暂存 + 提交 + 推送
    const addResult = this._git('add .', { cwd: dir });
    if (!addResult.success) {
      return { success: false, message: '暂存文件失败。' };
    }

    const msg = commitMsg || 'auto: 版本同步 - ' + new Date().toLocaleString('zh-CN');
    const commitResult = this._git(`commit -m "${msg}"`, { cwd: dir });
    if (!commitResult.success) {
      if (commitResult.output.includes('nothing to commit')) {
        return {
          success: true,
          message: '没有需要提交的更改。',
          hasChanges: false,
        };
      }
      return {
        success: false,
        message: '提交失败:\n' + commitResult.output,
      };
    }

    const pushResult = this._git(`push origin ${branch}`, {
      cwd: dir,
      timeout: 60000,
    });
    if (!pushResult.success) {
      this.error(`git push 失败: ${pushResult.output}`);
      return {
        success: false,
        message:
          '推送失败：' + (pushResult.output || '请检查网络和 GitHub 认证。\n提示：首次使用请先在 GitHub Desktop 中点击 Push origin 以缓存凭据。'),
      };
    }

    this.log('代码已同步到 GitHub ✓');
    return {
      success: true,
      message: '代码已推送到 GitHub ✓',
      hasChanges: true,
    };
  }
}

module.exports = UpdateManager;
