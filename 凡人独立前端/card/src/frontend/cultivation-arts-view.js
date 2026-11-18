(function () {
  const display = value => (globalThis.CE_CORE?.['numeric-display']?.formatDisplayNumber(value) ?? String(value));
  const seals = {
    talisman: '符', formation: '阵', alchemy: '丹', artifact: '器',
    puppet: '傀', beastTaming: '兽', cooking: '膳', planting: '植',
  };
  const assistanceLabels = {
    practice: '练习效率', success: '成功率', quality: '品质倾向', speed: '制作速度',
  };

  function render(container, entries) {
    if (!container) return;
    const doc = container.ownerDocument;
    const node = (parent, tag, className, value) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      parent.append(element);
      return element;
    };
    container.replaceChildren();
    const confirmed = entries.filter(art => art.status === 'known').length;
    const overview = node(container, 'div', 'fr-arts-overview');
    node(overview, 'strong', '', '已确认 ' + confirmed + ' / ' + entries.length + ' 项');
    node(overview, 'span', '', confirmed ? '进度按当前档位显示' : '暂无熟练度记录');
    const grid = node(container, 'div', 'fr-arts-grid');
    for (const art of entries) {
      const known = art.status === 'known';
      const card = node(grid, 'article', 'fr-art-card');
      card.dataset.art = art.key;
      card.dataset.status = art.status;
      const heading = node(card, 'header', 'fr-art-heading');
      const seal = node(heading, 'span', 'fr-art-seal', seals[art.key] || art.name[0]);
      seal.setAttribute('aria-hidden', 'true');
      node(heading, 'strong', 'fr-art-name', art.name);
      node(heading, 'span', 'fr-art-status', known ? art.tier : art.status === 'invalid' ? '待核对' : '待确认');
      node(card, 'p', 'fr-art-description', art.description);
      if (known) {
        const progress = node(card, 'div', 'fr-art-progress');
        const meter = node(progress, 'progress', 'fr-art-track');
        meter.max = 100;
        meter.value = art.progress;
        meter.setAttribute('aria-label', art.name + '当前档内进度');
        node(progress, 'strong', '', display(art.progress) + '%');
      }
      const assistance = art.assistance;
      const hasAssistance = Boolean(assistance?.sources?.length);
      if (hasAssistance) {
        const modifiers = node(card, 'div', 'fr-art-modifiers');
        modifiers.setAttribute('aria-label', '功法辅助');
        for (const [key, label] of Object.entries(assistanceLabels)) {
          const value = assistance[key];
          if (value) node(modifiers, 'span', '', label + ' ' + (value > 0 ? '+' : '') + display(value) + (key === 'success' ? ' 个百分点' : '%'));
        }
      }
      if (art.basis || art.legacy || hasAssistance) {
        const details = node(card, 'details', 'fr-art-notes');
        node(details, 'summary', '', hasAssistance ? (art.basis || art.legacy ? '依据与功法来源' : '功法来源') : '熟练度依据');
        if (art.basis || art.legacy) node(details, 'p', '', art.basis || '旧记录缺少依据');
        if (hasAssistance) node(details, 'p', '', assistance.sources.map(source => source.name).join('、'));
      }
    }
  }

  globalThis.FrCultivationArtsView = { render };
})();
