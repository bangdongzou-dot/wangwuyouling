// 本卡内置资料：仅在首次需要时解压，不访问网络，不覆盖用户保存的数据。
var frDefaultAssetsPromise = null;
async function frLoadDefaultAssets() {
  if (!frDefaultAssetsPromise) {
    frDefaultAssetsPromise = (async function() {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('当前浏览器不支持内置资料解压，请升级火狐浏览器后重试。');
      }
      var binary = atob(FR_PACKED_DEFAULTS);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      var assets = JSON.parse(await new Response(stream).text());
      /* ★★ 2026-11-06 玩家：「之前那一份预设就不要内置了，避免误导。之前那份可以说是废弃了。」
       *
       * 原来这里要求 assets.preset 必须存在 —— 那是旧的重点演化预设
       * （万物有灵世界观适配·原著演化版），却被和「内置年表」绑成一个原子校验：
       * 缺任一项，整个内置资料都加载失败，连年表都读不出来。
       *
       * 旧预设已移除（重点演化预设的唯一来源改为 evolution-presets.json 的四套），
       * 所以这里只校验年表，不再把两个领域绑在一起。
       */
      if (!Array.isArray(assets.timeline)) {
        throw new Error('角色卡内置资料校验失败，请重新导入完整测试卡。');
      }
      return assets;
    })().catch(function(error) {
      frDefaultAssetsPromise = null;
      throw error;
    });
  }
  return frDefaultAssetsPromise;
}
