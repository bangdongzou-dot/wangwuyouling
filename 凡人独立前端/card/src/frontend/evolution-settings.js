/* Settings presentation only. Original controls retain their nodes and handlers. */
var FrEvolutionSettings = (function () {
  'use strict';
  var instances = new WeakMap();
  var tabs = [['schedule', '调度与触发', '决定何时演化，以及本轮关注谁。'], ['routing', '阶段路由', '选择参与阶段，配置请求接口与优先级。'], ['presets', '预设与模板', '选择规则，查看模板，维护自己的预设。'], ['resilience', '并发与容错', '设置请求节奏、重试与失败处理。']];
  var groupNames = { player: '主角', npc: '人物', beast: '灵兽', humanoid_beast: '类人灵兽', entry_all_focus: '登场判定', item_management: '物品管理', misc_management: '杂项演化', misc_without_map: '无地图杂项', map_management: '地图管理', image_evolution: '生图演化', merged_variables: '合并演化', original_timeline_evolution: '旧原著联动' };
  var inactiveGroups = ['humanoid_beast', 'map_management', 'misc_without_map', 'original_timeline_evolution'];
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function button(text, cls) { var node = el('button', cls || 'small-btn', text); node.type = 'button'; return node; }
  function readonly(preset) { return !!(preset && (preset.frBuiltinCatalogId || preset.isBuiltIn === true || preset.readOnly === true)); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function groups(preset) {
    var result = [];
    ['rules', 'entrySharedRules', 'itemSharedRules', 'sharedRules'].forEach(function (key) {
      if (Array.isArray(preset[key]) && preset[key].length) result.push({ key: key, label: { rules: '通用规则', entrySharedRules: '登场共享', itemSharedRules: '物品共享', sharedRules: '人物共享' }[key], rules: preset[key] });
    });
    Object.keys(preset.prompts || {}).forEach(function (key) {
      var group = preset.prompts[key];
      if (group && Array.isArray(group.rules)) result.push({ key: key, label: groupNames[key] || key, rules: group.rules, prompt: true, enabled: group.enabled });
    });
    return result;
  }
  async function mount(overlay, options) {
    if (!overlay) throw new Error('找不到变量演化设置面板');
    if (instances.has(overlay)) { var previous = instances.get(overlay); await previous.refresh(options); return previous; }
    var opts = options || {}, body = overlay.querySelector('.modal-body');
    if (!body) throw new Error('找不到变量演化设置内容');
    var originalNodes = Array.from(body.children);
    var originalChildren = originalNodes.reduce(function (list, node) { return list.concat([node], Array.from(node.querySelectorAll('*'))); }, []).map(function (node) { return { node: node, children: Array.from(node.childNodes) }; });
    overlay.classList.add('fr-evolution-settings');
    var header = overlay.querySelector('.modal-header h3'); if (header) header.textContent = '变量演化设置';
    var selectedTab = 'schedule', category = null, abort = new AbortController(), panels = {}, tabButtons = {};
    var signal = abort.signal;
    function listen(node, type, fn) { node.addEventListener(type, fn, { signal: signal }); }
    function find(id) { return overlay.querySelector('#' + id); }
    function report(error) { if (opts.onError) return opts.onError(error && error.message || String(error)); console.error(error); }
    var nav = el('div', 'fr-evo-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '变量演化设置分类');
    body.before(nav);
    tabs.forEach(function (entry, index) {
      var key = entry[0], tab = button(entry[1], 'fr-evo-tab');
      tab.id = 'fr-evo-tab-' + key; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'fr-evo-panel-' + key);
      nav.append(tab); tabButtons[key] = tab;
      var panel = el('section', 'fr-evo-panel'); panel.id = 'fr-evo-panel-' + key; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      panel.append(el('h4', 'fr-evo-panel-title', entry[1]), el('p', 'fr-evo-panel-description', entry[2]));
      panels[key] = panel; body.append(panel);
      listen(tab, 'click', function () { activate(key); });
      listen(tab, 'keydown', function (event) {
        var next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); activate(tabs[next][0]); tabButtons[tabs[next][0]].focus(); }
      });
    });
    function activate(key) {
      if (!panels[key]) return;
      selectedTab = key;
      tabs.forEach(function (entry) { var current = entry[0] === key; panels[entry[0]].hidden = !current; tabButtons[entry[0]].setAttribute('aria-selected', String(current)); tabButtons[entry[0]].tabIndex = current ? 0 : -1; });
      body.scrollTop = 0;
    }
    function moveSections() {
      Array.from(body.children).filter(function (node) { return !node.classList.contains('fr-evo-panel'); }).forEach(function (section) {
        var destination = 'schedule';
        if (section.querySelector('#backup-api-configs-container, #concurrent-evo-enable-image-evolution')) destination = 'routing';
        if (section.querySelector('#concurrent-evo-preset-select')) destination = 'presets';
        if (section.querySelector('#concurrent-evo-max-concurrency, #concurrent-evo-show-error-modal, #concurrent-evo-debug-logging')) destination = 'resilience';
        panels[destination].append(section);
      });
      var original = find('ce-original-timeline-settings-block');
      if (original) {
        var parse = original.querySelector('#concurrent-evo-parse-retry-count');
        if (parse && !find('fr-evo-parse-settings')) {
          var block = el('div', 'settings-section'); block.id = 'fr-evo-parse-settings'; block.append(el('h4', '', '指令解析'));
          block.append(parse.closest('label') || parse); panels.resilience.prepend(block);
        }
        panels.schedule.append(original);
      }
      var merged = find('concurrent-evo-merged-settings'), running = find('concurrent-evo-enabled');
      running = running && running.closest('.settings-section');
      if (running) panels.schedule.insertBefore(running, panels.schedule.children[2] || null);
      if (merged) running ? running.after(merged) : panels.schedule.insertBefore(merged, panels.schedule.children[2] || null);
    }
    moveSections();
    var stageBlock = el('div', 'settings-section fr-evo-stage-controls'); stageBlock.append(el('h4', '', '参与阶段'));
    [['concurrent-evo-enable-entry-decision', '登场判定', '判断角色本轮的登退场。', 'enableEntryDecision'], ['concurrent-evo-enable-misc-evolution', '杂项演化', '处理世界状态与杂项变化。', 'enableMiscEvolution']].forEach(function (entry) {
      var label = el('label', 'toggle-label fr-evo-stage-card'), input = find(entry[0]) || el('input'); input.id = entry[0]; input.type = 'checkbox'; input.checked = (opts.config || {})[entry[3]] !== false;
      var words = el('span', 'fr-evo-stage-words'); words.append(el('strong', '', entry[1]), el('small', '', entry[2]));
      label.append(words, input); stageBlock.append(label);
    });
    stageBlock.append(el('p', 'hint', '人物与物品的规则组可在「预设与模板」中查看；复制为自定义后可以调整启用状态。'));
    panels.routing.insertBefore(stageBlock, panels.routing.children[2] || null);
    var presentationWrappers = [], footerNote, apiDisclosure, apiSummary;
    function disclosure(id, title, cls) { var node = el('details', 'fr-evo-disclosure ' + (cls || '')); node.id = id; node.append(el('summary', '', title)); presentationWrappers.push(node); return node; }
    function sectionFor(id) { var node = find(id); return node && node.closest('.settings-section'); }
    function upgradeHierarchy() {
      var running = sectionFor('concurrent-evo-enabled');
      if (running) { running.classList.add('fr-evo-running'); var title = running.querySelector('h4'); if (title) title.textContent = '运行状态'; var master = running.querySelector('.toggle-label'); if (master) master.classList.add('fr-evo-master-toggle'); }
      var scope = sectionFor('concurrent-evo-focus-mode');
      if (scope && !find('fr-evo-background-settings')) {
        scope.classList.add('fr-evo-target-settings'); var heading = scope.querySelector('h4'); if (heading) heading.textContent = '本轮目标范围';
        var warning = scope.querySelector('.evo-freq-warning'); if (warning) warning.textContent = '按本轮需要选择在场人物，并为离场人物维护关注名单。';
        var background = el('div', 'settings-section fr-evo-background-settings'); background.id = 'fr-evo-background-settings';
        background.append(el('h4', '', '后台调度与冻结'), el('p', 'hint', '为离场人物安排活跃名额，保留近期剧情联系，并冻结暂不参与演化的角色。'));
        var advanced = disclosure('fr-evo-background-advanced', '活跃名额与近期保护', 'fr-evo-advanced');
        var audit = disclosure('fr-evo-background-audit', '离场标签校准', 'fr-evo-advanced');
        var moveBackground = false, intoAudit = false;
        Array.from(scope.children).forEach(function (node) {
          if (node.querySelector('#concurrent-evo-enable-offscreen-active-selection')) moveBackground = true;
          if (!moveBackground || node.id === 'concurrent-evo-focus-all') return;
          if (node.querySelector('#concurrent-evo-enable-offscreen-tag-model-audit')) intoAudit = true;
          if (node.querySelector('#concurrent-evo-entry-offscreen-limit')) { intoAudit = false; advanced.append(node); return; }
          if (node.querySelector('#concurrent-evo-offscreen-tag-audit-per-turn-limit')) { audit.append(node); intoAudit = false; return; }
          (intoAudit ? audit : background).append(node);
        });
        background.append(advanced, audit); scope.after(background); presentationWrappers.push(background);
      }
      var api = sectionFor('backup-api-configs-container');
      if (api && !find('fr-evo-api-disclosure')) {
        apiDisclosure = disclosure('fr-evo-api-disclosure', '演化接口', 'fr-evo-api-disclosure'); api.before(apiDisclosure); apiDisclosure.append(api); apiSummary = apiDisclosure.querySelector('summary');
        apiDisclosure.open = !(opts.config && opts.config.apiModel);
      }
      if (apiSummary) { apiSummary.replaceChildren(el('span', '', '演化接口'), el('small', '', opts.config && opts.config.apiModel ? '当前模型 · ' + opts.config.apiModel : '配置模型与备用优先级')); }
      var concurrency = sectionFor('concurrent-evo-max-concurrency'), retry = find('fr-evo-parse-settings');
      if (concurrency && !find('fr-evo-retry-grid')) {
        concurrency.classList.add('fr-evo-request-budget'); var title = concurrency.querySelector('h4'); if (title) title.textContent = '请求节奏';
        if (!retry) { retry = el('div', 'settings-section'); retry.id = 'fr-evo-parse-settings'; retry.append(el('h4', '', '等待与重试')); panels.resilience.append(retry); presentationWrappers.push(retry); }
        var retryTitle = retry.querySelector('h4'); if (retryTitle) retryTitle.textContent = '等待与重试';
        var retryGrid = el('div', 'input-row fr-evo-retry-grid'); retryGrid.id = 'fr-evo-retry-grid';
        var parse = find('concurrent-evo-parse-retry-count');
        if (parse) { var group = el('div', 'input-group'); group.append(parse.closest('label') || parse); retryGrid.append(group); }
        ['concurrent-evo-timeout', 'concurrent-evo-retry-count'].forEach(function (id) { var input = find(id); if (input) retryGrid.append(input.closest('.input-group')); });
        retry.append(retryGrid); concurrency.after(retry);
      }
      var errors = sectionFor('concurrent-evo-show-error-modal'); if (errors) { errors.classList.add('fr-evo-error-policy'); var title = errors.querySelector('h4'); if (title) title.textContent = '失败时如何继续'; }
      var debug = sectionFor('concurrent-evo-debug-logging');
      if (debug && !find('fr-evo-debug-disclosure')) { var detail = disclosure('fr-evo-debug-disclosure', '调试与单项测试', 'fr-evo-debug-disclosure'); debug.before(detail); detail.append(debug); }
      if (!footerNote) { footerNote = el('p', 'fr-evo-footer-note', '保存后下一轮生效'); var footer = overlay.querySelector('.modal-footer'); if (footer) footer.prepend(footerNote); }
      overlay.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(function (input) { input.classList.add('fr-evo-switch'); });
    }
    upgradeHierarchy();
    var modeSelect, modeRadios = [];
    function upgradeMode() {
      modeSelect = find('concurrent-evo-variable-update-mode');
      if (!modeSelect || find('fr-evo-mode-cards')) return;
      var cards = el('fieldset', 'fr-evo-mode-cards'); cards.id = 'fr-evo-mode-cards'; cards.append(el('legend', '', '变量更新方式'));
      [['staged', '分阶段演化', '逐阶段处理角色与世界变化', '登场 → 物品 → 人物 → 杂项'], ['merged', '合并演化（轻量）', '人数少时一次合并，超出上限时分批处理人物', '登场 · 物品 · 普通人物 · 杂项']].forEach(function (entry) {
        var label = el('label', 'fr-evo-mode-card'), input = el('input'); input.type = 'radio'; input.name = 'fr-evo-variable-mode'; input.value = entry[0];
        var words = el('span', 'fr-evo-mode-words'); words.append(el('strong', '', entry[1]), el('span', '', entry[2]), el('small', '', entry[3]));
        label.append(input, words); cards.append(label); modeRadios.push(input);
        listen(input, 'change', function () { if (input.checked) { modeSelect.value = input.value; modeSelect.dispatchEvent(new Event('change', { bubbles: true })); syncMode(); } });
      });
      modeSelect.closest('label') ? modeSelect.closest('label').classList.add('fr-evo-original-mode') : modeSelect.classList.add('fr-evo-original-mode');
      modeSelect.closest('.settings-section').prepend(cards);
      listen(modeSelect, 'change', syncMode); syncMode();
    }
    function syncMode() { if (!modeSelect) return; modeRadios.forEach(function (radio) { radio.checked = radio.value === modeSelect.value; }); var independent = find('concurrent-evo-merged-independent-targets'); if (independent) independent.hidden = modeSelect.value !== 'merged'; if(presetSelect&&presetCards)renderPresets(); }
    upgradeMode();
    var presetSelect = find('concurrent-evo-preset-select'), presetSection = presetSelect && presetSelect.closest('.settings-section');
    var chooser = el('div', 'fr-evo-preset-browser'), filters = el('div', 'fr-evo-preset-filters'), presetCards = el('div', 'fr-evo-preset-cards'), detail = el('div', 'fr-evo-preset-detail'), status = el('p', 'fr-evo-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var filterButtons = {};
    [['builtin', '内置预设'], ['custom', '自定义预设']].forEach(function (entry) { var node = button(entry[1], 'fr-evo-filter'); filterButtons[entry[0]] = node; filters.append(node); listen(node, 'click', function () { category = entry[0]; renderPresets(); }); });
    chooser.append(filters, presetCards, detail, status); if (presetSection) presetSection.prepend(chooser);
    function presets() { return presetSelect && Array.isArray(presetSelect._frPresets) ? presetSelect._frPresets : opts.presets || []; }
    function current() { return presets().find(function (p) { return String(p.id) === presetSelect.value; }); }
    function compatible(preset) { return typeof frEvolutionPresetSupportsMode!=='function'||frEvolutionPresetSupportsMode(preset,modeSelect?.value||'staged'); }
    function choosePreset(preset) { if(!compatible(preset)){status.textContent='此预设不适用于当前演化方式，请先切换方式。';return;}presetSelect.value = String(preset.id); presetSelect.dispatchEvent(new Event('change', { bubbles: true })); }
    async function action(node, fn) { node.disabled = true; try { await fn(); } catch (error) { await report(error); } finally { node.disabled = false; } }
    function renderPresets() {
      if (!presetSelect) return;
      var selected = current(); if (!category) category = readonly(selected) ? 'builtin' : 'custom';
      if(selected&&!compatible(selected)&&readonly(selected)&&typeof frEvolutionModePreset==='function'){
        var replacement=frEvolutionModePreset(presets(),selected.id,modeSelect?.value||'staged');
        if(replacement&&replacement.id!==selected.id){choosePreset(replacement);status.textContent='已切换为与当前方式匹配的'+(replacement.frBuiltinLabel||replacement.name);return;}
      }
      Array.from(presetSelect.options).forEach(function(option){var preset=presets().find(function(p){return String(p.id)===option.value;});option.disabled=!!preset&&!compatible(preset);});
      Object.keys(filterButtons).forEach(function (key) { filterButtons[key].setAttribute('aria-pressed', String(category === key)); });
      presetCards.replaceChildren();
      var visible = presets().filter(function (preset) { return readonly(preset) === (category === 'builtin'); });
      if (!visible.length) presetCards.append(el('p', 'hint', '还没有自定义预设。选择内置预设后，点击「复制为自定义」即可开始。'));
      visible.forEach(function (preset) {
        var card = button('', 'fr-evo-preset-card'); card.setAttribute('aria-pressed', String(selected && selected.id === preset.id));
        card.disabled=!compatible(preset);if(card.disabled){card.title='与当前演化方式不兼容';card.setAttribute('aria-disabled','true');}
        var cardName = readonly(preset) && preset.frBuiltinLabel ? preset.frBuiltinLabel : preset.name || '未命名预设';
        card.append(el('strong', '', cardName)); card.setAttribute('aria-label', cardName);
        card.append(el('span', 'fr-evo-badge', readonly(preset) ? '内置 · 只读' : '自定义 · 可编辑'));
        var mergedGroup = preset.prompts && preset.prompts.merged_variables;
        if (mergedGroup && mergedGroup.enabled !== false && Array.isArray(mergedGroup.rules) && mergedGroup.rules.length) card.append(el('span', 'fr-evo-badge', '支持合并'));
        listen(card, 'click', function () { choosePreset(preset); }); presetCards.append(card);
      });
      detail.replaceChildren();
      var deleteButton = find('concurrent-evo-delete-preset-btn'); if (deleteButton) { deleteButton.disabled = !selected || readonly(selected); deleteButton.title = readonly(selected) ? '内置预设只读' : ''; }
      if (!selected) { detail.append(el('p', 'hint', '请选择预设。')); return; }
      detail.append(el('h4', '', selected.name || '未命名预设'));
      if (readonly(selected)) {
        var isLight = /light/i.test(String(selected.frBuiltinCatalogId || '')) || /轻量/.test(String(selected.frBuiltinLabel || ''));
        detail.append(el('p', '', isLight ? '轻量规则适合合并演化，将登场、物品、普通人物与杂项集中处理。重要人物仍可加入独立演化名单。' : '完整规则适合分阶段演化，分别处理登场、物品、人物与世界变化。可逐组查看规则，按需要复制为自定义。'));
      } else if (selected.description) detail.append(el('p', '', selected.description));
      var clone = button('复制为自定义', 'small-btn fr-evo-clone'); clone.disabled = typeof opts.onClonePreset !== 'function';
      listen(clone, 'click', function () { action(clone, async function () { var result = await opts.onClonePreset(copy(selected)); if (result && result.id) { category = 'custom'; if (presets().some(function (p) { return p.id === result.id; })) choosePreset(result); } renderPresets(); status.textContent = '已复制为自定义预设'; }); }); detail.append(clone);
      var chips = el('div', 'fr-evo-rule-chips'), compatibility = el('details', 'fr-evo-compatibility'), compatibilityChips = el('div', 'fr-evo-rule-chips');
      compatibility.append(el('summary', '', '保留的兼容规则'), el('p', 'hint', '这些规则当前仅供查阅，不会作为独立阶段运行。原著补演请在独立设置中管理。'), compatibilityChips);
      groups(selected).forEach(function (group) {
        var chip = button(group.label + ' · ' + group.rules.length, 'fr-evo-rule-chip');
        if (group.enabled === false) chip.append(el('small', '', ' 已停用'));
        if (inactiveGroups.indexOf(group.key) >= 0) chip.append(el('small', '', ' 仅供查阅'));
        listen(chip, 'click', function () { openRules(selected, group, chip); }); (inactiveGroups.indexOf(group.key) >= 0 ? compatibilityChips : chips).append(chip);
      }); detail.append(chips);
      if (compatibilityChips.children.length) detail.append(compatibility);
      var templates = selected.contentTemplates || {}, keys = Object.keys(templates), disclosure = el('details', 'fr-evo-templates');
      disclosure.append(el('summary', '', '内容模板 · ' + keys.length));
      keys.forEach(function (key) { var item = el('details'); item.append(el('summary', '', key)); var pre = el('pre', '', typeof templates[key] === 'string' ? templates[key] : JSON.stringify(templates[key], null, 2)); item.append(pre); disclosure.append(item); });
      detail.append(disclosure);
    }
    var activeDialog = null;
    function openRules(preset, originalGroup, opener) {
      if (activeDialog) return;
      var draft = copy(preset), inactive = inactiveGroups.indexOf(originalGroup.key) >= 0, locked = readonly(preset) || inactive, draftGroup = originalGroup.prompt ? draft.prompts[originalGroup.key] : null;
      var rules = originalGroup.prompt ? draftGroup.rules : draft[originalGroup.key];
      var dialog = el('dialog', 'fr-evo-rule-dialog'); dialog.setAttribute('aria-labelledby', 'fr-evo-rule-dialog-title'); activeDialog = dialog;
      var heading = el('h3', '', (locked ? '查看规则 · ' : '编辑规则 · ') + originalGroup.label); heading.id = 'fr-evo-rule-dialog-title';
      var top = el('div', 'fr-evo-dialog-header'), close = button('关闭规则', 'small-btn'); top.append(heading, close); dialog.append(top);
      dialog.append(el('p', 'hint', inactive ? '该规则组当前不作为独立阶段运行，仅供查阅；原著补演请到独立设置中管理。' : locked ? '此预设为内置只读。复制为自定义后可修改。' : '可修改规则正文与启用状态。保存会保留规则顺序和其余预设内容。'));
      if (draftGroup) { var toggle = el('label', 'toggle-label'), enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = draftGroup.enabled !== false; enabled.disabled = locked; toggle.append(enabled, el('span', '', '启用此规则组')); dialog.append(toggle); listen(enabled, 'change', function () { draftGroup.enabled = enabled.checked; }); }
      var editor = el('div', 'fr-evo-rule-editor'), list = el('div', 'fr-evo-rule-list'), content = el('div', 'fr-evo-rule-content'); editor.append(list, content); dialog.append(editor);
      var selectedIndex = 0;
      function edit(index) {
        selectedIndex = index; content.replaceChildren();
        Array.from(list.children).forEach(function (node, i) { node.setAttribute('aria-pressed', String(i === index)); });
        var rule = rules[index]; if (!rule) { content.append(el('p', 'hint', '此规则组没有规则。')); return; }
        var title = el('label', 'fr-evo-rule-label', rule.name || rule.id || '规则 ' + (index + 1)); title.htmlFor = 'fr-evo-rule-text';
        var textarea = el('textarea'); textarea.id = 'fr-evo-rule-text'; textarea.value = typeof rule.content === 'string' ? rule.content : ''; textarea.readOnly = locked; textarea.rows = 16;
        var toggle = el('label', 'toggle-label'), enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false; enabled.disabled = locked; toggle.append(enabled, el('span', '', '启用此条规则'));
        listen(textarea, 'input', function () { rules[selectedIndex].content = textarea.value; }); listen(enabled, 'change', function () { rules[selectedIndex].enabled = enabled.checked; });
        content.append(title, toggle, textarea);
      }
      rules.forEach(function (rule, index) { var row = button(rule.name || rule.id || '规则 ' + (index + 1), 'fr-evo-rule-row'); listen(row, 'click', function () { edit(index); }); list.append(row); }); edit(0);
      var footer = el('div', 'fr-evo-dialog-footer');
      if (!locked) { var save = button('保存规则', 'primary-btn'); save.disabled = typeof opts.onSavePreset !== 'function'; listen(save, 'click', function () { action(save, async function () { await opts.onSavePreset(draft); dialog.close(); renderPresets(); status.textContent = '规则已保存'; }); }); footer.append(save); }
      dialog.append(footer); overlay.append(dialog);
      listen(close, 'click', function () { dialog.close(); });
      listen(dialog, 'close', function () { dialog.remove(); activeDialog = null; if (opener && opener.isConnected) opener.focus(); });
      dialog.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(function (input) { input.classList.add('fr-evo-switch'); });
      dialog.showModal(); close.focus();
    }
    if (presetSelect) listen(presetSelect, 'change', function () { category = readonly(current()) ? 'builtin' : 'custom'; renderPresets(); });
    // Only remember nodes this presentation moved. Dynamic list contents must
    // remain owned by their original renderers throughout unmount/remount.
    var migrations = originalChildren.map(function (entry) {
      return { parent: entry.node, siblings: entry.children, moved: entry.children.filter(function (child) { return child.isConnected && child.parentNode !== entry.node; }) };
    }).filter(function (entry) { return entry.moved.length; });
    var instance = {
      refresh: async function (next) { if (next) opts = Object.assign({}, opts, next); moveSections(); upgradeHierarchy(); upgradeMode(); syncMode(); if (next && next.config) { find('concurrent-evo-enable-entry-decision').checked = next.config.enableEntryDecision !== false; find('concurrent-evo-enable-misc-evolution').checked = next.config.enableMiscEvolution !== false; } renderPresets(); activate(selectedTab); },
      activate: activate,
      destroy: function () {
        abort.abort(); if (activeDialog) { activeDialog.close(); activeDialog.remove(); activeDialog = null; }
        if (modeSelect) { var hidden = modeSelect.closest('.fr-evo-original-mode'); if (hidden) hidden.classList.remove('fr-evo-original-mode'); }
        var cards = find('fr-evo-mode-cards'); if (cards) cards.remove();
        chooser.remove(); stageBlock.remove(); if (footerNote) footerNote.remove();
        migrations.forEach(function (entry) {
          if (!entry.parent.isConnected) return;
          var anchor = null;
          entry.siblings.slice().reverse().forEach(function (child) {
            if (entry.moved.indexOf(child) >= 0 && child.isConnected) entry.parent.insertBefore(child, anchor);
            if (child.parentNode === entry.parent) anchor = child;
          });
        });
        originalNodes.forEach(function (node) { body.append(node); }); presentationWrappers.forEach(function (node) { node.remove(); });
        Object.keys(panels).forEach(function (key) { panels[key].remove(); }); nav.remove(); overlay.classList.remove('fr-evolution-settings'); instances.delete(overlay);
      }
    };
    instances.set(overlay, instance); renderPresets(); activate(selectedTab); return instance;
  }
  return { mount: mount };
})();
