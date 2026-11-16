/* ============================================================================
 * 凡人卡独立前端 · 世界观指导观测面板（worldview-panel-trace.js）
 *
 * 玩家口径（2026-10-31）：
 *   「世界观指导的思维链采集和结果展示也做一下，放在原著补演左边，变量思维右边。
 *     ui做好一些，有质感和美观。信息要归纳整理排版好。」
 *
 * 位置：思维链弹窗的标签页，顺序 变量思维 → 世界观指导 → 原著补演。
 *
 * 展示两类信息：
 *   ① 采集过程（这条指导是怎么算出来的）
 *      输入资料构成 → 规则命中 → 提示词拼装 → 模型请求 → 裁定生成
 *   ② 结果（裁定成什么）
 *      思维链原文（<thinking> 段） + 裁定正文（注入正文提示词的那部分）
 *
 * 设计取向：
 *   · 沿用原著补演面板的暗金色调，保持两个面板观感一致；
 *   · 每个阶段一张卡片，左边一条竖线把阶段串起来，形成「流程」的直觉；
 *   · 数字用等宽字体单独列，避免「一坨文字」；
 *   · 大段文本默认折叠，点开才展开，避免面板被撑爆；
 *   · 空状态说清楚「为什么没有」，不是干巴巴一句「暂无数据」。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;
  if (window.FRWorldviewTrace) return;   // 幂等

  var MOUNT_ID = 'wv-trace-content';
  var foldMemory = new Map();            // 折叠状态记忆，重渲染后恢复

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function secs(ms) { return ms == null ? '—' : (Math.round(Number(ms) / 100) / 10) + ' 秒'; }
  function hhmmss(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    function p(x) { return String(x).padStart(2, '0'); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ------------------------------------------------------------ 样式 */
  // 直接注入一段样式，不依赖构建顺序，也不污染 style-1.css 的既有规则。
  function injectStyle() {
    if (document.getElementById('fr-wv-trace-style')) return;
    var css = [
      '.fr-wv-trace{--wv-gold:#d9b45a;--wv-gold-dim:#8d7333;--wv-ink:#e9e2d2;--wv-ink-dim:#9a917d;',
      '  --wv-bg:rgba(26,23,18,.72);--wv-bg2:rgba(38,33,25,.72);--wv-line:rgba(217,180,90,.22);',
      '  font-size:13px;color:var(--wv-ink);line-height:1.62;padding:4px 2px 18px;}',
      '.fr-wv-trace *{box-sizing:border-box;}',

      /* 顶部总览 */
      '.fr-wv-head{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin:2px 0 14px;}',
      '.fr-wv-stat{flex:1 1 132px;min-width:120px;background:linear-gradient(160deg,var(--wv-bg2),var(--wv-bg));',
      '  border:1px solid var(--wv-line);border-radius:10px;padding:9px 12px;position:relative;overflow:hidden;}',
      '.fr-wv-stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;',
      '  background:linear-gradient(180deg,var(--wv-gold),transparent);opacity:.85;}',
      '.fr-wv-stat .k{font-size:11px;letter-spacing:.4px;color:#a99a78;margin-bottom:2px;}',
      '.fr-wv-stat .v{font-size:17px;font-weight:600;color:var(--wv-gold);',
      '  font-variant-numeric:tabular-nums;font-feature-settings:"tnum";}',
      '.fr-wv-stat .v small{font-size:11px;font-weight:400;color:#a99a78;margin-left:3px;}',

      /* 流程时间线 */
      '.fr-wv-flow{position:relative;padding-left:22px;margin:0 0 16px;}',
      '.fr-wv-flow::before{content:"";position:absolute;left:6px;top:8px;bottom:8px;width:1px;',
      '  background:linear-gradient(180deg,var(--wv-line),rgba(217,180,90,.05));}',
      '.fr-wv-step{position:relative;margin:0 0 10px;background:var(--wv-bg);',
      '  border:1px solid rgba(255,255,255,.055);border-radius:9px;padding:9px 12px;}',
      '.fr-wv-step::before{content:"";position:absolute;left:-19px;top:14px;width:7px;height:7px;',
      '  border-radius:50%;background:#2a2419;border:1.5px solid var(--wv-gold-dim);}',
      '.fr-wv-step.ok::before{background:var(--wv-gold);border-color:var(--wv-gold);',
      '  box-shadow:0 0 7px rgba(217,180,90,.55);}',
      '.fr-wv-step.bad::before{background:#b5563f;border-color:#b5563f;box-shadow:0 0 7px rgba(181,86,63,.5);}',
      '.fr-wv-step .t{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.fr-wv-step .t .name{font-weight:600;color:#efe7d5;font-size:12.5px;}',
      '.fr-wv-step .t .meta{font-size:11px;color:#8e836c;font-variant-numeric:tabular-nums;}',
      '.fr-wv-step .d{font-size:11.5px;color:#b8ad96;margin-top:3px;overflow-wrap:anywhere;}',

      /* 资料构成条形 */
      '.fr-wv-bars{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;}',
      '.fr-wv-bar{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:999px;',
      '  border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#b6ab94;}',
      '.fr-wv-bar.hit{border-color:rgba(217,180,90,.42);background:rgba(217,180,90,.1);color:#e4cd8f;}',
      '.fr-wv-bar.miss{opacity:.45;}',
      '.fr-wv-bar b{font-weight:600;font-variant-numeric:tabular-nums;}',

      /* 规则命中列表 */
      '.fr-wv-rules{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px;}',
      '.fr-wv-rule{font-size:11px;padding:2px 7px;border-radius:5px;background:rgba(217,180,90,.08);',
      '  border:1px solid rgba(217,180,90,.2);color:#cdbb8c;}',

      /* 结果区 */
      '.fr-wv-sec{margin:16px 0 0;}',
      '.fr-wv-sec>.h{display:flex;align-items:center;gap:8px;margin:0 0 8px;',
      '  font-size:12px;letter-spacing:.5px;color:#a99a78;text-transform:none;}',
      '.fr-wv-sec>.h::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--wv-line),transparent);}',
      '.fr-wv-box{background:var(--wv-bg2);border:1px solid var(--wv-line);border-radius:10px;padding:11px 13px;}',
      '.fr-wv-box.think{border-color:rgba(120,140,190,.28);background:rgba(28,32,44,.6);}',
      '.fr-wv-box.think .label{color:#93a3c9;}',
      '.fr-wv-pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.72;',
      '  color:#dcd3c0;max-height:340px;overflow:auto;margin:0;}',
      '.fr-wv-pre.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;}',

      /* 折叠 */
      '.fr-wv-fold{border:1px solid rgba(255,255,255,.06);border-radius:9px;overflow:hidden;margin-top:8px;}',
      '.fr-wv-fold>summary{cursor:pointer;list-style:none;padding:8px 12px;font-size:12px;',
      '  background:rgba(255,255,255,.028);color:#c3b795;display:flex;align-items:center;gap:7px;}',
      '.fr-wv-fold>summary::-webkit-details-marker{display:none;}',
      '.fr-wv-fold>summary::before{content:"▸";font-size:10px;color:var(--wv-gold-dim);transition:transform .15s;}',
      '.fr-wv-fold[open]>summary::before{transform:rotate(90deg);}',
      '.fr-wv-fold>summary:hover{background:rgba(217,180,90,.07);}',
      '.fr-wv-fold .body{padding:10px 12px;border-top:1px solid rgba(255,255,255,.05);}',

      /* 空状态 */
      '.fr-wv-empty{text-align:center;padding:34px 18px;color:#8e836c;}',
      '.fr-wv-empty .big{font-size:15px;color:#b6a67e;margin-bottom:6px;}',
      '.fr-wv-empty .sub{font-size:12px;line-height:1.7;}',

      '.fr-wv-rulings{display:grid;gap:12px;}',
      '.fr-wv-ruling{min-width:0;padding:12px 14px;border:1px solid var(--wv-line);',
      '  border-radius:10px;background:var(--wv-bg2);overflow-wrap:anywhere;}',
      '.fr-wv-ruling h3{margin:0 0 9px;color:#ead3a0;font:inherit;font-size:15px;font-weight:650;}',
      '.fr-wv-ruling p{margin:0;color:#dcd3c0;line-height:1.7;white-space:pre-wrap;}',
      '.fr-wv-ruling-items{display:grid;gap:6px;margin:0;padding:0;list-style:none;}',
      '.fr-wv-ruling-items li{display:flex;gap:8px;align-items:baseline;padding:5px 0;}',
      '.fr-wv-ruling-items li+li{border-top:1px solid rgba(255,255,255,.06);}',
      '.fr-wv-ruling-label{flex:0 0 auto;max-width:42%;padding:1px 7px;border-radius:5px;',
      '  font-size:11px;font-weight:650;color:#e7c980;background:rgba(217,180,90,.12);}',
      '.fr-wv-ruling-label.basis{color:#c2d8ae;background:rgba(130,159,105,.15);}',
      '.fr-wv-ruling-label.caution{color:#efb39e;background:rgba(181,86,63,.18);}',
      '.fr-wv-ruling-items p{min-width:0;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'fr-wv-trace-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* --------------------------------------------------------- 小工具 */
  function statCard(key, value, unit) {
    var d = el('div', 'fr-wv-stat');
    d.appendChild(el('div', 'k', key));
    var v = el('div', 'v', String(value));
    if (unit) { var s = el('small'); s.textContent = unit; v.appendChild(s); }
    d.appendChild(v);
    return d;
  }
  function stepCard(name, meta, detail, state) {
    var d = el('div', 'fr-wv-step' + (state ? ' ' + state : ''));
    var t = el('div', 't');
    t.appendChild(el('span', 'name', name));
    if (meta) t.appendChild(el('span', 'meta', meta));
    d.appendChild(t);
    if (detail) d.appendChild(el('div', 'd', detail));
    return d;
  }
  function sectionHead(text) { return el('div', 'h', text); }
  function fold(summaryText, openByDefault, key) {
    var d = document.createElement('details');
    d.className = 'fr-wv-fold';
    var remembered = key && foldMemory.has(key) ? foldMemory.get(key) : null;
    d.open = remembered == null ? !!openByDefault : remembered;
    if (key) d.addEventListener('toggle', function () { foldMemory.set(key, d.open); });
    var s = document.createElement('summary');
    s.textContent = summaryText;
    d.appendChild(s);
    var body = el('div', 'body');
    d.appendChild(body);
    d._body = body;
    return d;
  }
  function pre(text, mono) {
    var p = el('pre', 'fr-wv-pre' + (mono ? ' mono' : ''));
    p.textContent = String(text == null ? '' : text);
    return p;
  }

  function renderRulings(body) {
    var cards = el('div', 'fr-wv-rulings');
    var card, items, lastText;
    function begin(title) {
      card = el('section', 'fr-wv-ruling');
      if (title) card.appendChild(el('h3', '', title));
      cards.appendChild(card);
      items = lastText = null;
    }
    String(body || '').split(/\r?\n/).forEach(function (raw) {
      var titledRule=raw.trim().match(/^\d+[.)、]\s*\*\*([^*]+?)\*\*\s*[：:]\s*(.*)$/);
      if(titledRule){
        begin(titledRule[1].replace(/[：:]$/, ''));
        if(titledRule[2]){
          lastText=el('p','',titledRule[2]);
          card.appendChild(lastText);
        }
        return;
      }
      var line = raw.trim().replace(/\*\*([^*]+)\*\*/g, '$1');
      if (!line) { lastText = null; return; }
      var header = line.match(/^#{1,6}\s+(.+)$|^【([^】]+)】$/);
      if (header) {
        var title = (header[1] || header[2]).replace(/^【(.+)】$/, '$1');
        begin(title.replace(/^规则裁定\s*[：:]\s*/, ''));
        return;
      }
      if (!card) begin('');
      var marker = /^(?:[-*•]\s+|\d+[.)、]\s*)/;
      var bullet = marker.test(line);
      var content = line.replace(marker, '');
      var field = content.match(/^([^：:\s]{1,14})[：:]\s*(.*)$/);
      if (bullet || field) {
        if (!items) {
          items = el('ul', 'fr-wv-ruling-items');
          card.appendChild(items);
        }
        var item = el('li', '');
        if (field) {
          var kind = /依据|证据/.test(field[1]) ? ' basis' :
            /防误判|风险|限制|禁写|代价/.test(field[1]) ? ' caution' : '';
          item.appendChild(el('span', 'fr-wv-ruling-label' + kind, field[1]));
        }
        lastText = el('p', '', field ? field[2] : content);
        item.appendChild(lastText);
        items.appendChild(item);
      } else if (lastText) {
        lastText.textContent += '\n' + line;
      } else {
        items = null;
        lastText = el('p', '', line);
        card.appendChild(lastText);
      }
    });
    return cards;
  }

  /* ------------------------------------------------------- 渲染单条记录 */
  function renderOne(host, tr) {
    var ok = tr.status === 'done';
    var failed = tr.status === 'failed';
    var cancelled = tr.status === 'cancelled';

    // ---- 顶部总览 ----
    var head = el('div', 'fr-wv-head');
    head.appendChild(statCard('输入资料', num(tr.inputTotal), '字'));
    head.appendChild(statCard('命中规则', tr.rules ? num(tr.rules.count) : '—',
      tr.rules && tr.rules.enabledTotal ? '／' + tr.rules.enabledTotal + ' 条' : '条'));
    head.appendChild(statCard('提示词', tr.prompt ? num(tr.prompt.promptChars) : '—', '字'));
    head.appendChild(statCard('裁定输出', tr.result && tr.result.blockChars != null ? num(tr.result.blockChars) : '—', '字'));
    if (tr.request) head.appendChild(statCard('模型耗时', secs(tr.request.durationMs).replace(' 秒', ''), '秒'));
    host.appendChild(head);

    // ---- 采集流程 ----
    var flow = el('div', 'fr-wv-flow');

    // ① 输入资料
    var inputStep = stepCard('收集输入资料',
      num(tr.inputTotal) + ' 字',
      '本轮喂给裁定器的全部素材。灰色是空的，金色是有内容的。',
      tr.inputTotal > 0 ? 'ok' : 'bad');
    var bars = el('div', 'fr-wv-bars');
    (tr.inputParts || []).forEach(function (p) {
      var b = el('span', 'fr-wv-bar' + (p.filled ? ' hit' : ' miss'));
      b.innerHTML = esc(p.name) + ' <b>' + num(p.chars) + '</b>';
      bars.appendChild(b);
    });
    inputStep.appendChild(bars);
    flow.appendChild(inputStep);

    // ② 规则命中
    if (tr.rules) {
      var ruleDetail;
      if (tr.rules.count) {
        ruleDetail = '命中 ' + tr.rules.count + ' 条，共 ' + num(tr.rules.chars) + ' 字';
        if (tr.rules.maxChars) {
          ruleDetail += '（上限 ' + num(tr.rules.maxChars) + ' 字）';
        }
        if (tr.rules.droppedCount) {
          ruleDetail += '；因超出上限被裁掉 ' + tr.rules.droppedCount + ' 条：' +
            (tr.rules.droppedNames || []).join('、') +
            (tr.rules.droppedCount > (tr.rules.droppedNames || []).length ? ' 等' : '');
        }
      } else {
        ruleDetail = '没有任何规则命中——绿灯关键词没触发，或规则全部停用。';
      }
      var ruleStep = stepCard('匹配世界规则',
        tr.rules.count + ' 条' + (tr.rules.totalRules ? ' / 候选 ' + tr.rules.totalRules + ' 条' : ''),
        ruleDetail, tr.rules.count ? 'ok' : 'bad');
      if ((tr.rules.items || []).length) {
        var rl = el('div', 'fr-wv-rules');
        tr.rules.items.slice(0, 40).forEach(function (r) {
          var t = el('span', 'fr-wv-rule');
          // 被裁掉的规则单独标出来，玩家一眼能看出「为什么这条没生效」
          t.textContent = r.name + ' · ' + num(r.chars) + '字' +
            (r.dropped ? '（已裁）' : '') +
            (r.trigger === 'green' ? ' · 绿灯' : '');
          if (r.dropped) t.style.opacity = '.5';
          if (r.dropped) t.style.textDecoration = 'line-through';
          rl.appendChild(t);
        });
        if (tr.rules.items.length > 40) {
          var more = el('span', 'fr-wv-rule');
          more.textContent = '…还有 ' + (tr.rules.items.length - 40) + ' 条';
          rl.appendChild(more);
        }
        ruleStep.appendChild(rl);
      }
      flow.appendChild(ruleStep);
    }

    // ③ 提示词拼装
    if (tr.prompt) {
      var ph = (tr.prompt.placeholders || []);
      var ps = stepCard('拼装提示词',
        num(tr.prompt.promptChars) + ' 字',
        '模板 ' + num(tr.prompt.templateChars) + ' 字，填充后 ' + num(tr.prompt.promptChars) + ' 字' +
        (ph.length ? '；用到占位符 ' + ph.length + ' 个：' + ph.join('、') : '；没有占位符'),
        'ok');
      flow.appendChild(ps);
    }

    // ④ 模型请求
    if (tr.request) {
      flow.appendChild(stepCard('请求模型裁定',
        secs(tr.request.durationMs),
         '接口返回 ' + num(tr.request.rawChars) + ' 字正文' +
           (tr.request.reasoningChars ? '，分析 ' + num(tr.request.reasoningChars) + ' 字' : '') +
           (tr.request.finishReason ? '，结束原因 ' + tr.request.finishReason : '') +
           (tr.request.attempts?.length > 1 ? '，共 ' + tr.request.attempts.length + ' 次返回' : '') + '。',
        'ok'));
    }

    // ⑤ 生成裁定 / 失败
    if (ok) {
      flow.appendChild(stepCard('生成裁定结果',
        num(tr.result.blockChars) + ' 字',
        '已拼装成注入块，会前置到正文提示词最前面。' +
        (tr.result.thinkingChars ? '其中思维链 ' + num(tr.result.thinkingChars) + ' 字（不注入）。' : ''),
        'ok'));
    } else {
      flow.appendChild(stepCard(failed ? '请求失败' : cancelled ? '裁定已取消' : '本轮跳过',
        '',
        (tr.result && tr.result.reason) || '未产生裁定结果。',
        failed ? 'bad' : ''));
    }
    host.appendChild(flow);

    // ---- 结果展示 ----
    if (ok && tr.result) {
      var sec = el('div', 'fr-wv-sec');
      sec.appendChild(sectionHead('裁定结果'));

      var box = el('div', 'fr-wv-box');
      var label = el('div', 'label');
      label.style.cssText = 'font-size:11px;color:#a99a78;margin-bottom:6px;letter-spacing:.4px;';
      label.textContent = '注入正文提示词的内容（' + num(tr.result.blockChars) + ' 字）';
      box.appendChild(label);
      box.appendChild(renderRulings(tr.result.body || '（无正文内容）'));
      sec.appendChild(box);

      if (tr.result.thinking) {
        var th = el('div', 'fr-wv-box think');
        th.style.marginTop = '8px';
        var tl = el('div', 'label');
        tl.style.cssText = 'font-size:11px;margin-bottom:6px;letter-spacing:.4px;';
        tl.textContent = '思维链（模型裁定前的推理，' + num(tr.result.thinkingChars) + ' 字，不注入正文）';
        th.appendChild(tl);
        th.appendChild(pre(tr.result.thinking));
        sec.appendChild(th);
      }
      host.appendChild(sec);
    }

    // ---- 完整原始输出（默认折叠）----
    if (tr.result && (tr.result.body || tr.result.thinking)) {
      var rawFold = fold('查看完整原始输出', false, 'raw-' + tr.id);
      rawFold._body.appendChild(pre(
        (tr.result.thinking ? '<thinking>\n' + tr.result.thinking + '\n</thinking>\n\n' : '') +
        (tr.result.body || ''), true));
      host.appendChild(rawFold);
    }
  }

  function render() {
    var popup = document.getElementById('thinking-log-popup');
    var tab = document.getElementById('thinking-log-worldview-content');
    if (!popup || popup.classList.contains('hidden') || !tab?.classList.contains('active')) return;
    var host = document.getElementById(MOUNT_ID);
    if (!host) return;
    injectStyle();
    host.innerHTML = '';
    var trace = window.FRReadWorldviewTurn?.();
    if (trace) {
      if (activeTraceId !== trace.id) {
        foldMemory.clear();
        activeTraceId = trace.id;
      }
      var heading = el('div', 'fr-wv-sec');
      heading.appendChild(sectionHead('本轮裁定 · ' + hhmmss(trace.startedAt) +
        (trace.request ? ' · 耗时 ' + secs(trace.request.durationMs) : '')));
      host.appendChild(heading);
      renderOne(host, trace);
      return;
    }
    foldMemory.clear();
    activeTraceId = null;
    var empty = el('div', 'fr-wv-empty');
    empty.appendChild(el('div', 'big', window.FRWorldview?.cfgLoad().enabled ?
      '本回合暂无裁定' : '世界观指导当前是关闭状态'));
    host.appendChild(empty);
  }

  var activeTraceId = null;
  var renderTimer = null;
  function renderSoon() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; try { render(); } catch (e) { console.warn('[世界观指导面板] 渲染失败:', e); } }, 60);
  }

  window.FRWorldviewTrace = { render: render, renderSoon: renderSoon };

  // 标签页切换时重绘（面板可能一开始是隐藏的，尺寸为 0，切过来才需要真渲染）
  window.addEventListener('fr:wv-trace-changed', renderSoon);
  window.addEventListener('fr:thinking-tab', renderSoon);

  function boot() {
    injectStyle();
    renderSoon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
