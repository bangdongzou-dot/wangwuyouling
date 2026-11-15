(function (host) {
  'use strict';
  const key = 'FR_NUMERIC_RULES_V1';
  const core = () => CE_CORE['numeric-rule-library'];
  const pack = rules => ({kind:'numeric-rules',version:1,rules});
  function list() {
    const defaults = core().numericRuleDefaults();
    try {
      const saved = localStorage.getItem(key);
      const rules = saved ? core().mergeNumericRules(defaults,core().readNumericRulePack(JSON.parse(saved)).map(core().upgradeNumericRule)) : defaults;
      core().configureNumericRules(rules);
      return rules;
    } catch {
      core().configureNumericRules(defaults);
      return defaults;
    }
  }
  function save(rules) {
    const clean = core().readNumericRulePack(pack(rules));
    core().configureNumericRules(clean);
    const defaults = new Map(core().numericRuleDefaults().map(rule => [rule.id,rule]));
    const edits = clean.filter(rule => {
      const original = defaults.get(rule.id);
      return !original || original.name !== rule.name || original.content !== rule.content;
    });
    if (edits.length) localStorage.setItem(key,JSON.stringify(pack(edits)));
    else localStorage.removeItem(key);
  }
  const reference = id => '${numeric_rule:' + id + '}';
  const formatValue = value => value.replace(/(?<![\d.,])\d{4,}(?![\d.,])/gu,
    digits => digits.replace(/\B(?=(\d{3})+(?!\d))/gu,','));

  function readOverview(rule) {
    const tables = [];
    const notes = [];
    const lineNumbers = new Map();
    let rows = [];
    function finishTable() {
      if (rows.length > 1) tables.push(rows);
      else if (rows.length) notes.push(rows[0].join(' | '));
      rows = [];
    }
    for (const [lineNumber,line] of rule.content.split(/\r?\n/u).entries()) {
      const cells = line.trim().replace(/^\||\|$/gu,'').split('|').map(cell => cell.trim());
      if (cells.length < 2) {
        finishTable();
        notes.push(line);
      } else if (!cells.every(cell => /^:?-{3,}:?$/u.test(cell))) {
        if (rows.length && cells.length !== rows[0].length) finishTable();
        rows.push(cells);
        lineNumbers.set(cells,lineNumber);
      }
    }
    finishTable();
    let text = notes.join('\n').trim();
    if (rule.id === 'technique-speed') {
      const grades = /([黄玄地天仙道]阶)\s*[：:]?\s*([+＋-]?\d+(?:\.\d+)?[%％](?:\s*[/／]\s*[+＋-]?\d+(?:\.\d+)?[%％]){3})(?!\s*[/／])/gu;
      const matrix = [...text.matchAll(grades)];
      if (matrix.length) {
        tables.unshift([['功法品阶','下品','中品','上品','极品'], ...matrix.map(match => [
          match[1], ...match[2].split(/\s*[/／]\s*/u),
        ])]);
        text = text.replace(grades,'').replace(/(?:[；;]\s*){2,}/gu,'').replace(/：\s*[。；]/gu,'。');
      }
    }
    return { tables, text, lineNumbers };
  }

  const noteHeadings = [
    [/^这是本轮容器体系/u, '适用范围'],
    [/^第11列只写白值/u, '白值与最终值'],
    [/^表内基准是/u, '区间边界', 'boundary'],
    [/^新建人物/u, '人物白值怎么定'],
    [/^血量\/法力保存/u, '血量与法力怎么记', 'example'],
    [/^只在真实新建/u, '旧档与数值更新', 'boundary'],
    [/^一级妖兽/u, '妖兽境界对应'],
    [/^本地把最终当前值/u, '属性标签怎么看'],
    [/^低于凡人下界/u, '特殊数值', 'boundary'],
    [/^境界区间分别乘/u, '换算方法'],
    [/^这三项使用/u, '独立参考区间'],
    [/^五行灵根的基础属性/u, '五行灵根'],
    [/^异灵根又称/u, '异灵根'],
    [/^游戏白值/u, '游戏内默认白值'],
    [/^万物有灵 · 混沌灵根/u, '混沌灵根'],
    [/^所有功法必有/u, '功法加成如何生效'],
    [/^修炼速度是/u, '修速白值的含义'],
    [/^新建与真正缺失/u, '白值如何初始化'],
    [/^已有合法修炼速度/u, '旧值与永久变化', 'boundary'],
    [/^混沌仙胎的修速来源/u, '混沌仙胎算例', 'example'],
    [/^已确认选择混沌仙胎/u, '突破例外', 'boundary'],
    [/^正文与变量优先/u, '何时计算进度', 'boundary'],
    [/^每日进度点/u, '每日进度公式', 'example'],
    [/^普通新增进度/u, '实际修炼如何结算', 'example'],
    [/^沿用本地原生add/u, '进度与突破边界', 'boundary'],
    [/^游戏没有settleNpcCultivation/u, '本地结算范围'],
    [/^传导读取/u, '神识门槛与传导', 'boundary'],
    [/^混沌之宝的单件硬锁/u, '混沌之宝'],
    [/^单件只提供/u, '单件上限', 'boundary'],
  ];
  const noteHighlights = /(下1\/3偏弱|中1\/3正常|上1\/3超常|区间左闭右开|渡劫上界\d+可取|恰在分界归更高一档|0\/160加法力40得到40\/200|临时Buff仅改当前|化神(?:期)?前无突破瓶颈|实际修炼天数|启动前不传导|启动后按七成|达到完整门槛后按全部传导)/gu;

  function renderNotes(text) {
    const prose = document.createElement('div');
    prose.className = 'fr-numeric-guide';
    let section;
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line) { section = null; continue; }
      if (/^【.+\s[a-z][\w-]*-v\d+】$/u.test(line)) {
        const version = document.createElement('small');
        version.className = 'fr-numeric-guide-version';
        version.textContent = line.slice(1,-1);
        prose.append(version);
        continue;
      }
      const heading = line.match(/^#{1,6}\s+(.+)$|^【([^】]+)】$/u);
      const known = noteHeadings.find(([prefix]) => prefix.test(line));
      if (!section || heading || known) {
        section = document.createElement('section');
        section.className = 'fr-numeric-guide-section';
        if (known?.[2]) section.dataset.kind = known[2];
        const title = heading?.[1] || heading?.[2] || known?.[1];
        if (title) {
          const label = document.createElement('h4');
          label.textContent = title;
          if (known?.[2]) {
            const tag = document.createElement('span');
            tag.className = 'fr-numeric-guide-tag';
            tag.textContent = known[2] === 'example' ? '计算' : '注意';
            label.append(tag);
          }
          section.append(label);
        }
        prose.append(section);
      }
      if (heading) continue;
      const paragraph = document.createElement('p');
      for (const [index,part] of line.split(noteHighlights).entries()) {
        if (index % 2) {
          const emphasis = document.createElement('strong');
          emphasis.textContent = part;
          paragraph.append(emphasis);
        } else paragraph.append(part);
      }
      section.append(paragraph);
    }
    return prose;
  }

  function open() {
    if (document.getElementById('fr-numeric-dialog')?.open) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'fr-numeric-dialog';
    dialog.setAttribute('aria-labelledby','fr-numeric-title');
    dialog.innerHTML = `
      <header class="fr-numeric-header">
        <h2 id="fr-numeric-title">数值规则设定</h2>
        <button type="button" data-close aria-label="关闭数值规则设定">×</button>
      </header>
      <div class="fr-numeric-body">
        <aside>
          <nav aria-label="数值规则" data-list></nav>
          <div class="fr-numeric-tools">
            <button type="button" data-import>导入</button>
            <button type="button" data-export>导出</button>
            <input type="file" data-file accept=".json,.txt,.md" hidden>
          </div>
        </aside>
        <section class="fr-numeric-main" aria-labelledby="fr-numeric-rule-name">
          <div class="fr-numeric-heading">
            <h3 id="fr-numeric-rule-name" tabindex="-1"></h3>
            <div class="fr-numeric-actions">
              <button type="button" data-copy>复制占位符</button>
              <button type="button" data-edit>编辑模式</button>
            </div>
            <input aria-label="规则占位符" data-reference readonly hidden>
          </div>
          <div data-overview></div>
          <form hidden>
            <details class="fr-numeric-notes">
              <summary>规则正文</summary>
              <label>规则正文<textarea name="content" required spellcheck="false"></textarea></label>
            </details>
            <div class="fr-numeric-actions">
              <button type="submit">保存</button>
              <button type="button" data-cancel>取消</button>
              <button type="button" data-reset hidden>恢复内置</button>
            </div>
          </form>
          <span role="status"></span>
        </section>
      </div>`;
    const find = selector => dialog.querySelector(selector);
    const form = find('form');
    const content = form.elements.namedItem('content');
    const message = find('[role=status]');
    const drafts = new Map();
    let selected = '';
    let selectedRealm = '';
    const status = text => { message.textContent = text; };
    function renderOverview(rule, editing=false) {
      const overview = find('[data-overview]');
      overview.replaceChildren();
      const { tables, text, lineNumbers } = readOverview(rule);
      if(rule.id==='attribute-baseline'&&!editing){
        const numeric=CE_CORE['numeric-realms'];
        const label=document.createElement('label');
        label.className='fr-numeric-realm-picker';
        label.textContent='选择境界';
        const picker=document.createElement('select');
        for(const {realm} of numeric.NUMERIC_REALM_ROWS)picker.append(new Option(realm,realm));
        if(!selectedRealm){
          const player=typeof currentState==='object'&&currentState?.['0'];
          const row=player?.B1||Object.values(player||{}).find(row=>row?.['0']==='B1');
          selectedRealm=numeric.resolveNumericRealm(row?.['2'])||'炼气五层';
        }
        picker.value=selectedRealm;
        picker.onchange=()=>{selectedRealm=picker.value;renderOverview(rule);};
        label.append(picker);
        const hint=document.createElement('p');
        hint.className='fr-numeric-realm-note';
        hint.textContent='以下为无装备、功法与临时加成的白值区间。境界上界归入下一档，渡劫末端含上界。';
        overview.append(label,hint);
        const ranges=numeric.numericRealmRanges(selectedRealm);
        tables.splice(0,tables.length,[['属性','下限','上限','取值规则'],...ranges.map(row=>[
          row.attribute,String(row.min),String(row.max),
          row.attribute==='修炼速度'?'常规参考，实际白值按灵根':row.scalar?'独立参考区间':row.upperInclusive?'含上限':'不含上限',
        ])]);
      }
      for (const [headers,...rows] of tables) {
        const wrap = document.createElement('div');
        wrap.className = 'fr-numeric-table-wrap';
        const table = document.createElement('table');
        table.setAttribute('aria-label',rule.name);
        table.dataset.rule = rule.id;
        if (rule.id === 'attribute-baseline' && !editing) table.classList.add('fr-numeric-realm-table');
        const heading = table.createTHead().insertRow();
        for (const title of headers) {
          const cell = document.createElement('th');
          cell.scope = 'col';
          cell.textContent = title === '基准上界（不含，渡劫末端含）' ? '基准上界' : title;
          if (cell.textContent !== title) cell.title = title;
          heading.append(cell);
        }
        const body = table.createTBody();
        for (const [index,cells] of rows.entries()) {
          const [label,...values]=cells;
          const row = body.insertRow();
          const cell = document.createElement('th');
          cell.scope = 'row';
          cell.textContent = label;
          row.append(cell);
          for (const [column,value] of values.entries()) {
            const cell=row.insertCell(), lineNumber=lineNumbers.get(cells);
            if (!editing||lineNumber===undefined||(rule.id==='root-speed'&&!/^\d+(?:\.\d+)?$/u.test(value))) {cell.textContent=formatValue(value);continue;}
            const input=document.createElement('input');
            input.value=value;
            input.dataset.line=lineNumber;
            input.dataset.column=column;
            input.inputMode=/^\d+(?:\.\d+)?$/u.test(value)?'decimal':'text';
            input.setAttribute('aria-label',label+' · '+headers[column+1]);
            input.addEventListener('input',()=>{
              const lines=content.value.split(/\r?\n/u);
              const write=(line,position,value)=>{
                const columns=lines[line].trim().replace(/^\||\|$/gu,'').split('|').map(part=>part.trim());
                columns[position+1]=value;
                lines[line]=columns.join(' | ');
              };
              write(lineNumber,column,input.value);
              if(rule.id==='attribute-baseline'){
                const neighbor=lineNumbers.get(rows[index+(column===0?-1:1)]);
                if(neighbor!==undefined){
                  write(neighbor,1-column,input.value);
                  const paired=overview.querySelector(`input[data-line="${neighbor}"][data-column="${1-column}"]`);
                  if(paired)paired.value=input.value;
                }
              }
              content.value=lines.join('\n');
            });
            cell.append(input);
          }
        }
        wrap.append(table);
        overview.append(wrap);
      }
      if (!text) return;
      const notes = document.createElement(tables.length ? 'details' : 'div');
      notes.className = 'fr-numeric-notes';
      if (tables.length) {
        const summary = document.createElement('summary');
        summary.textContent = '规则说明';
        notes.append(summary);
        if(rule.id==='root-speed')notes.open=true;
      }
      notes.append(renderNotes(text));
      overview.append(notes);
    }
    function setEditing(editing) {
      form.hidden = !editing;
      find('[data-edit]').hidden = editing;
      const rule=list().find(row=>row.id===selected);
      if(rule)renderOverview(editing?{...rule,content:content.value}:rule,editing);
      if (editing) (find('[data-overview] input')||find('form summary'))?.focus();
    }
    function select(id) {
      if (selected && !form.hidden) drafts.set(selected,{content:content.value});
      selected = id;
      const rules = list();
      const saved = rules.find(rule => rule.id === id);
      const selectedRule = drafts.get(id) || saved;
      const nav = find('[data-list]');
      nav.replaceChildren();
      const entries = core().numericRuleDefaults();
      for (const rule of entries) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = rule.name;
        button.setAttribute('aria-pressed',String(rule.id === selected));
        button.onclick = () => { status(''); select(rule.id); };
        nav.append(button);
      }
      content.value = selectedRule?.content || '';
      find('#fr-numeric-rule-name').textContent = entries.find(rule=>rule.id===id)?.name || saved?.name;
      find('[data-reference]').value = reference(id);
      find('[data-reset]').hidden = !core().numericRuleDefaults().some(rule => rule.id === id);
      setEditing(drafts.has(id));
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const current=list().find(rule=>rule.id===selected);
        save(core().mergeNumericRules(list(),[{...current,content:content.value}]));
        drafts.delete(selected);
        setEditing(false);
        select(selected);
        status('已保存');
        find('[data-edit]').focus();
      } catch (error) { status('保存失败 · ' + error.message); }
    });
    find('[data-close]').onclick = () => dialog.close();
    find('[data-edit]').onclick = () => { status(''); setEditing(true); };
    find('[data-cancel]').onclick = () => {
      drafts.delete(selected);
      setEditing(false);
      select(list().some(rule => rule.id === selected) ? selected : list()[0].id);
      find('[data-edit]').focus();
    };
    content.addEventListener('change',()=>{
      const rule=list().find(row=>row.id===selected);
      if(rule&&!form.hidden)renderOverview({...rule,content:content.value},true);
    });
    find('[data-copy]').onclick = async () => {
      const field = find('[data-reference]');
      try {
        if (!navigator.clipboard?.writeText) throw new Error();
        await navigator.clipboard.writeText(field.value);
        field.hidden = true;
        status('占位符已复制');
      } catch {
        field.hidden = false;
        field.select();
        status(document.execCommand('copy') ? '占位符已复制' : '按 Ctrl+C 复制');
      }
    };
    find('[data-reset]').onclick = () => {
      const original = core().numericRuleDefaults().find(rule => rule.id === selected);
      if (!original) return;
      content.value = original.content;
      renderOverview(original,true);
      status('已载入内置正文，保存后生效');
    };
    const input = find('[data-file]');
    find('[data-import]').onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      input.value = '';
      const target = selected;
      try {
        const text = await file.text();
        if (/\.json$/iu.test(file.name)) {
          const known=new Set(core().numericRuleDefaults().map(rule=>rule.id));
          const imported = core().readNumericRulePack(JSON.parse(text)).map(core().upgradeNumericRule).filter(rule=>known.has(rule.id));
          if(!imported.length)throw new Error('规则包没有匹配的内置占位符');
          save(core().mergeNumericRules(list(),imported));
          for (const rule of imported) drafts.delete(rule.id);
          if (!form.hidden && !imported.some(rule => rule.id === selected)) {
            drafts.set(selected,{content:content.value});
          }
          selected = '';
          select(target);
          status('已导入 ' + imported.length + ' 条规则');
        } else if (target === selected) {
          content.value = text;
          setEditing(true);
          status('已载入正文，保存后生效');
        } else {
          drafts.set(target,{...drafts.get(target),content:text});
        }
      } catch (error) { status('导入失败 · ' + error.message); }
    };
    find('[data-export]').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(pack(list()),null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = '数值规则.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    dialog.addEventListener('close',() => dialog.remove(),{once:true});
    document.body.append(dialog);
    select(list()[0].id);
    dialog.showModal();
    find('#fr-numeric-rule-name').focus({preventScroll:true});
  }
  host.FrNumericRules = Object.freeze({
    open, list,
    expand(template,project) { return core().expandNumericRuleReferences(template,list(),project); },
  });
  list();
  document.addEventListener('click', event => {
    if (event.target.closest?.('#open-numeric-rule-settings-btn')) open();
  });
})(window);
