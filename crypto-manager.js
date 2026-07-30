const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CryptoManager {
    constructor() {
        this.masterKey = null;
        this.keySalt = null;
        this.keyIterations = 100000;
        this.keyLength = 32;
        this.ivLength = 12;
        this.authTagLength = 16;
    }

    deriveKey(password, salt) {
        return new Promise((resolve, reject) => {
            crypto.pbkdf2(password, salt, this.keyIterations, this.keyLength, 'sha256', (err, derivedKey) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(derivedKey);
                }
            });
        });
    }

    generateSalt(length = 16) {
        return crypto.randomBytes(length);
    }

    async initMasterKey(masterPassword, existingSalt = null) {
        try {
            if (!masterPassword || masterPassword.trim() === '') {
                throw new Error('主密码不能为空');
            }

            if (!existingSalt) {
                this.keySalt = this.generateSalt();
            } else {
                this.keySalt = Buffer.from(existingSalt, 'base64');
            }

            this.masterKey = await this.deriveKey(masterPassword, this.keySalt);
            return {
                success: true,
                salt: this.keySalt.toString('base64'),
                message: '主密钥初始化成功'
            };
        } catch (error) {
            return {
                success: false,
                message: '初始化主密钥失败: ' + error.message
            };
        }
    }

    isKeyInitialized() {
        return this.masterKey !== null;
    }

    encrypt(data) {
        if (!this.masterKey) {
            throw new Error('主密钥未初始化');
        }

        if (typeof data === 'object') {
            data = JSON.stringify(data);
        } else if (typeof data !== 'string') {
            data = String(data);
        }

        const iv = crypto.randomBytes(this.ivLength);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
        
        let encrypted = cipher.update(data, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        const authTag = cipher.getAuthTag().toString('base64');

        return {
            iv: iv.toString('base64'),
            authTag: authTag,
            encryptedData: encrypted
        };
    }

    decrypt(encryptedData, iv, authTag) {
        if (!this.masterKey) {
            throw new Error('主密钥未初始化');
        }

        try {
            const ivBuffer = Buffer.from(iv, 'base64');
            const authTagBuffer = Buffer.from(authTag, 'base64');
            const encryptedBuffer = Buffer.from(encryptedData, 'base64');

            const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, ivBuffer);
            decipher.setAuthTag(authTagBuffer);

            let decrypted = decipher.update(encryptedBuffer, 'base64', 'utf8');
            decrypted += decipher.final('utf8');

            try {
                return JSON.parse(decrypted);
            } catch {
                return decrypted;
            }
        } catch (error) {
            throw new Error('解密失败: ' + error.message);
        }
    }

    encryptObject(obj) {
        const encrypted = this.encrypt(obj);
        return JSON.stringify(encrypted);
    }

    decryptObject(encryptedString) {
        try {
            const encrypted = JSON.parse(encryptedString);
            return this.decrypt(encrypted.encryptedData, encrypted.iv, encrypted.authTag);
        } catch (error) {
            throw new Error('解密对象失败: ' + error.message);
        }
    }

    generateSecureKey(length = 32) {
        return crypto.randomBytes(length).toString('base64');
    }

    verifyPassword(password, storedSalt) {
        return new Promise(async (resolve) => {
            try {
                const salt = Buffer.from(storedSalt, 'base64');
                const derivedKey = await this.deriveKey(password, salt);
                
                const testData = 'test_verification_data';
                const encrypted = this.encrypt(testData);
                
                const tempManager = new CryptoManager();
                await tempManager.initMasterKey(password, storedSalt);
                
                const decrypted = tempManager.decrypt(encrypted.encryptedData, encrypted.iv, encrypted.authTag);
                resolve(decrypted === testData);
            } catch {
                resolve(false);
            }
        });
    }

    encryptSecret(secretData) {
        if (!this.masterKey) {
            throw new Error('主密钥未初始化');
        }

        const encrypted = this.encrypt(secretData);
        return {
            ...encrypted,
            encrypted: true
        };
    }

    decryptSecret(encryptedSecret) {
        if (!encryptedSecret || !encryptedSecret.encrypted) {
            return encryptedSecret;
        }

        if (!this.masterKey) {
            throw new Error('主密钥未初始化');
        }

        return this.decrypt(encryptedSecret.encryptedData, encryptedSecret.iv, encryptedSecret.authTag);
    }

    async loadKeyFromStorage(storagePath) {
        try {
            if (fs.existsSync(storagePath)) {
                const content = fs.readFileSync(storagePath, 'utf8');
                const keyData = JSON.parse(content);
                return {
                    success: true,
                    salt: keyData.salt,
                    hasMasterPassword: keyData.hasMasterPassword || false
                };
            }
            return {
                success: false,
                message: '密钥存储文件不存在'
            };
        } catch (error) {
            return {
                success: false,
                message: '加载密钥失败: ' + error.message
            };
        }
    }

    async saveKeyToStorage(storagePath, hasMasterPassword = false) {
        try {
            const keyData = {
                salt: this.keySalt ? this.keySalt.toString('base64') : null,
                hasMasterPassword: hasMasterPassword,
                createdAt: new Date().toISOString(),
                version: '1.0'
            };

            const dir = path.dirname(storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(storagePath, JSON.stringify(keyData, null, 2));
            return {
                success: true,
                message: '密钥信息已保存'
            };
        } catch (error) {
            return {
                success: false,
                message: '保存密钥失败: ' + error.message
            };
        }
    }
}

module.exports = CryptoManager;