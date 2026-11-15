/* ============================================================================
 * equipment-view.js
 *
 * 装备命名槽位渲染组件（可复用，玩家与 NPC 共用同一实现）。
 *
 * ── 分工边界（不得越界） ────────────────────────────────────────────
 *   · 槽位数量与名称**全部由调用方传入**（slots），本组件不内置 1/4/4/6，
 *     也不推断、不兜底成任何默认数量。根侧（Codex）是权威合同的唯一来源。
 *   · 不读存档、不写存档、不装备、不卸下、不弹物品详情。
 *   · 回调只向上报意图：onEmpty(index) / onItem(item, index)。
 *
 * ── 安全 ──────────────────────────────────────────────────────────
 *   · 一切物品文本一律 textContent（不拼 innerHTML），恶意 HTML 不会执行。
 *   · 无任何全局依赖，不假设存在图标库或既有样式类名。
 *
 * ── 键盘与读屏 ────────────────────────────────────────────────────
 *   · 槽位是原生 <button>，Tab 可达，Enter/Space 原生触发 click。
 *   · aria-label 由槽名 + 状态（空 / 已装备某物）构成，可朗读。
 *
 * ── 接口 ──────────────────────────────────────────────────────────
 *   FrEquipmentView.render(container, {
 *     slotKey,                      // 'weapon'|'armor'|'technique'|'treasure'，仅作类名与可访问性提示
 *     slots: [{index, label, role}],// role: 'primary'|'normal'（武器主位 / 本命法宝可区分）
 *     items,                        // 按 index 排列的数组；元素为物品对象或 null/undefined
 *     onEmpty(index),               // 可选；空槽被点击。readonly 时不触发
 *     onItem(item, index),          // 可选；有物品被点击。readonly 时仍可触发（查看详情）
 *     readonly                      // 可选；true 时禁用 onEmpty 但不影响 onItem
 *   })
 *
 *   render 会清空 container 并重建，可重复调用（幂等，不残留旧监听器）。
 * ========================================================================= */
