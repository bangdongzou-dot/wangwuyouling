// 内置目录只在读取时合并；玩家自定义内容及未知扩展字段完整保留。
function frIsBuiltinEvolutionPreset(preset) {
  return !!(preset && preset.frBuiltinCatalogId);
}

function frEvolutionPresetSupportsMode(preset, mode) {
  if (!preset) return false;
  var merged = mode === 'merged', id = String(preset.frBuiltinCatalogId || '');
  function hasRules(group) { return !!group && group.enabled !== false && Array.isArray(group.rules) && group.rules.some(function(rule) { return rule.enabled !== false && String(rule.content || '').trim(); }); }
  var capable=merged ? hasRules(preset.prompts?.merged_variables) : ['player','npc','beast'].some(function(key) { return hasRules(preset.prompts?.[key]); })||hasRules({rules:preset.rules});
  if (['full','light','ds-full','ds-light'].includes(id)) return capable && merged === id.endsWith('light');
  return capable;
}

function frEvolutionModePreset(presets, activeId, mode) {
  var list=Array.isArray(presets)?presets:[], current=list.find(function(p){return p.id===activeId;});
  if (frEvolutionPresetSupportsMode(current,mode)) return current;
  if (current && !frIsBuiltinEvolutionPreset(current)) return null;
  var family=String(current?.frBuiltinCatalogId||'').startsWith('ds-')?'ds-':'';
  var desired=family+(mode==='merged'?'light':'full');
  return list.find(function(p){return p.frBuiltinCatalogId===desired&&frEvolutionPresetSupportsMode(p,mode);}) || list.find(function(p){return frIsBuiltinEvolutionPreset(p)&&frEvolutionPresetSupportsMode(p,mode);}) || null;
}

function frMergeEvolutionPresetCatalog(data, catalog) {
  var source = data || {presets:[],activePresetId:''};
  var users = (Array.isArray(source.presets) ? source.presets : []).filter(function(p) {
    return !frIsBuiltinEvolutionPreset(p);
  });
  var reserved = new Set(users.map(function(p) { return p.id; }));
  return {...source,presets:users.concat((catalog || []).filter(function(p) {
    return !reserved.has(p.id);
  }).map(function(p) { return JSON.parse(JSON.stringify(p)); }))};
}

function frEvolutionPresetsForStorage(data) {
  return {...data,presets:(data.presets || []).filter(function(p) {
    return !frIsBuiltinEvolutionPreset(p);
  })};
}

function frPrepareEvolutionPresetImport(preset) {
  var copy = JSON.parse(JSON.stringify(preset));
  ['frBuiltinCatalogId','frBuiltinLabel','frBuiltinUpdatedAt','frBuiltinSource','sourceId','readOnly'].forEach(function(key) { delete copy[key]; });
  copy.isBuiltIn = false;
  // 旧版 rules 格式的兼容仅填缺失项，不重建或裁剪新格式元数据。
  if (!copy.prompts) copy.prompts = {
    player:{enabled:true,rules:copy.rules || []},
    npc:{enabled:true,rules:copy.rules || []},
    beast:{enabled:true,rules:copy.rules || []}
  };
  if (!copy.entrySharedRules) copy.entrySharedRules = copy.entry_shared_rules || [];
  if (!copy.itemSharedRules) copy.itemSharedRules = copy.item_shared_rules || [];
  if (!copy.sharedRules) copy.sharedRules = [];
  return copy;
}

var frEvolutionPresetCloneCounter = 0;
function frCloneEvolutionPresetForEditing(preset) {
  var copy = frPrepareEvolutionPresetImport(preset);
  copy.id = 'custom-' + Date.now() + '-' + (++frEvolutionPresetCloneCounter);
  copy.name = String(preset.name || '预设') + '（自定义副本）';
  if (copy.frPresetCompat && typeof copy.frPresetCompat === 'object') copy.frPresetCompat.originalName = copy.name;
  copy.createdAt = Date.now();
  return copy;
}

function frRefreshEvolutionPresetSelect(select, data, activeId) {
  if (!select) return;
  select.innerHTML = '';
  (data.presets || []).forEach(function(preset) {
    var option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  });
  select._frPresets = data.presets || [];
  select.value = activeId || '';
  select.dispatchEvent(new Event('change', {bubbles:true}));
}
