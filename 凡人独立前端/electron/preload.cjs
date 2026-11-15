/* ============================================================================
 * 热更新预加载脚本
 *
 * 【为什么要单独一个 preload】
 *   electron/main.cjs 里 contextIsolation:true + nodeIntegration:false + sandbox:true，
 *   渲染进程默认拿不到任何 node 能力 —— 这是安全底线，不能为了热更新放开。
 *   preload 是唯一合法的桥：在隔离环境里跑，只把**热更新需要的几个方法**挂到
 *   window.frUpdate 上，其余一律不暴露。
 *
 * 【暴露了什么】
 *   frUpdate.info()      读当前版本 / 是否有新版 / 下载进度
 *   frUpdate.check()     主动检查（manual=true 时失败会弹提示）
 *   frUpdate.apply()     下载并应用，成功后弹「立即重启」
 *   frUpdate.onAvailable 订阅「后台检查到新版」事件
 *
 * 【没暴露什么】
 *   文件读写、命令执行、任意 ipc 通道。渲染进程就算被注入了恶意脚本，
 *   也只能触发「检查更新」这一个白名单动作。
 * ========================================================================== */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frUpdate', {
  /** 当前版本信息与更新状态 */
  info: () => ipcRenderer.invoke('fr-update:info'),

  /** 主动检查更新。manual=true 时失败会弹系统提示 */
  check: (opts) => ipcRenderer.invoke('fr-update:check', { manual: !!(opts && opts.manual) }),

  /** 下载并应用更新（会弹「立即重启 / 稍后」） */
  apply: () => ipcRenderer.invoke('fr-update:apply'),

  /** 回滚到上一版 */
  rollback: () => ipcRenderer.invoke('fr-update:rollback'),

  /** 订阅后台检查到新版本的事件。返回取消订阅函数 */
  onAvailable: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (e, data) => { try { cb(data); } catch (err) {} };
    ipcRenderer.on('fr-update:available', handler);
    return () => ipcRenderer.removeListener('fr-update:available', handler);
  },

  /* 订阅下载进度。2026-11-01 玩家要的：「好看的 ui，让玩家直观看到更新下载进度」。
   *
   * 数据形如 { progress: 0-100, received, total, speed(字节/秒), eta(秒,-1 未知), done? }
   * 主进程节流到约 8 次/秒，前端直接拿去驱动进度条就行。
   */
  onProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (e, data) => { try { cb(data); } catch (err) {} };
    ipcRenderer.on('fr-update:progress', handler);
    return () => ipcRenderer.removeListener('fr-update:progress', handler);
  },
});
