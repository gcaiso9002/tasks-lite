'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

/**
 * 服务器配置。密码不落明文：Windows 上走 safeStorage（DPAPI）加密后再存，
 * 只有当前 Windows 用户能解开。
 */
class Config {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    // 首次启动的占位默认值，用户在设置面板里改成自己的服务器
    this.data = {
      server: '',
      username: '',
      password: '',
      syncIntervalMin: 5,
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        Object.assign(this.data, raw);
      }
    } catch (e) {
      console.error('[config] 读取失败：', e.message);
    }
    this._decryptPassword();
  }

  _decryptPassword() {
    const enc = this.data.password;
    if (!enc) {
      this.data.password = '';
      return;
    }
    if (!enc.startsWith('enc:')) {
      // 早期版本明文存的，升级时就地加密
      this.data.password = enc;
      this.save();
      return;
    }
    try {
      this.data.password = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(enc.slice(4), 'base64'))
        : '';
    } catch (e) {
      console.error('[config] 密码解密失败（可能换了 Windows 账号）：', e.message);
      this.data.password = '';
    }
  }

  save() {
    const out = Object.assign({}, this.data);
    if (out.password) {
      out.password = safeStorage.isEncryptionAvailable()
        ? 'enc:' + safeStorage.encryptString(out.password).toString('base64')
        : out.password;
    } else {
      out.password = '';
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
      console.error('[config] 写入失败：', e.message);
    }
  }

  update(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  /** 给渲染进程用的安全副本：不含密码 */
  publicView() {
    return {
      server: this.data.server,
      username: this.data.username,
      hasPassword: !!this.data.password,
      syncIntervalMin: this.data.syncIntervalMin,
    };
  }
}

module.exports = { Config };