(function (global) {
  'use strict'

  var CLASS_ROOT = 'fr-equip'
  var CLASS_SLOT = CLASS_ROOT + '__slot'
  var CLASS_LABEL = CLASS_ROOT + '__label'
  var CLASS_NAME = CLASS_ROOT + '__name'
  var CLASS_EMPTY = CLASS_ROOT + '__hint'
  var CLASS_HEAD = CLASS_ROOT + '__head'
  var CLASS_TITLE = CLASS_ROOT + '__title'
  var CLASS_GROUP = CLASS_ROOT + '__group'

  /* 槽位键 -> 中文组名。仅用于标题与可访问性，不参与槽位数量决策。 */
  var GROUP_TITLES = {
    weapon: '兵器',
    armor: '护甲',
    technique: '功法',
    treasure: '法宝'
  }

  // 装饰线纹只表达部位，不参与槽位、物品类型或数值判定。
  function slotEmblem (key, index) {
    var shapes = {
      weapon: ['M8 28 27 9l4-2-2 5L11 31M7 22l7 7M5 31l3 3'],
      armor: ['M9 24V17a11 11 0 0 1 22 0v7l-7 4v-9h-8v9zM20 5v9', 'M13 7l7 4 7-4 8 9-6 5-3-4v16H14V17l-3 4-6-5z', 'M12 7h16l-2 14 6 7v5H21V22h-2v11H8v-5l6-7z', 'M20 7l7 8-7 9-7-9zM15 22c-9 5-8 12 5 12s14-7 5-12'],
      technique: ['M10 8h21v23H10M10 8a3 3 0 0 0-3 3v21a3 3 0 0 1 3-3h21M15 14h11M15 19h11M15 24h7', 'M20 6l12 7v14l-12 7-12-7V13zM20 12v16M14 16l6-4 6 4M14 24l6 4 6-4', 'M5 20s6-10 15-10 15 10 15 10-6 10-15 10S5 20 5 20zM20 15a5 5 0 1 0 0 10 5 5 0 0 0 0-10M20 4v3M20 33v3', 'M20 5l15 15-15 15L5 20zM13 15h14M13 20h14M17 25h10M17 11v18'],
      treasure: ['M20 5l11 6v14L20 35 9 25V11zM20 10l6 8-6 11-6-11zM9 11l11 7 11-7', 'M20 6l12 14-12 14L8 20zM8 20h24M20 6v28']
    }
    var choices=shapes[key]||shapes.treasure,svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
    svg.setAttribute('viewBox','0 0 40 40');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('fr-equip__emblem')
    var path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',choices[index]||choices[choices.length-1]);svg.appendChild(path)
    return svg
  }

  function textOfItem (item) {
    if (!item) return ''
    /* 兼容两种取名字段：数据表第 1 列 item['1']，以及归一化后的 item.name。 */
    var raw = item['1'] != null && item['1'] !== '' ? item['1'] : item.name
    return raw == null ? '' : String(raw).replace(/<\/?(?:span|font|b|i|strong|em)\b[^>]*>/gi,'').replace(/&(?:amp|lt|gt|quot|#39);/g,function(entity){return {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]})
  }

  /* aria-label 只用于表达「哪个槽 + 有没有东西」，绝不内嵌原始物品名：
     物品名来自存档数据，可能是任意 HTML 或超长串。虽然作为属性不会执行，
     但读屏会把它原样念出来，等于把脏数据塞进无障碍通道。
     需要朗读名字时由调用方在详情里提供，组件只给一个稳定的槽位语义。 */
  function ariaFor (label, hasItem, readonly) {
    if (hasItem) return label + '：已装备'
    return label + (readonly ? '：空闲' : '：空闲，可装备')
  }

  /**
   * 渲染一个槽位分区。
   * @param {Array} slotDefs 权威槽位定义
   * @param {Array} items    按 index 排列的物品
   * @param {Object} opts    {readonly, onEmpty, onItem, slotKey}
   */
  function renderGroup (slotDefs, items, opts) {
    var wrap = document.createElement('div')
    wrap.className = CLASS_GROUP
    wrap.setAttribute('data-slot-key', String(opts.slotKey || ''))

    var head = document.createElement('div')
    head.className = CLASS_HEAD

    var title = document.createElement('span')
    title.className = CLASS_TITLE
    title.textContent = GROUP_TITLES[opts.slotKey] || String(opts.slotKey || '')
    head.appendChild(title)
    var count=document.createElement('span')
    count.className='fr-equip__count'
    count.textContent=slotDefs.filter(function(def){return !!textOfItem(items[def.index])}).length+' / '+slotDefs.length
    count.setAttribute('aria-label','已装备槽位 '+count.textContent)
    head.appendChild(count)
    wrap.appendChild(head)

    var row = document.createElement('div')
    row.className = CLASS_ROOT + '__row'

    slotDefs.forEach(function (def) {
      var index = Number(def && def.index)
      var label = String((def && def.label) || '')
      var role = String((def && def.role) || 'normal')
      var item = items ? items[index] : null
      var itemName = textOfItem(item)
      var lockedReason = opts.lockedSlots && opts.lockedSlots[index]

      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = CLASS_SLOT
      btn.setAttribute('data-slot-index', String(index))
      btn.setAttribute('data-slot-role', role)
      if (itemName) btn.setAttribute('data-filled', '1')
      else btn.setAttribute('data-filled', '0')
      if (opts.readonly) btn.setAttribute('data-readonly', '1')

      var presentation = global.FrItemPresentation
      var rarity = itemName && presentation && typeof presentation.rarity === 'function' ? presentation.rarity(item) : null
      if (itemName && presentation && typeof presentation.decorate === 'function') presentation.decorate(btn,item)
      if (itemName && presentation && typeof presentation.icon === 'function') {
        var iconTemplate = document.createElement('template')
        iconTemplate.innerHTML = presentation.icon(item,'fr-equip__emblem')
        btn.appendChild(iconTemplate.content.firstElementChild || slotEmblem(opts.slotKey,index))
      } else btn.appendChild(slotEmblem(opts.slotKey,index))

      var lab = document.createElement('span')
      lab.className = CLASS_LABEL
      lab.textContent = label
      btn.appendChild(lab)

      if (itemName) {
        var nm = document.createElement('span')
        nm.className = CLASS_NAME
        nm.textContent = itemName
        if (rarity && rarity.known && /^#[0-9a-f]{3,8}$/i.test(rarity.color)) nm.style.color = rarity.color
        btn.appendChild(nm)
        var status = document.createElement('span')
        status.className = 'fr-equip__status'
        status.textContent = opts.slotKey === 'technique' ? '修习中' : '已装备'
        btn.appendChild(status)
        if (rarity && rarity.label) {
          var grade = document.createElement('span')
          grade.className='fr-equip__grade';grade.textContent=rarity.label;btn.appendChild(grade)
          if(rarity.known&&/^#[0-9a-f]{3,8}$/i.test(rarity.color))grade.style.color=rarity.color
        }
      } else {
        var hint = document.createElement('span')
        hint.className = CLASS_EMPTY
        hint.textContent = lockedReason || (opts.readonly ? '空' : '点击装备')
        btn.appendChild(hint)
      }

      btn.setAttribute('aria-label', lockedReason && !itemName ? label+'：'+lockedReason : ariaFor(label, !!itemName, opts.readonly))
      if(lockedReason&&!itemName){btn.disabled=true;btn.setAttribute('data-locked','1');btn.title=lockedReason}

      btn.addEventListener('click', function () {
        if (itemName) {
          /* readonly 仍允许查看详情。 */
          if (typeof opts.onItem === 'function') opts.onItem(item, index)
          return
        }
        /* 空槽：readonly 不响应。 */
        if (opts.readonly) return
        if (typeof opts.onEmpty === 'function') opts.onEmpty(index)
      })

      row.appendChild(btn)
    })

    wrap.appendChild(row)
    return wrap
  }

  /**
   * 渲染装备视图。幂等：每次调用都清空 container 再重建。
   * @param {Element} container 目标容器
   * @param {Object} config     见文件头接口说明
   */
  function render (container, config) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('FrEquipmentView.render: 需要一个容器元素')
    }
    var cfg = config || {}
    var slots = Array.isArray(cfg.slots) ? cfg.slots : []
    var items = Array.isArray(cfg.items) ? cfg.items : []
    var opts = {
      slotKey: cfg.slotKey,
      readonly: cfg.readonly === true,
      onEmpty: cfg.onEmpty,
      onItem: cfg.onItem,
      lockedSlots: cfg.lockedSlots || {}
    }

    /* 清空重建：同时清掉旧节点与旧监听器，重复 render 不叠加回调。 */
    container.textContent = ''
    container.classList.add(CLASS_ROOT)
    if (opts.readonly) container.setAttribute('data-readonly', '1')
    else container.removeAttribute('data-readonly')

    var root = document.createElement('div')
    root.className = CLASS_ROOT + '__body'

    if (!slots.length) {
      var blank = document.createElement('div')
      blank.className = CLASS_EMPTY
      blank.textContent = '暂无槽位'
      root.appendChild(blank)
    } else {
      root.appendChild(renderGroup(slots, items, opts))
    }

    container.appendChild(root)
    return container
  }

  if (global) {
    global.FrEquipmentView = { render: render }
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : undefined));
