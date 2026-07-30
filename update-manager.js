const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class UpdateManager {
    constructor() {
        this.cloudSync = null;
        this.logger = null;
    }

    setCloudSync(cloudSync) {
        this.cloudSync = cloudSync;
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

    calculateFileHash(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const fileBuffer = fs.readFileSync(filePath);
            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            return hash;
        } catch (error) {
            this.error(`计算文件哈希失败 ${filePath}: ${error.message}`);
            return null;
        }
    }

    generateFileManifest(baseDir, files) {
        const manifest = [];
        
        for (const fileName of files) {
            const filePath = path.join(baseDir, fileName);
            const hash = this.calculateFileHash(filePath);
            if (hash) {
                const stats = fs.statSync(filePath);
                manifest.push({
                    name: fileName,
                    hash: hash,
                    size: stats.size,
                    lastModified: stats.mtime.getTime()
                });
            }
        }
        
        return manifest;
    }

    scanAppDirectory(sourceDir) {
        const allowedExtensions = ['.js', '.html', '.css', '.json', '.md'];
        const excludedFiles = ['node_modules', '.git', 'package-lock.json', 'yarn.lock', 'dist', 'build', 'manifest-sample.json', 'data.json'];
        const excludedDirs = ['node_modules', '.git', 'dist', 'build', '.electron-builder', 'users'];
        
        const files = [];
        
        const scanDirectory = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (excludedFiles.includes(item)) continue;
                
                const fullPath = path.join(dir, item);
                let relativePath = path.relative(sourceDir, fullPath);
                relativePath = relativePath.replace(/\\/g, '/');
                
                if (fs.statSync(fullPath).isDirectory()) {
                    if (!excludedDirs.includes(item)) {
                        scanDirectory(fullPath);
                    }
                    continue;
                }
                
                const ext = path.extname(item).toLowerCase();
                if (allowedExtensions.includes(ext)) {
                    files.push(relativePath);
                }
            }
        };
        
        scanDirectory(sourceDir);
        return files.sort();
    }

    async getRemoteFileManifest(versionId = null) {
        if (!this.cloudSync) {
            return { success: false, message: '云同步未初始化' };
        }

        try {
            const cloudPath = versionId 
                ? `/apps/Elysia/versions/${versionId}/manifest.json`
                : '/apps/Elysia/app/manifest.json';

            const token = await this.cloudSync.getAccessToken();
            const response = await this.cloudSync.axios.get(`${this.cloudSync.baseUrl}/file`, {
                params: {
                    method: 'download',
                    access_token: token,
                    path: cloudPath
                },
                responseType: 'arraybuffer'
            });

            const jsonString = Buffer.from(response.data).toString('utf8');
            const manifest = JSON.parse(jsonString);
            
            if (manifest.files && Array.isArray(manifest.files)) {
                return { success: true, data: manifest.files, version: manifest.version, createdAt: manifest.createdAt };
            }
            
            return { success: true, data: manifest };
        } catch (error) {
            this.error(`获取远程清单失败: ${error.message}`);
            if (error.response?.status === 404) {
                return { success: false, message: '远程清单不存在', notFound: true };
            }
            return { success: false, message: '获取远程清单失败: ' + (error.response?.data?.error_msg || error.message) };
        }
    }

    compareManifests(localManifest, remoteManifest) {
        const localFiles = new Map();
        const remoteFiles = new Map();

        for (const file of localManifest) {
            localFiles.set(file.name, file);
        }

        for (const file of remoteManifest) {
            remoteFiles.set(file.name, file);
        }

        const filesToDownload = [];
        const filesToRemove = [];

        for (const [name, remoteFile] of remoteFiles) {
            const localFile = localFiles.get(name);
            if (!localFile || localFile.hash !== remoteFile.hash) {
                filesToDownload.push({
                    name: name,
                    hash: remoteFile.hash,
                    size: remoteFile.size,
                    action: localFile ? 'update' : 'add'
                });
            }
        }

        for (const [name, localFile] of localFiles) {
            if (!remoteFiles.has(name)) {
                filesToRemove.push({
                    name: name,
                    action: 'remove'
                });
            }
        }

        return {
            filesToDownload,
            filesToRemove,
            totalDownloadSize: filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0),
            totalFilesToDownload: filesToDownload.length,
            totalFilesToRemove: filesToRemove.length
        };
    }

    async downloadFiles(filesToDownload, targetDir, versionId = null, onProgress = null) {
        if (!this.cloudSync) {
            return { success: false, message: '云同步未初始化' };
        }

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const cloudBasePath = versionId 
            ? `/apps/Elysia/versions/${versionId}`
            : '/apps/Elysia/app';

        let downloadedCount = 0;
        let totalSize = 0;
        let errors = [];

        if (onProgress) {
            onProgress({
                status: 'started',
                current: 0,
                total: filesToDownload.length,
                fileName: '',
                totalBytes: filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0),
                downloadedBytes: 0
            });
        }

        for (let i = 0; i < filesToDownload.length; i++) {
            const fileInfo = filesToDownload[i];
            const fileName = fileInfo.name;

            if (onProgress) {
                onProgress({
                    status: 'downloading',
                    current: i,
                    total: filesToDownload.length,
                    fileName: fileName,
                    totalBytes: filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0),
                    downloadedBytes: totalSize
                });
            }

            try {
                const cloudPath = `${cloudBasePath}/${fileName}`;
                const targetPath = path.join(targetDir, fileName);

                const token = await this.cloudSync.getAccessToken();
                const response = await this.cloudSync.axios.get(`${this.cloudSync.baseUrl}/file`, {
                    params: {
                        method: 'download',
                        access_token: token,
                        path: cloudPath
                    },
                    responseType: 'arraybuffer'
                });

                const targetDirPath = path.dirname(targetPath);
                if (!fs.existsSync(targetDirPath)) {
                    fs.mkdirSync(targetDirPath, { recursive: true });
                }

                fs.writeFileSync(targetPath, response.data);

                const downloadedHash = this.calculateFileHash(targetPath);
                if (downloadedHash !== fileInfo.hash) {
                    errors.push(`${fileName}: 文件校验失败`);
                    this.error(`${fileName} 校验失败: 期望 ${fileInfo.hash}, 实际 ${downloadedHash}`);
                } else {
                    downloadedCount++;
                    totalSize += fileInfo.size || 0;
                    this.log(`已下载: ${fileName}`);
                }

                if (onProgress) {
                    onProgress({
                        status: 'completed',
                        current: downloadedCount,
                        total: filesToDownload.length,
                        fileName: fileName,
                        totalBytes: filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0),
                        downloadedBytes: totalSize
                    });
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error_msg || error.message || '未知错误';
                errors.push(`${fileName}: ${errorMsg}`);
                this.error(`下载 ${fileName} 失败: ${errorMsg}`);
            }
        }

        if (onProgress) {
            onProgress({
                status: 'finished',
                current: downloadedCount,
                total: filesToDownload.length,
                fileName: '',
                totalBytes: filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0),
                downloadedBytes: totalSize
            });
        }

        return {
            success: errors.length === 0,
            downloadedCount,
            totalCount: filesToDownload.length,
            totalSize,
            errors
        };
    }

    removeFiles(filesToRemove, targetDir) {
        let removedCount = 0;
        let errors = [];

        for (const fileInfo of filesToRemove) {
            const filePath = path.join(targetDir, fileInfo.name);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    removedCount++;
                    this.log(`已删除: ${fileInfo.name}`);
                }
            } catch (error) {
                errors.push(`${fileInfo.name}: ${error.message}`);
                this.error(`删除 ${fileInfo.name} 失败: ${error.message}`);
            }
        }

        return {
            success: errors.length === 0,
            removedCount,
            totalCount: filesToRemove.length,
            errors
        };
    }

    async performIncrementalUpdate(targetDir, versionId = null, onProgress = null) {
        try {
            const filesToCheck = this.scanAppDirectory(targetDir);

            const localManifest = this.generateFileManifest(targetDir, filesToCheck);

            const remoteResult = await this.getRemoteFileManifest(versionId);
            if (!remoteResult.success) {
                return remoteResult;
            }

            const remoteManifest = remoteResult.data;

            const comparison = this.compareManifests(localManifest, remoteManifest);

            if (comparison.totalFilesToDownload === 0 && comparison.totalFilesToRemove === 0) {
                return {
                    success: true,
                    message: '当前已是最新版本，无需更新',
                    hasUpdate: false,
                    filesToDownload: [],
                    filesToRemove: []
                };
            }

            if (onProgress) {
                onProgress({
                    status: 'comparing',
                    message: `发现 ${comparison.totalFilesToDownload} 个文件需要更新，${comparison.totalFilesToRemove} 个文件需要删除`,
                    filesToDownload: comparison.filesToDownload,
                    filesToRemove: comparison.filesToRemove
                });
            }

            this.log(`增量更新分析完成: ${comparison.totalFilesToDownload} 个文件需要下载, ${comparison.totalFilesToRemove} 个文件需要删除`);

            let downloadResult;
            if (comparison.totalFilesToDownload > 0) {
                downloadResult = await this.downloadFiles(
                    comparison.filesToDownload,
                    targetDir,
                    versionId,
                    onProgress
                );

                if (!downloadResult.success && downloadResult.errors.length === downloadResult.totalCount) {
                    return {
                        success: false,
                        message: '所有文件下载失败: ' + downloadResult.errors.join('; ')
                    };
                }
            }

            let removeResult;
            if (comparison.totalFilesToRemove > 0) {
                removeResult = this.removeFiles(comparison.filesToRemove, targetDir);
            }

            const downloadedCount = downloadResult?.downloadedCount || 0;
            const removedCount = removeResult?.removedCount || 0;

            let message = `增量更新完成！已更新 ${downloadedCount} 个文件，删除 ${removedCount} 个文件。`;
            
            if (downloadResult?.errors?.length > 0) {
                message += `\n部分文件下载失败: ${downloadResult.errors.join('; ')}`;
            }
            if (removeResult?.errors?.length > 0) {
                message += `\n部分文件删除失败: ${removeResult.errors.join('; ')}`;
            }

            return {
                success: true,
                message,
                hasUpdate: true,
                needRestart: downloadedCount > 0,
                downloadedCount,
                removedCount,
                totalDownloadSize: comparison.totalDownloadSize,
                errors: [
                    ...(downloadResult?.errors || []),
                    ...(removeResult?.errors || [])
                ]
            };

        } catch (error) {
            this.error(`增量更新失败: ${error.message}`);
            return {
                success: false,
                message: '增量更新失败: ' + error.message
            };
        }
    }

    async createAndUploadManifest(sourceDir, versionId = null) {
        if (!this.cloudSync) {
            return { success: false, message: '云同步未初始化' };
        }

        const filesToCheck = this.scanAppDirectory(sourceDir);
        const files = this.generateFileManifest(sourceDir, filesToCheck);
        
        const packageJsonPath = path.join(sourceDir, 'package.json');
        let currentVersion = '1.0.0';
        if (fs.existsSync(packageJsonPath)) {
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                currentVersion = packageJson.version || '1.0.0';
            } catch (e) {
                this.error('读取 package.json 失败:', e.message);
            }
        }

        const manifest = {
            version: currentVersion,
            createdAt: new Date().toISOString(),
            files: files
        };
        
        const manifestJson = JSON.stringify(manifest, null, 2);
        const manifestBuffer = Buffer.from(manifestJson);

        const cloudBasePath = versionId 
            ? `/apps/Elysia/versions/${versionId}`
            : '/apps/Elysia/app';
        const cloudPath = `${cloudBasePath}/manifest.json`;

        try {
            const token = await this.cloudSync.getAccessToken();

            const mkdirResult = await this.cloudSync.createDirectory(token, cloudBasePath);
            if (!mkdirResult.success && mkdirResult.message.indexOf('已存在') === -1) {
                return mkdirResult;
            }

            const crypto = require('crypto');
            const md5 = crypto.createHash('md5').update(manifestBuffer).digest('hex');
            const fileSize = manifestBuffer.length;

            const preuploadResult = await this.cloudSync.preupload(token, cloudPath, fileSize, md5);
            if (!preuploadResult.success) {
                return preuploadResult;
            }

            const uploadid = preuploadResult.data.uploadid;
            const uploadResult = await this.cloudSync.uploadBlock(token, uploadid, 0, md5, manifestBuffer, cloudPath);
            if (!uploadResult.success) {
                return uploadResult;
            }

            const createResult = await this.cloudSync.createFile(token, cloudPath, uploadid, fileSize, md5);
            if (!createResult.success) {
                return createResult;
            }

            this.log(`已创建并上传版本清单，包含 ${files.length} 个文件`);
            return {
                success: true,
                message: `已创建版本清单，包含 ${files.length} 个文件`,
                manifest
            };

        } catch (error) {
            this.error(`创建版本清单失败: ${error.message}`);
            return {
                success: false,
                message: '创建版本清单失败: ' + error.message
            };
        }
    }

    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        const maxLength = Math.max(parts1.length, parts2.length);
        
        for (let i = 0; i < maxLength; i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    async checkForUpdate(currentVersion = null) {
        try {
            const remoteResult = await this.getRemoteFileManifest();
            if (!remoteResult.success) {
                return remoteResult;
            }

            const remoteManifest = remoteResult.data;
            const remoteVersion = remoteResult.version || '0.0.0';
            
            let hasUpdate = false;
            if (currentVersion && remoteVersion) {
                hasUpdate = this.compareVersions(remoteVersion, currentVersion) > 0;
            }
            
            return {
                success: true,
                hasUpdate: hasUpdate,
                manifest: remoteManifest,
                fileCount: remoteManifest.length,
                remoteVersion: remoteVersion,
                currentVersion: currentVersion
            };

        } catch (error) {
            this.error(`检查更新失败: ${error.message}`);
            return {
                success: false,
                message: '检查更新失败: ' + error.message
            };
        }
    }
}

module.exports = UpdateManager;