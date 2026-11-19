const FR_CANON_PORTRAIT_GALLERY_KEY = 'FR_CANON_PORTRAIT_GALLERY_ENABLED_V1';
const FR_CANON_GALLERY_EDITS_KEY = 'FR_CANON_PORTRAIT_GALLERY_EDITS_V1';
const frGalleryGenders = [['male','男角色'],['female','女角色']];
const frGalleryTiers = [['core','领衔人物'],['major','重要人物'],['minor','配角']];
const frGalleryUnclassified = ['unclassified','未分类'];
let frCanonGalleryEdits = null;

function frCanonGalleryPeople() {
  const people = new Map((window.__FR_CANON_PORTRAIT_GALLERY__ || [])
    .map(person => ['builtin:' + person.name, person]));
  for (const {key, person} of frCanonGalleryEdits || []) {
    if (person) people.set(key,person);
    else people.delete(key);
  }
  return Array.from(people,([key,person]) => ({...person,key}));
}

async function frLoadCanonGallery() {
  if (frCanonGalleryEdits === null) {
    const saved = await dbGet(FR_CANON_GALLERY_EDITS_KEY);
    frCanonGalleryEdits ??= Array.isArray(saved) ? saved : [];
  }
}

async function frWriteCanonGalleryEntry(key, person) {
  frCanonGalleryEdits = await db.transaction('rw',db.settings,async () => {
    const saved = await dbGet(FR_CANON_GALLERY_EDITS_KEY);
    const edits = Array.isArray(saved) ? saved.filter(entry => entry.key !== key) : [];
    if (person || key.startsWith('builtin:')) edits.push({key,person});
    await dbSet(FR_CANON_GALLERY_EDITS_KEY,edits);
    return edits;
  });
}

function frGalleryElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function frGalleryButton(text, className, onClick) {
  const button = frGalleryElement('button',className,text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function frGalleryCover(person) {
  return person.sets.find(set => set.portrait && set.design) ||
    person.sets.find(set => set.portrait || set.design) || person.sets[0];
}

function frGalleryImage(parent, src, alt, missing) {
  if (src) {
    const image = frGalleryElement('img');
    image.loading = 'lazy';
    image.alt = alt;
    image.src = src;
    parent.append(image);
    return;
  }
  const placeholder = frGalleryElement('div','fr-gallery-placeholder');
  const icon = frGalleryElement('i','far fa-image');
  icon.setAttribute('aria-hidden','true');
  placeholder.append(icon,frGalleryElement('span','',missing));
  parent.append(placeholder);
}

function frGalleryStagePeriod(set) {
  const dates = [set.from,set.to].filter(Boolean);
  return [...new Set(dates)].join(' — ');
}

async function frRefreshCanonGalleryViews() {
  const archiveName = currentArchiveName;
  if (!archiveName) return;
  await refreshSceneAvatarStrip();
  const detailId = document.getElementById('char-detail-avatar-container')?.dataset.frCharacterId;
  if (detailId) await updateNpcAvatarDisplay(detailId);
  await frRefreshDialogueAvatarImages(archiveName);
}

function frMountCanonGallery(pane, preferredKey) {
  if (pane._frGallery) {
    pane._frGallery.open(preferredKey);
    return;
  }
  const field = id => pane.querySelector('#fr-gallery-' + id);
  const search = field('search'), assets = field('assets'), toggle = field('auto');
  const index = field('index'), detail = field('detail'), status = field('status');
  const add = field('add'), dock = field('dock'), viewer = field('image-viewer');
  viewer.querySelector('button').onclick = () => viewer.close();
  viewer.onclose = () => viewer.querySelector('img').removeAttribute('src');
  const genderButtons = Array.from(pane.querySelectorAll('[data-gallery-gender]'));
  let gender = '', selected = '', stageId = '', draft = null, busy = false, pendingImages = 0;
  const newStage = () => ({id:crypto.randomUUID(),phase:'',from:'',to:'',realms:[],portrait:'',design:''});
  const readyCount = person => person.sets.filter(set => set.portrait && set.design).length;
  const people = () => frCanonGalleryPeople();
  const notify = message => { status.textContent = message; };
  const clearFilters = () => {
    search.value = assets.value = gender = '';
    for (const button of genderButtons) button.setAttribute('aria-pressed',String(button.dataset.galleryGender === gender));
  };
  const current = () => draft || people().find(person => person.key === selected);
  const focusDetail = () => detail.querySelector('h4')?.focus({preventScroll:true});

  function select(person, showDetail) {
    selected = person?.key || '';
    stageId = person ? frGalleryCover(person)?.id : '';
    if (showDetail) pane.classList.add('is-detail');
  }

  function renderIndex() {
    const all = people(), query = search.value.trim().toLowerCase();
    const filtered = all.filter(person =>
      (!gender || person.gender === gender) &&
      (!assets.value || (assets.value === 'ready' ? readyCount(person) > 0 : !person.sets.length || readyCount(person) < person.sets.length)) &&
      [person.name,...(person.aliases || []),...person.sets.map(set=>set.phase)].some(text=>text.toLowerCase().includes(query)));
    if (!draft && !filtered.some(person => person.key === selected)) select(filtered[0]);
    field('summary').textContent = all.length + ' 位人物 · ' + all.reduce((sum,person)=>sum+readyCount(person),0) + ' 套人物图';
    index.replaceChildren();
    if (!filtered.length) {
      index.append(frGalleryElement('p','fr-gallery-empty','没有符合条件的人物。'));
      return;
    }
    for (const [group,label] of [...frGalleryGenders,frGalleryUnclassified]) {
      const unclassified = group === frGalleryUnclassified[0];
      const members = filtered.filter(person => unclassified
        ? person.tier === group
        : person.gender === group && person.tier !== frGalleryUnclassified[0]);
      if (!members.length) continue;
      const groupTitle = frGalleryElement('h4','fr-gallery-group-label',label);
      index.append(groupTitle);
      for (const [tier,tierLabel] of unclassified ? [frGalleryUnclassified] : frGalleryTiers) {
        const roles = members.filter(person=>person.tier === tier);
        if (!roles.length) continue;
        if (!unclassified) index.append(frGalleryElement('h5','fr-gallery-tier-label',tierLabel));
        const grid = frGalleryElement('div','fr-gallery-grid');
        for (const person of roles) {
          const card = frGalleryButton('', 'fr-gallery-card', () => {
            if (draft || busy) return;
            select(person,true);
            notify('');
            index.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed','false');
            card.setAttribute('aria-pressed','true');
            renderDetail();
            focusDetail();
          });
          card.dataset.galleryPerson = person.key;
          card.setAttribute('aria-pressed',String(person.key === selected));
          if (draft) card.disabled = true;
          const cover = frGalleryElement('div','fr-gallery-card-art');
          const set = frGalleryCover(person);
          frGalleryImage(cover,set?.portrait || set?.design,'', '待补图');
          const caption = frGalleryElement('div','fr-gallery-card-caption');
          caption.append(frGalleryElement('strong','',person.name),
            frGalleryElement('small','',person.sets.length ? person.sets.length + ' 个阶段' : '待添加阶段'));
          card.append(cover,caption);
          grid.append(card);
        }
        index.append(grid);
      }
    }
  }

  function fieldControl(parent, label, value, update, choices) {
    const wrapper = frGalleryElement('div','fr-gallery-field');
    const caption = frGalleryElement('label','',label);
    const control = frGalleryElement(choices ? 'select' : 'input');
    control.id = 'fr-gallery-field-' + label.replace(/[\s/]+/gu,'-');
    caption.htmlFor = control.id;
    if (choices) for (const [key,text] of choices) control.append(new Option(text,key));
    control.value = value;
    control.oninput = () => update(control.value);
    wrapper.append(caption,control);
    parent.append(wrapper);
    return control;
  }

  function renderArt(host, person, set) {
    const art = frGalleryElement('div','fr-gallery-art');
    for (const [kind,label] of [['portrait','主肖像'],['design','设定图']]) {
      const figure = frGalleryElement('figure','fr-gallery-plate');
      const caption = person.name + ' · ' + label;
      const zoom = !draft && !!set[kind];
      const media = zoom ? frGalleryButton('','fr-gallery-plate-media fr-gallery-zoom',() => {
        field('image-title').textContent = caption;
        const image = viewer.querySelector('img');
        image.alt = caption;
        image.src = set[kind];
        viewer.showModal();
      }) : frGalleryElement('div','fr-gallery-plate-media');
      if (zoom) media.setAttribute('aria-label','查看' + caption + '原图');
      frGalleryImage(media,set[kind],caption,'缺' + label);
      const footer = frGalleryElement('figcaption','fr-gallery-plate-footer');
      footer.append(frGalleryElement('strong','',label));
      if (draft) {
        const actions = frGalleryElement('div','fr-gallery-art-actions');
        const upload = frGalleryElement('label','small-btn fr-image-file',set[kind] ? '换图' : '上传');
        const input = frGalleryElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.setAttribute('aria-label','上传' + label);
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const edit = draft;
          pendingImages++;
          updateSaveState();
          try {
            const src = await frReadPortraitUpload(file);
            if (draft !== edit || !edit.sets.includes(set)) return;
            set[kind] = src;
            notify(label + '已选，保存后生效。');
            renderDetail();
          } catch (error) { if (draft === edit) notify(error.message); }
          finally { pendingImages--; updateSaveState(); }
        };
        upload.append(input);
        actions.append(upload);
        if (set[kind]) actions.append(frGalleryButton('移除' + label,'small-btn fr-gallery-quiet',() => {
          set[kind] = '';
          renderDetail();
        }));
        footer.append(actions);
      }
      figure.append(media,footer);
      art.append(figure);
    }
    host.append(art);
  }

  function updateSaveState() {
    const save = dock.querySelector('[data-gallery-save]');
    if (save) save.disabled = busy || pendingImages > 0;
  }

  function renderStages(host, person) {
    const sets = person.sets;
    const set = sets.find(row=>row.id === stageId) || sets[0];
    stageId = set?.id || '';
    const navigation = frGalleryElement('div','fr-gallery-stage-nav');
    navigation.setAttribute('aria-label','人物阶段');
    for (const row of sets) {
      const button = frGalleryButton(row.phase || '新阶段','fr-gallery-stage-button',() => {
        stageId = row.id;
        renderDetail();
        detail.querySelector('[data-gallery-stage][aria-pressed="true"]')?.focus({preventScroll:true});
      });
      button.dataset.galleryStage = row.id;
      button.setAttribute('aria-pressed',String(row.id === stageId));
      navigation.append(button);
    }
    if (draft) navigation.append(frGalleryButton('＋ 新增阶段','fr-gallery-stage-button fr-gallery-stage-add',() => {
      const row = newStage();
      draft.sets.push(row);
      stageId = row.id;
      renderDetail();
      detail.querySelector('[name="gallery-phase"]')?.focus();
    }));
    if (navigation.childElementCount) host.append(navigation);
    if (!set) {
      host.append(frGalleryElement('p','fr-gallery-empty','这个人物还没有阶段套图。'));
      return;
    }
    if (draft) {
      const fields = frGalleryElement('div','fr-gallery-stage-fields');
      const phase = fieldControl(fields,'阶段名称',set.phase,value => {
        set.phase = value;
        const selectedButton = navigation.querySelector('[aria-pressed="true"]');
        selectedButton.textContent = value || '新阶段';
      });
      phase.name = 'gallery-phase';
      fieldControl(fields,'匹配境界',set.realms.join('、'),value => { set.realms = value.split(/[,，、]/u).map(v=>v.trim()).filter(Boolean); })
        .placeholder = '例：炼气、筑基初期';
      fieldControl(fields,'开始日期',set.from,value => { set.from = value; }).placeholder = '例：0020.08.10';
      fieldControl(fields,'结束日期',set.to,value => { set.to = value; }).placeholder = '例：0032.12.22';
      host.append(fields);
    } else {
      const labels = [frGalleryStagePeriod(set),set.realms.join('、')].filter(Boolean);
      if (labels.length) host.append(frGalleryElement('p','fr-gallery-stage-period',labels.join(' · ')));
    }
    renderArt(host,person,set);
    if (draft) {
      const actions = frGalleryElement('div','fr-gallery-stage-actions');
      actions.append(frGalleryButton('删除此阶段','small-btn fr-gallery-danger',() => {
        draft.sets = draft.sets.filter(row=>row.id !== set.id);
        renderDetail();
      }));
      host.append(actions);
    }
  }

  function renderDetail() {
    const person = current();
    detail.replaceChildren();
    dock.replaceChildren();
    dock.hidden = !draft;
    const back = frGalleryButton('‹ 人物目录','small-btn fr-gallery-back',() => {
      if (draft) return;
      pane.classList.remove('is-detail');
      index.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
    });
    if (!draft) detail.append(back);
    if (!person) {
      detail.append(frGalleryElement('p','fr-gallery-empty','选择人物查看阶段套图。'));
      return;
    }
    const heading = frGalleryElement('header','fr-gallery-person-heading');
    const identity = frGalleryElement('div','fr-gallery-person-identity');
    const title = frGalleryElement('h4','',draft ? (selected ? '编辑人物' : '新增人物') : person.name);
    title.tabIndex = -1;
    identity.append(title);
    if (!draft && person.aliases?.length) identity.append(frGalleryElement('p','',person.aliases.join(' · ')));
    heading.append(identity);
    if (!draft) heading.append(frGalleryButton('编辑人物','small-btn',() => {
      draft = structuredClone(person);
      render();
      detail.querySelector('[name="gallery-person-name"]')?.focus();
    }));
    detail.append(heading);
    if (draft) {
      const identityFields = frGalleryElement('div','fr-gallery-stage-fields');
      const name = fieldControl(identityFields,'姓名',person.name,value => { person.name = value; });
      name.name = 'gallery-person-name';
      fieldControl(identityFields,'别名 / 原著匹配名',(person.aliases || []).join('、'),value => {
        person.aliases = value.split(/[,，、]/u).map(v=>v.trim()).filter(Boolean);
      }).placeholder = '多个名字用顿号分隔';
      fieldControl(identityFields,'性别',person.gender,value => { person.gender = value; },frGalleryGenders);
      fieldControl(identityFields,'原著重要性',person.tier,value => { person.tier = value; },[...frGalleryTiers,frGalleryUnclassified]);
      detail.append(identityFields);
    }
    renderStages(detail,person);
    if (draft) {
      const footer = frGalleryElement('footer','fr-gallery-editor-footer');
      if (selected) footer.append(frGalleryButton('删除人物','small-btn fr-gallery-danger',deletePerson));
      const buttons = frGalleryElement('div','fr-gallery-art-actions');
      buttons.append(frGalleryButton('取消','small-btn',() => {
        if (busy) return;
        draft = null;
        notify('');
        render();
        focusDetail();
      }));
      const save = frGalleryButton('保存人物','primary-btn',savePerson);
      save.dataset.gallerySave = '';
      buttons.append(save);
      footer.append(buttons);
      dock.append(footer);
      updateSaveState();
    }
  }

  function render() {
    for (const control of [add,search,assets,...genderButtons]) control.disabled = !!draft || busy;
    renderIndex();
    renderDetail();
  }

  async function savePerson() {
    if (busy || pendingImages || !draft) return;
    const {key:ignored,...record} = structuredClone(draft);
    record.name = record.name.trim();
    if (!record.name) {
      notify('请填写人物姓名。');
      detail.querySelector('[name="gallery-person-name"]')?.focus();
      return;
    }
    record.aliases = [...new Set((record.aliases||[]).filter(name=>name!==record.name))];
    record.sets = record.sets.map(set => ({...set,phase:set.phase.trim() || '未命名阶段',from:set.from.trim(),to:set.to.trim()}));
    const key = selected || 'custom:' + crypto.randomUUID();
    busy = true;
    updateSaveState();
    try {
      await frWriteCanonGalleryEntry(key,record);
      selected = key;
      draft = null;
      clearFilters();
      notify('已保存 ' + record.name + '。');
      await frRefreshCanonGalleryViews().catch(error=>console.warn('[原著人物图库]',error.message));
    } catch (error) { notify('保存失败 · ' + error.message); }
    finally { busy = false; render(); focusDetail(); }
  }

  async function deletePerson() {
    if (busy || !selected) return;
    const person = people().find(row=>row.key===selected);
    if (!person || !await _portraitConfirm('删除「' + person.name + '」及其所有图库阶段？')) return;
    busy = true;
    try {
      await frWriteCanonGalleryEntry(person.key,null);
      draft = null;
      select(null);
      notify('已删除 ' + person.name + '。');
      await frRefreshCanonGalleryViews().catch(error=>console.warn('[原著人物图库]',error.message));
    } catch (error) { notify('删除失败 · ' + error.message); }
    finally { busy = false; render(); focusDetail(); }
  }

  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      localStorage.setItem(FR_CANON_PORTRAIT_GALLERY_KEY,toggle.checked ? '1' : '0');
      await frRefreshCanonGalleryViews();
    } catch (error) { notify(error.message); }
    finally { toggle.disabled = false; }
  };
  search.oninput = assets.onchange = () => { renderIndex(); renderDetail(); };
  for (const button of genderButtons) button.onclick = () => {
    gender = button.dataset.galleryGender;
    for (const sibling of genderButtons) sibling.setAttribute('aria-pressed',String(sibling===button));
    renderIndex();
    renderDetail();
  };
  add.onclick = () => {
    selected = '';
    const set = newStage();
    draft = {name:'',gender:gender || 'male',tier:'minor',aliases:[],sets:[set]};
    stageId = set.id;
    pane.classList.add('is-detail');
    notify('');
    render();
    detail.querySelector('[name="gallery-person-name"]')?.focus();
  };
  pane._frGallery = {open(key) {
    toggle.checked = localStorage.getItem(FR_CANON_PORTRAIT_GALLERY_KEY) === '1';
    if (key && !draft) {
      clearFilters();
      select(people().find(person=>person.key===key),true);
    }
    render();
  }};
  pane._frGallery.open(preferredKey);
}
