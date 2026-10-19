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
      syncIntervalMin: 10,
      autoLaunch: false,
      // 外观：'system' | 'light' | 'dark'
      theme: 'system',
      // 自定义强调色（十六进制），空字符串表示用默认蓝
      accentColor: '',
      // 连接方式：'direct' 直连（默认）| 'system' 跟随系统代理
      proxyMode: 'direct',
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        // 容忍 UTF-8 BOM：用户用记事本编辑过配置文件就会带上它，
        // 而 JSON.parse 遇到 BOM 会直接抛错导致整个配置被重置。
        const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
        Object.assign(this.data, JSON.parse(raw));
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
      autoLaunch: !!this.data.autoLaunch,
      theme: this.data.theme,
      accentColor: this.data.accentColor,
      proxyMode: this.data.proxyMode,
    };
  }
}

module.exports = { Config };
