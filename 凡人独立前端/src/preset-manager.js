/* ============================================================================
 * 凡人卡独立前端 · 通用预设管理器（preset-manager.js）
 *
 * 玩家 2026-10-31：「所有的预设管理器都要对标这个来做」
 *
 * 参照两处权威：
 *   ① 本机酒馆 public/index.html 的 completion_prompt_manager_popup_edit：
 *      列表（Name | Tokens）+ 独立编辑弹窗（Name/Role/Triggers/Position/Depth/Order/Content）
 *      + 页脚（Insert / Delete / Import / Export / Reset / New）
 *   ② 凡人卡 main.js 的 renderWorldBookEntries + openWorldBookEditor：
 *      搜索 / 排序 / 批量全选删除 / 行内开关 / 蓝灯绿灯触发 / 关键词 / 搜索深度
 *
 * 但**不照抄不适合正文的部分**：酒馆 prompt 是逐条按 order 插进 messages，
 * 我们的正文预设是整份拼成一段 system 文本——所以这里只保留
 * 「名称 / 内容 / 启用 / 次序 / 字符数」这套对正文真正有意义的字段。
 * 世界规则额外需要「蓝灯绿灯 + 关键词 + 深度」，由字段开关决定显示与否。
 *
 * 设计：一套渲染逻辑 + 三个 adapter。adapter 只负责读写数据，不管 UI。
 *   PM.register('rules',  {...})  世界规则
 *   PM.register('prompt', {...})  世界观指导提示词
 *   PM.register('prose',  {...})  正文预设
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;

  // 每个管理器各自的视图状态（对齐卡内 worldBookSortBy 那套）
  var views = {};

  function view(key) {
    if (!views[key]) {
      views[key] = { search: '', sortBy: 'order', sortOrder: 'asc', filterMode: 'all' };
    }
    return views[key];
  }

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function human(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + ' 万字符' : n + ' 字符';
  }
  function uid(p) { return (p || 'pm') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function openOv(id) { var o = el(id); if (o) o.classList.add('visible'); }
  function closeOv(id) { var o = el(id); if (o) o.classList.remove('visible'); }

  var adapters = {};

  /* ------------------------------------------------------ 列表渲染 */
  function render(key) {
    var A = adapters[key];
    if (!A) return;
    var box = el(A.listId);
    if (!box) return;

    var v = view(key);
    var items = A.load().slice();

    // 统计头（对齐酒馆 Total Tokens / 卡内启用总量 / 方舟「105/260 条已启用」）
    // 同时写到面板里的 statsId 和弹窗里的 statsIdOv，两个入口都能看到。
    if (A.statsId) {
      var on = items.filter(function (x) { return x.enabled && String(x.content || '').trim(); });
      var total = on.reduce(function (n, x) { return n + String(x.content || '').length; }, 0);
      var extra = '';
      if (A.hasTriggerMode) {
        var blue = on.filter(function (x) { return x.triggerMode !== 'green'; }).length;
        var green = on.length - blue;
        extra = '（蓝灯 <b style="color:#4fc3f7">' + blue + '</b> / 绿灯 <b style="color:#66bb6a">' + green + '</b>）';
      }
      var html = '<b style="color:#ffd700">' + on.length + '/' + items.length + '</b> 个' + A.label + '已启用' +
        extra +
        '<div style="opacity:0.7;font-size:0.92em;margin-top:2px;">启用条目合计 <b>' + human(total) + '</b> 字符；改完即时生效' +
        (A.extraStats ? A.extraStats(items) : '') + '</div>';
      var targets = [A.statsId, A.statsIdOv];
      targets.forEach(function (tid) {
        if (!tid) return;
        var st = el(tid);
        if (st) st.innerHTML = html;
      });
    }

    box.innerHTML = '';

    // 工具条：搜索 / 触发筛选 / 排序 / 全选 / 批量删除（对齐卡内 toolbar）
    var tb = document.createElement('div');
    tb.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;';
    tb.innerHTML =
      '<input data-pm-search type="text" placeholder="搜索名称…" style="flex:1;min-width:150px;" value="' + esc(v.search) + '" />' +
      (A.hasTriggerMode
        ? '<select data-pm-filter style="width:auto;">' +
          '<option value="all">全部触发</option>' +
          '<option value="blue">蓝灯（时刻）</option>' +
          '<option value="green">绿灯（关键词）</option>' +
          '</select>'
        : '') +
      '<button class="major-action-button small-font-btn" data-pm-sort style="width:auto;">' +
        ({ name: '名称', time: '时间', order: '次序' }[v.sortBy] || '次序') +
        (v.sortBy === 'name' ? (v.sortOrder === 'asc' ? ' ↑' : ' ↓') : '') +
      '</button>' +
      '<button class="major-action-button small-font-btn" data-pm-selectall style="width:auto;">全选/反选</button>' +
      '<button class="major-action-button small-font-btn" data-pm-delsel style="width:auto;" disabled>删除选中</button>';
    box.appendChild(tb);

    // 触发筛选下拉选中态
    var fsel = tb.querySelector('[data-pm-filter]');
    if (fsel) fsel.value = v.filterMode;

    // 过滤 + 排序
    var list = items.filter(function (x) {
      var nm = String(x.name || '') + ' ' + ((x.keywords || []).join(' '));
      var okSearch = !v.search || nm.toLowerCase().indexOf(v.search.toLowerCase()) >= 0;
      var mode = x.triggerMode === 'green' ? 'green' : 'blue';
      var okMode = !A.hasTriggerMode || v.filterMode === 'all' || mode === v.filterMode;
      return okSearch && okMode;
    });
    list.sort(function (a, b) {
      if (v.sortBy === 'name') {
        var c = String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        return v.sortOrder === 'asc' ? c : -c;
      }
      if (v.sortBy === 'time') {
        var ia = items.indexOf(a), ib = items.indexOf(b);
        return v.sortOrder === 'desc' ? ib - ia : ia - ib;
      }
      var oa = Number(a.order == null ? 999 : a.order), ob = Number(b.order == null ? 999 : b.order);
      return v.sortOrder === 'asc' ? oa - ob : ob - oa;
    });

    // 空态
    if (!list.length) {
      var p = document.createElement('p');
      p.style.cssText = 'text-align:center;opacity:0.7;margin:18px 0;';
      p.textContent = v.search ? '没有匹配的条目'
        : (A.hasTriggerMode && v.filterMode === 'green' ? '没有绿灯条目（把触发模式改成「绿灯关键词」即可）' : '暂无条目');
      box.appendChild(p);
      updateBatch(0);
      return;
    }

    // 列头去掉（卡片式条目自带结构，不再用表格行）
    // 行渲染：卡片式条目，右侧滑动开关（2026-10-31 按方舟 VariableSettings.vue 的范式重做）
    //   .prompt-entry-item → .entry-header（开关在左，标题居中弹性，控件在右）
    //   这里按玩家要求把开关放**右边**：标题在左，开关+控件在右。
    list.forEach(function (x) {
      var isGreen = x.triggerMode === 'green';
      var isEmpty = !String(x.content || '').trim();
      var len = String(x.content || '').length;

      var card = document.createElement('div');
      card.className = 'fr-pm-card';
      card.style.cssText = 'background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.06);' +
        'border-radius:8px;padding:10px 12px;margin-bottom:8px;transition:all .18s;' +
        (x.enabled ? '' : 'opacity:0.62;');

      // ---- 第一行：标题（左） + 触发灯 + 字符数 + 控件 + 滑动开关（右）
      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;';

      var titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:8px;';
      var title = document.createElement('span');
      title.style.cssText = 'font-size:0.94em;font-weight:500;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;color:' + (x.enabled ? '#eaeaea' : '#9a9a9a') + ';';
      title.textContent = x.name;
      titleWrap.appendChild(title);

      if (isEmpty) {
        var emptyTag = document.createElement('span');
        emptyTag.style.cssText = 'font-size:0.72em;padding:1px 6px;border-radius:4px;' +
          'background:rgba(255,120,120,0.15);color:#ff9c9c;flex-shrink:0;';
        emptyTag.textContent = '空';
        titleWrap.appendChild(emptyTag);
      }
      if (A.hasTriggerMode) {
        var trig = document.createElement('span');
        trig.style.cssText = 'font-size:0.72em;padding:1px 6px;border-radius:4px;flex-shrink:0;' +
          (isGreen
            ? 'background:rgba(102,187,106,0.18);color:#7bd88f;'
            : 'background:rgba(79,195,247,0.18);color:#6cc6f5;');
        trig.textContent = isGreen ? '绿灯' : '蓝灯';
        trig.title = isGreen ? '关键词触发：本轮命中关键词才参与' : '时刻触发：每轮都参与';
        titleWrap.appendChild(trig);
      }
      if (x.builtin) {
        var bi = document.createElement('span');
        bi.style.cssText = 'font-size:0.72em;opacity:0.45;flex-shrink:0;';
        bi.textContent = '内置';
        titleWrap.appendChild(bi);
      }
      head.appendChild(titleWrap);

      // 字符数
      var chars = document.createElement('span');
      chars.style.cssText = 'font-size:0.78em;opacity:0.5;white-space:nowrap;flex-shrink:0;';
      chars.textContent = human(len);
      head.appendChild(chars);

      // 控件组：上移 / 下移 / 编辑 / 删除
      var ctrls = document.createElement('div');
      ctrls.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
      [['up', '上移', '↑'], ['down', '下移', '↓'], ['edit', '编辑', '✎'], ['del', '删除', '✕']].forEach(function (c) {
        var b = document.createElement('button');
        b.setAttribute('data-pm-' + c[0], '');
        b.setAttribute('data-id', x.id);
        b.title = c[1];
        b.textContent = c[2];
        b.style.cssText = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:5px;' +
          'color:#b8b8b8;cursor:pointer;font-size:0.8em;line-height:1;padding:0;transition:all .15s;';
        b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,0.13)'; b.style.color = '#fff'; };
        b.onmouseleave = function () { b.style.background = 'rgba(255,255,255,0.05)'; b.style.color = '#b8b8b8'; };
        ctrls.appendChild(b);
      });
      head.appendChild(ctrls);

      // ★ 滑动开关（放最右，对齐方舟 VariableSettings.vue 的 .switch/.slider）
      var sw = document.createElement('label');
      sw.className = 'fr-switch';
      sw.style.cssText = 'position:relative;display:inline-block;width:38px;height:21px;flex-shrink:0;margin-left:2px;';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.setAttribute('data-pm-check', '');
      inp.setAttribute('data-id', x.id);
      inp.checked = !!x.enabled;
      inp.style.cssText = 'opacity:0;width:0;height:0;position:absolute;';
      var slider = document.createElement('span');
      slider.className = 'fr-slider';
      slider.style.cssText = 'position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;' +
        'border-radius:21px;transition:.25s;' +
        'background:' + (x.enabled ? '#22c55e' : 'rgba(255,255,255,0.12)') + ';' +
        'box-shadow:inset 0 1px 2px rgba(0,0,0,0.25);';
      var knob = document.createElement('span');
      knob.style.cssText = 'position:absolute;content:"";height:17px;width:17px;left:2px;bottom:2px;' +
        'background:#fff;border-radius:50%;transition:.25s;box-shadow:0 1px 3px rgba(0,0,0,0.35);' +
        'transform:' + (x.enabled ? 'translateX(17px)' : 'translateX(0)') + ';';
      slider.appendChild(knob);
      sw.appendChild(inp);
      sw.appendChild(slider);
      head.appendChild(sw);

      card.appendChild(head);

      // ---- 第二行：内容预览（灰字单行，一眼看出写了什么）
      var pvText = isEmpty ? (x.reason || '空内容') : String(x.content).replace(/\s+/g, ' ').trim();
      var pv = document.createElement('div');
      pv.style.cssText = 'margin-top:7px;font-size:0.78em;line-height:1.5;opacity:0.45;' +
        'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;' +
        'word-break:break-all;';
      pv.textContent = pvText.slice(0, 160);
      card.appendChild(pv);

      box.appendChild(card);
    });

    updateBatch(0);
    wireList(key);
  }

  function updateBatch(n) {
    var A = adapters[Object.keys(adapters).find(function (k) {
      return adapters[k].listId && el(adapters[k].listId);
    })] || {};
    // 按每个已知管理器分别更新
    Object.keys(adapters).forEach(function (key) {
      var box = el(adapters[key].listId);
      if (!box) return;
      var btn = box.querySelector('[data-pm-delsel]');
      var cnt = box.querySelectorAll('[data-pm-check]:checked').length;
      if (btn) { btn.disabled = cnt === 0; btn.style.opacity = cnt === 0 ? '0.45' : ''; }
    });
  }

  /* 列表事件（委托，对齐卡内 #world-book-entries-list 的做法） */
  function wireList(key) {
    var A = adapters[key];
    var box = el(A.listId);
    if (!box) return;
    if (box.__pmWired) { box.__pmKey = key; return; }
    box.__pmWired = true;
    box.__pmKey = key;

    box.addEventListener('click', function (e) {
      var t = e.target;
      var cur = adapters[box.__pmKey];
      if (!cur) return;

      var editBtn = t.closest('[data-pm-edit]');
      if (editBtn) { openEditor(box.__pmKey, editBtn.dataset.id); return; }
      var delBtn = t.closest('[data-pm-del]');
      if (delBtn) { confirmDelete(box.__pmKey, [delBtn.dataset.id]); return; }

      // 上下移动（对齐方舟每条右侧的 ↑↓）：调换 order，立刻影响拼接顺序
      var upBtn = t.closest('[data-pm-up]');
      if (upBtn) { moveItem(box.__pmKey, upBtn.dataset.id, -1); return; }
      var downBtn = t.closest('[data-pm-down]');
      if (downBtn) { moveItem(box.__pmKey, downBtn.dataset.id, +1); return; }

      if (t.closest('[data-pm-sort]')) {
        var v = view(box.__pmKey);
        if (v.sortBy === 'order') v.sortBy = 'name';
        else if (v.sortBy === 'name') v.sortBy = 'time';
        else v.sortBy = 'order';
        v.sortOrder = v.sortBy === 'time' ? 'desc' : 'asc';
        render(box.__pmKey);
        return;
      }
      if (t.closest('[data-pm-selectall]')) {
        var chs = box.querySelectorAll('[data-pm-check]');
        var all = Array.prototype.every.call(chs, function (c) { return c.checked; });
        Array.prototype.forEach.call(chs, function (c) { c.checked = !all; });
        updateBatch();
        return;
      }
      if (t.closest('[data-pm-delsel]')) {
        var ids = Array.prototype.map.call(box.querySelectorAll('[data-pm-check]:checked'), function (c) { return c.dataset.id; });
        if (ids.length) confirmDelete(box.__pmKey, ids);
        return;
      }
    });

    box.addEventListener('input', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-pm-search')) {
        view(box.__pmKey).search = e.target.value;
        render(box.__pmKey);
        var s = box.querySelector('[data-pm-search]');
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
      }
    });

    box.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-pm-filter')) {
        view(box.__pmKey).filterMode = t.value;
        render(box.__pmKey);
        return;
      }
      // 行内启用开关（卡片右侧滑动开关）
      // 注意：这里必须真的落库，之前和上面的批量选择分支条件重复，
      // 被提前 return 截断，导致勾选状态存不下来。
      if (t.hasAttribute && t.hasAttribute('data-pm-check')) {
        var cur = adapters[box.__pmKey];
        var d = cur.load();
        var it = d.find(function (y) { return y.id === t.dataset.id; });
        if (it) {
          it.enabled = t.checked;
          // 先就地更新视觉，避免整表重绘导致滚动位置跳动
          paintSwitch(t);
          cur.save(d);
          refreshStats(box.__pmKey);
        }
        return;
      }
    });
  }

  /** 按勾选状态给滑动开关上色/移动滑块 */
  function paintSwitch(input) {
    var wrap = input.parentNode;
    if (!wrap) return;
    var slider = wrap.querySelector('.fr-slider');
    var knob = slider ? slider.firstChild : null;
    if (slider) slider.style.background = input.checked ? '#22c55e' : 'rgba(255,255,255,0.12)';
    if (knob) knob.style.transform = input.checked ? 'translateX(17px)' : 'translateX(0)';
    var card = wrap.closest ? wrap.closest('.fr-pm-card') : null;
    if (card) card.style.opacity = input.checked ? '' : '0.62';
    var titleSpan = card ? card.querySelector('span') : null;
    if (titleSpan) titleSpan.style.color = input.checked ? '#eaeaea' : '#9a9a9a';
  }

  /** 只刷新统计条，不重绘列表（开关即时生效但不跳动） */
  function refreshStats(key) {
    var A = adapters[key];
    if (!A || !A.statsId) return;
    var items = A.load();
    var on = items.filter(function (x) { return x.enabled && String(x.content || '').trim(); });
    var total = on.reduce(function (n, x) { return n + String(x.content || '').length; }, 0);
    var extra = '';
    if (A.hasTriggerMode) {
      var blue = on.filter(function (x) { return x.triggerMode !== 'green'; }).length;
      var green = on.length - blue;
      extra = '（蓝灯 <b style="color:#6cc6f5">' + blue + '</b> / 绿灯 <b style="color:#7bd88f">' + green + '</b>）';
    }
    var html = '<b style="color:#ffd700">' + on.length + '/' + items.length + '</b> 个' + A.label + '已启用' +
      extra +
      '<div style="opacity:0.7;font-size:0.92em;margin-top:2px;">启用条目合计 <b>' + human(total) + '</b> 字符；改完即时生效' +
      (A.extraStats ? A.extraStats(items) : '') + '</div>';
    [A.statsId, A.statsIdOv].forEach(function (tid) {
      if (!tid) return;
      var st = el(tid);
      if (st) st.innerHTML = html;
    });
  }

  /** 上/下移一条：按当前显示顺序调换 order，并立刻重排落库 */
  function moveItem(key, id, delta) {
    var A = adapters[key];
    if (!A) return;
    var d = A.load();
    var idx = d.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return;
    var to = idx + delta;
    if (to < 0 || to >= d.length) return;
    // 交换 order 值（order 可能重复或不连续，先归一化再交换更稳）
    d.forEach(function (x, i) { x.order = i; });
    var tmp = d[idx].order;
    d[idx].order = d[to].order;
    d[to].order = tmp;
    d.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    d.forEach(function (x, i) { x.order = i; });
    A.save(d);
    render(key);
  }

  function confirmDelete(key, ids) {    var A = adapters[key];
    var d = A.load();
    var names = ids.map(function (id) {
      var x = d.find(function (y) { return y.id === id; });
      return x ? x.name : id;
    });
    var msg = ids.length === 1 ? ('确定删除「' + names[0] + '」？') : ('确定删除选中的 ' + ids.length + ' 项？');
    var doIt = function () {
      var dd = A.load();
      var deleted = dd.filter(function (y) { return ids.indexOf(y.id) < 0; });
      A.save(deleted, ids);
      render(key);
      status(A.statusId, '已删除 ' + ids.length + ' 项');
    };
    if (window.showCustomConfirm) window.showCustomConfirm(msg).then(function (ok) { if (ok) doIt(); });
    else doIt();
  }

  /* -------------------------------------------------- 条目编辑弹窗 */
  function openEditor(key, id) {
    var A = adapters[key];
    var d = A.load();
    var x = id ? d.find(function (y) { return y.id === id; }) : null;
    A.editingId = id || null;

    var t = el(A.editorTitleId);
    if (t) t.textContent = x ? ('编辑：' + x.name) : ('创建新' + A.itemLabel);

    setV(A.fNameId, x ? x.name : '');
    setV(A.fContentId, x ? (x.content || '') : '');
    if (A.fModeId) {
      var mode = (x && x.triggerMode === 'green') ? 'green' : 'blue';
      Array.prototype.forEach.call(document.querySelectorAll('input[name="' + A.fModeName + '"]'), function (r) {
        r.checked = (r.value === mode);
      });
      toggleKw(key);
    }
    if (A.fKwId) setV(A.fKwId, x ? (x.keywords || []).join(',') : '');
    if (A.fDepthId) setV(A.fDepthId, x && x.depth != null ? x.depth : 0);

    openOv(A.editorOverlayId);
    updateContentCount(key);
  }

  function toggleKw(key) {
    var A = adapters[key];
    if (!A.hasTriggerMode || !A.fKwWrapId) return;
    var sel = document.querySelector('input[name="' + A.fModeName + '"]:checked');
    var mode = sel ? sel.value : 'blue';
    var w = el(A.fKwWrapId);
    if (w) w.style.display = (mode === 'green') ? 'block' : 'none';
  }

  function updateContentCount(key) {
    var A = adapters[key];
    if (!A.fCountId) return;
    var c = el(A.fContentId);
    var box = el(A.fCountId);
    if (box && c) box.textContent = human(String(c.value || '').length) + '（约 ' + Math.round(String(c.value || '').length / 3) + ' tokens 估算）';
  }

  function saveEditor(key) {
    var A = adapters[key];
    var name = String((el(A.fNameId) || {}).value || '').trim();
    var content = String((el(A.fContentId) || {}).value || '');
    if (!name) { alert('名称不能为空'); return; }

    var item = {
      name: name,
      content: content,
      enabled: true,
      order: 999
    };
    if (A.hasTriggerMode) {
      var sel = document.querySelector('input[name="' + A.fModeName + '"]:checked');
      item.triggerMode = sel ? sel.value : 'blue';
      var kwRaw = String((el(A.fKwId) || {}).value || '').trim();
      item.keywords = item.triggerMode === 'green' ? kwRaw.split(/[,，\s]+/).filter(Boolean) : [];
      if (item.triggerMode === 'green' && !item.keywords.length) {
        alert('绿灯模式下至少需要一个触发关键词！'); return;
      }
      if (A.fDepthId) item.depth = parseInt((el(A.fDepthId) || {}).value, 10) || 0;
    }

    var d = A.load();
    if (A.editingId) {
      var x = d.find(function (y) { return y.id === A.editingId; });
      if (x) {
        item.id = x.id; item.builtin = !!x.builtin;
        item.order = x.order; item.enabled = x.enabled;
        Object.assign(x, item);
      }
    } else {
      item.id = uid(key);
      item.builtin = false;
      d.push(item);
    }
    A.save(d);
    closeOv(A.editorOverlayId);
    render(key);
    status(A.statusId, '已保存「' + name + '」');
  }

  function setV(id, v) { var e = el(id); if (e) e.value = v == null ? '' : String(v); }
  function status(id, msg) {
    var s = id ? el(id) : null;
    if (!s) return;
    s.textContent = msg || '';
    s.style.color = '#9fd08a';
  }

  /* ------------------------------------------------------- 导入导出 */
  var fileEl = null;
  function pickFile(accept, onText) {
    if (!fileEl) {
      fileEl = document.createElement('input');
      fileEl.type = 'file';
      fileEl.style.display = 'none';
      document.body.appendChild(fileEl);
    }
    fileEl.value = '';
    fileEl.accept = accept || '.json,.txt,.md';
    fileEl.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function (ev) {
        try { onText(String(ev.target.result || ''), f.name); }
        catch (err) { alert('导入失败：' + (err && err.message ? err.message : err)); }
      };
      rd.readAsText(f);
    };
    fileEl.click();
  }

  function exportJson(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 通用导入识别（三套管理器共用）：
   *   ① 本工程格式 { rules|presets|prompts: [...] }
   *   ② 酒馆世界书 { entries: {uid: {key, content, constant, ...}} }
   *   ③ 数组
   *   ④ 单条对象 {name, content|text|promptTemplate}
   *   ⑤ 纯文本
   */
  function importAny(text, filename) {
    var out = [];
    var obj = null;
    try { obj = JSON.parse(text); } catch (e) { obj = null; }

    function push(name, content, extra) {
      var nm = String(name || '').trim();
      if (!nm || !String(content == null ? '' : content).trim()) return;
      out.push(Object.assign({ name: nm, content: String(content) }, extra || {}));
    }

    // 酒馆世界书
    if (obj && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
      Object.keys(obj.entries).forEach(function (k) {
        var e = obj.entries[k];
        if (!e) return;
        var keys = Array.isArray(e.key) ? e.key : (e.key ? String(e.key).split(',') : []);
        push(e.comment || e.name || ('条目 ' + k), e.content, {
          triggerMode: e.constant === true ? 'blue' : (keys.length ? 'green' : 'blue'),
          keywords: keys.map(function (v) { return String(v).trim(); }).filter(Boolean),
          depth: Number(e.depth == null ? 0 : e.depth),
          enabled: e.disable !== true,
          order: Number(e.order == null ? 999 : e.order)
        });
      });
    }
    // 本工程规则包 / 预设包
    else if (obj && (Array.isArray(obj.rules) || Array.isArray(obj.presets) || Array.isArray(obj.prompts))) {
      var arr0 = obj.rules || obj.presets || obj.prompts;
      arr0.forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        push(r.name || r.id, r.content != null ? r.content : (r.text != null ? r.text : r.promptTemplate), {
          triggerMode: r.triggerMode, keywords: r.keywords, depth: r.depth,
          enabled: r.enabled !== false, order: r.order
        });
      });
    }
    // 数组
    else if (Array.isArray(obj)) {
      obj.forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        push(r.name, r.content != null ? r.content : (r.text != null ? r.text : r.promptTemplate), {
          triggerMode: r.triggerMode, keywords: r.keywords, depth: r.depth, enabled: r.enabled !== false
        });
      });
    }
    // 单条对象
    else if (obj && typeof obj === 'object' && (obj.content != null || obj.text != null || obj.promptTemplate != null)) {
      push(obj.name || String(filename || '').replace(/\.(json|txt|md)$/i, ''),
        obj.content != null ? obj.content : (obj.text != null ? obj.text : obj.promptTemplate));
    }
    // 纯文本
    else {
      push(String(filename || '导入条目').replace(/\.(json|txt|md)$/i, ''), text);
    }
    return out;
  }

  /* ------------------------------------------------------ 注册与绑定 */
  /**
   * @param {string} key 管理器标识
   * @param {object} A adapter
   *   listId/statsId/statusId       列表容器、统计条、状态文字
   *   label/itemLabel               统计里的名词、编辑窗标题里的名词
   *   hasTriggerMode                是否启用「蓝灯/绿灯 + 关键词 + 深度」
   *   overlayId/openBtnId/closeBtnId 管理弹窗 id 与开关按钮
   *   editorOverlayId/editorTitleId  条目编辑弹窗
   *   fNameId/fContentId/fCountId/fKwId/fKwWrapId/fDepthId/fModeName
   *   newBtnId/importBtnId/exportBtnId/resetBtnId/saveBtnId/cancelBtnId/editorCloseId
   *   load() save(items, deletedIds) reset() exports() import?
   */
  function register(key, A) {
    adapters[key] = A;

    var bind = function () {
      if (!el(A.listId)) return false;

      // 管理弹窗开关
      if (A.openBtnId && el(A.openBtnId)) {
        el(A.openBtnId).addEventListener('click', function () {
          render(key);
          if (A.overlayId) openOv(A.overlayId);
        });
      }
      if (A.closeBtnId && el(A.closeBtnId)) {
        el(A.closeBtnId).addEventListener('click', function () { closeOv(A.overlayId); });
      }

      // 新建 / 导入 / 导出 / 恢复
      if (A.newBtnId && el(A.newBtnId)) el(A.newBtnId).addEventListener('click', function () { openEditor(key, null); });
      if (A.importBtnId && el(A.importBtnId)) el(A.importBtnId).addEventListener('click', function () {
        pickFile('.json,.txt,.md', function (text, filename) {
          // adapter 可提供专用导入器（正文预设要用酒馆预设装配器，而不是逐条拆开）
          var incoming = null;
          var extraNote = '';
          if (typeof A.importer === 'function') {
            var res = A.importer(text, filename);
            if (res && res.items) { incoming = res.items; extraNote = res.note || ''; }
            else if (res && res.ok === false) { status(A.statusId, res.reason || '导入失败'); return; }
          }
          if (!incoming || !incoming.length) incoming = importAny(text, filename);
          if (!incoming.length) { status(A.statusId, '没有解析出可导入的条目'); return; }
          var d = A.load();
          var added = 0, updated = 0;
          incoming.forEach(function (it) {
            var exist = d.find(function (y) { return y.name === it.name; });
            if (exist) {
              exist.content = it.content;
              if (A.hasTriggerMode) {
                if (it.triggerMode) exist.triggerMode = it.triggerMode === 'green' ? 'green' : 'blue';
                if (Array.isArray(it.keywords)) exist.keywords = it.keywords;
                if (it.depth != null) exist.depth = it.depth;
              }
              if (it.enabled != null) exist.enabled = it.enabled;
              updated++;
            } else {
              d.push({
                id: uid(key), name: it.name, content: it.content,
                enabled: it.enabled !== false, order: it.order == null ? 999 : it.order,
                builtin: false,
                triggerMode: it.triggerMode === 'green' ? 'green' : 'blue',
                keywords: Array.isArray(it.keywords) ? it.keywords : [],
                depth: Number(it.depth || 0)
              });
              added++;
            }
          });
          A.save(d);
          render(key);
          if (A.overlayId) openOv(A.overlayId);
          status(A.statusId, (extraNote ? (extraNote + '；') : '') + '导入完成：新增 ' + added + '，覆盖 ' + updated);
        });
      });
      if (A.exportBtnId && el(A.exportBtnId)) el(A.exportBtnId).addEventListener('click', function () {
        var d = A.load();
        exportJson(A.exportPayload(d), (A.exportName || key) + '.json');
        status(A.statusId, '已导出 ' + d.length + ' 条');
      });
      if (A.resetBtnId && el(A.resetBtnId)) el(A.resetBtnId).addEventListener('click', function () {
        var doIt = function () { A.reset(); render(key); status(A.statusId, '已恢复内置'); };
        if (window.showCustomConfirm) window.showCustomConfirm('确定恢复内置？你的编辑和新增会全部丢失。').then(function (ok) { if (ok) doIt(); });
        else doIt();
      });

      // 编辑弹窗
      if (A.saveBtnId && el(A.saveBtnId)) el(A.saveBtnId).addEventListener('click', function () { saveEditor(key); });
      if (A.cancelBtnId && el(A.cancelBtnId)) el(A.cancelBtnId).addEventListener('click', function () { closeOv(A.editorOverlayId); });
      if (A.editorCloseId && el(A.editorCloseId)) el(A.editorCloseId).addEventListener('click', function () { closeOv(A.editorOverlayId); });
      if (A.hasTriggerMode && A.fModeName) {
        Array.prototype.forEach.call(document.querySelectorAll('input[name="' + A.fModeName + '"]'), function (r) {
          r.addEventListener('change', function () { toggleKw(key); });
        });
      }
      if (A.fContentId && el(A.fContentId)) el(A.fContentId).addEventListener('input', function () { updateContentCount(key); });

      render(key);
      return true;
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(bind, 0); });
    else setTimeout(bind, 0);

    return { bind: bind, render: function () { render(key); }, importAny: importAny };
  }

  window.FRPresetManager = {
    register: register,
    render: render,
    importAny: importAny,
    adapters: adapters
  };
})();
