/**
 * equipment-layout.js
 *
 * 装备命名槽位的**纯数据合同**。无副作用、无 DOM、无 IO、无 import。
 *
 * 权威定义：槽位数量与名称只在此模块里定义一次（1 / 4 / 4 / 6）。
 * 任何调用点都不得再各自硬写数字，也不得在本模块之外另存一份拷贝。
 *
 * ── 三件事，各自单一职责 ──────────────────────────────────────────
 *   getEquipmentSlots(slotKey)            → 该组的槽位定义（权威数量与名称）
 *   allowedEquipmentIndices(slotKey, item) → 这件物品允许落在哪些 index
 *   normalizeEquipmentLayout(raw, opts)   → 把任意历史形态投影成 1/4/4/6 + 溢出口
 *
 * ── 一条边界 ────────────────────────────────────────────────────
 *   本模块**不碰背包**。溢出的物品只以 overflow 记录交还调用方，
 *   由调用方自己返还到所属者的物品容器（背包是业务，不是布局）。
 *
 * ── 另一条边界 ──────────────────────────────────────────────────
 *   本模块不读、不写任何数值加成/白值/传导率。布局只管"东西放哪格"，
 *   数值公式（container-equipment 的白值与传导）完全不受影响。
 */

/* 四组槽位键。顺序与数据表列一致（weapon/armor/technique/treasure）。 */
const SLOT_KEYS = ['weapon', 'armor', 'technique', 'treasure']

/**
 * 权威槽位表。**数量只在这里定义**，其他任何地方不得重复硬写。
 * role: primary = 主位（武器 / 本命法宝），normal = 普通位。
 */
const SLOT_TABLE = {
  weapon: [
    { index: 0, label: '武器', role: 'primary' }
  ],
  armor: [
    { index: 0, label: '头部', role: 'normal' },
    { index: 1, label: '身体', role: 'normal' },
    { index: 2, label: '腿部', role: 'normal' },
    { index: 3, label: '饰品', role: 'normal' }
  ],
  technique: [
    { index: 0, label: '主修', role: 'normal' },
    { index: 1, label: '炼体', role: 'normal' },
    { index: 2, label: '神识', role: 'normal' },
    { index: 3, label: '百艺', role: 'normal' }
  ],
  treasure: [
    { index: 0, label: '本命法宝', role: 'primary' },
    { index: 1, label: '普通法宝1', role: 'normal' },
    { index: 2, label: '普通法宝2', role: 'normal' },
    { index: 3, label: '普通法宝3', role: 'normal' },
    { index: 4, label: '普通法宝4', role: 'normal' },
    { index: 5, label: '普通法宝5', role: 'normal' }
  ]
}

/* 部位/类别关键词表。仅供"明确部位信息"匹配，命中不到就走默认位。 */
const ARMOR_PART_WORDS = {
  /* 腿先判：避免「护腿」被「护」误判成身体、「战靴」被「战」误判 */
  2: ['腿部', '腿', '靴', '鞋', '履', '足', '裤', '胫', '膝'],
  0: ['头部', '头盔', '头', '冠', '盔', '巾', '帽', '额', '面具', '面罩', '发簪', '面具'],
  3: ['饰品', '饰', '环', '佩', '戒', '镯', '链', '坠', '带', '腰', '珠', '玉', '簪', '镜'],
  1: ['身体', '身', '衣', '袍', '甲', '铠', '衫', '服', '护心', '背心', '胸', '胴']
}
/* equipmentRole 允许的显式值（中英）。命中不到视为"无明确部位"。 */
const ARMOR_ROLE_MAP = {
  头部: 0, 头: 0, head: 0, helmet: 0,
  身体: 1, 身: 1, body: 1, chest: 1, torso: 1, armor: 1, cloak: 1, inner: 1, underwear: 1,
  腿部: 2, 腿: 2, leg: 2, legs: 2, feet: 2, foot: 2, boots: 2,
  饰品: 3, 饰: 3, accessory: 3, trinket: 3, ring: 3, jewelry: 3
}

const TECHNIQUE_CATEGORY_WORDS = {
  1: ['炼体', '炼体术', '体修', '淬体', '锻体', '肉身'],
  2: ['神识', '神念', '识海', '魂修', '养魂'],
  3: ['炼丹', '炼器', '制符', '阵法', '符箓', '阵道', '器道', '丹道', '百艺', '傀儡', '炼香']
}
/* equipmentRole 对功法的显式值 */
const TECHNIQUE_ROLE_MAP = {
  主修: 0, 炼体: 1, 神识: 2, 百艺: 3,
  main: 0, spell: 0, weapon: 0, movement: 0, body: 1, spirit: 2, shenshi: 2, art: 3, craft: 3
}

function assertSlotKey (slotKey) {
  if (typeof slotKey !== 'string' || !Object.prototype.hasOwnProperty.call(SLOT_TABLE, slotKey)) {
    throw new Error('未知的装备槽位键：' + String(slotKey) + '（合法值：' + SLOT_KEYS.join('/') + '）')
  }
}

/**
 * 该组槽位的权威定义。每次调用返回**全新数组与全新对象**，
 * 调用方改坏了也不会污染下一次。
 * @param {'weapon'|'armor'|'technique'|'treasure'} slotKey
 * @returns {Array<{index:number,label:string,role:'primary'|'normal'}>}
 */
export function getEquipmentSlots (slotKey) {
  assertSlotKey(slotKey)
  /* 逐项重建：不把内部常量表泄漏出去。 */
  return SLOT_TABLE[slotKey].map((slot) => ({ index: slot.index, label: slot.label, role: slot.role }))
}

/** 取物品名字：兼容数据表列号 item['1'] 与归一化后的 item.name。 */
function itemName (item) {
  if (!item || typeof item !== 'object') return ''
  const v = item['1'] != null && item['1'] !== '' ? item['1'] : item.name
  return v == null ? '' : String(v)
}

/** 取物品类型：兼容 item['2'] 与 item.type。 */
function itemType (item) {
  if (!item || typeof item !== 'object') return ''
  const v = item['2'] != null && item['2'] !== '' ? item['2'] : item.type || item.category
  return v == null ? '' : String(v).trim()
}

/** 物品可参与部位/类别判定的全部文本（名字 + 类型 + equipmentRole）。 */
function itemTexts (item) {
  if (!item || typeof item !== 'object') return []
  const texts = [itemName(item), itemType(item)]
  const role = item.equipmentRole != null ? item.equipmentRole : item.role
  if (role != null && role !== '') texts.push(String(role))
  return texts.filter((t) => t && t.trim())
}

/** 在文本里找关键词，返回命中的类别 index 或 null。 */
function matchWords (texts, wordTable) {
  for (const text of texts) {
    let best = null, length = 0
    for (const key of wordTable === ARMOR_PART_WORDS ? ['0', '2', '3', '1'] : Object.keys(wordTable)) {
      for (const word of wordTable[key]) {
        if (text.indexOf(word) >= 0 && word.length > length) { best = Number(key); length = word.length }
      }
    }
    if (best !== null) return best
  }
  return null
}

/** 取被当作"显式部位/类别"的 role 值（不是名字里的文字）。 */
function explicitRole (item) {
  if (!item || typeof item !== 'object') return ''
  const role = item.equipmentRole != null ? item.equipmentRole : item.role
  return role == null ? '' : String(role).trim()
}

/** 是否显式声明为本命法宝。**绝不**从"旧 treasure[0] 里有东西"推断。 */
function isNatalTreasure (item) {
  if (!item || typeof item !== 'object') return false
  if (item.isNatal === false || /非本命|不是本命|未(?:炼为|成为|绑定)本命/.test(itemName(item) + itemType(item))) return false
  const role = explicitRole(item)
  if (/^(normal|普通|普通法宝)$/i.test(role)) return false
  if (item.isNatal === true) return true
  if (role && /^(natal|本命|本命法宝)$/i.test(role)) return true
  /* 明确「本命」文字：只看名字与类型，避免描述里出现否定句被误读 */
  return itemName(item).indexOf('本命') >= 0 || itemType(item).indexOf('本命') >= 0
}

/**
 * 这件物品允许落在本组的哪些 index。返回全新数组。
 *
 * 语义要点：
 *   · 武器恒为 [0]。
 *   · 护甲按明确部位（equipmentRole 或 名称/类型 里的部位词）归位；无明确部位 = 身体。
 *   · 功法按明确类别（炼体/神识/百艺）归位；无明确 = 主修。
 *   · 法宝只有 isNatal===true / equipmentRole==='natal' / 明确「本命」文字才算本命 [0]，
 *     否则一律 [1..5]。**不能因为旧 treasure[0] 有东西就当本命。**
 *
 * @param {string} slotKey
 * @param {object|null} [item] 物品；不传时返回该组全部合法 index
 * @returns {number[]}
 */
export function allowedEquipmentIndices (slotKey, item) {
  assertSlotKey(slotKey)

  if (slotKey === 'weapon') return !explicitRole(item) || /^(weapon|武器|兵器)$/i.test(explicitRole(item)) ? [0] : []

  if (slotKey === 'treasure') {
    if (explicitRole(item) && !/^(natal|本命|本命法宝|normal|普通|普通法宝|treasure|法宝|flying|飞行)$/i.test(explicitRole(item))) return []
    return isNatalTreasure(item) ? [0] : [1, 2, 3, 4, 5]
  }

  if (slotKey === 'armor') {
    /* 1) 显式 equipmentRole 优先（这是调用方的明确意图） */
    const role = explicitRole(item).toLowerCase()
    if (role && Object.prototype.hasOwnProperty.call(ARMOR_ROLE_MAP, role)) {
      return [ARMOR_ROLE_MAP[role]]
    }
    if (role && !/^(armor|护甲|防具)$/.test(role)) return []
    /* 细分类型先于名字；饰品不能因叫玉甲佩就跑到身体槽。 */
    if (Object.prototype.hasOwnProperty.call(ARMOR_ROLE_MAP, itemType(item).toLowerCase())) return [ARMOR_ROLE_MAP[itemType(item).toLowerCase()]]
    if (itemType(item).toLowerCase() === 'accessory') return [3]
    /* 2) 名称/类型里的明确部位词 */
    const byWord = matchWords(itemTexts(item), ARMOR_PART_WORDS)
    if (byWord !== null) return [byWord]
    /* 3) 无明确部位 → 身体 */
    return [1]
  }

  /* technique：显式 role 优先，其次明确类别词，否则主修 */
  const role = explicitRole(item).toLowerCase()
  if (role && Object.prototype.hasOwnProperty.call(TECHNIQUE_ROLE_MAP, role)) {
    return [TECHNIQUE_ROLE_MAP[role]]
  }
  if (role) return []
  const categoryIndex = {主修功法:0,炼体功法:1,神识功法:2,百艺功法:3}[itemType(item)]
  if (categoryIndex !== undefined) return [categoryIndex]
  const byWord = matchWords(itemTexts(item), TECHNIQUE_CATEGORY_WORDS)
  if (byWord !== null) return [byWord]
  /* 无明确类别 → 主修 */
  return [0]
}

/** 所有拥有者共用的物品分类；显式类型优先，不以名字猜材料或用途。 */
export function classifyItem (item) {
  const raw = itemType(item).toLowerCase()
  let category = 'misc', slotKey = null
  if (/^(武器|兵器|weapon)$/.test(raw)) { category = 'equipment'; slotKey = 'weapon' }
  else if (/^(护甲|防具|头部|身体|腿部|饰品|armor|accessory)$/.test(raw)) { category = 'equipment'; slotKey = 'armor' }
  else if (/^(功法|主修功法|炼体功法|神识功法|百艺功法|technique)$/.test(raw)) { category = 'technique'; slotKey = 'technique' }
  else if (/^(凡器|法器|灵器|古宝|灵宝|通天灵宝|玄天之宝|宝器)$/.test(raw)) {
    const role = explicitRole(item).toLowerCase()
    if (/^(weapon|武器|兵器)$/.test(role)) { category = 'equipment'; slotKey = 'weapon' }
    else if (Object.prototype.hasOwnProperty.call(ARMOR_ROLE_MAP,role) || /^(armor|护甲|防具)$/.test(role)) { category = 'equipment'; slotKey = 'armor' }
    else { category = 'treasure'; slotKey = 'treasure' }
  }
  else if (/^(法宝|本命法宝|普通法宝|飞行法宝|treasure)$/.test(raw)) { category = 'treasure'; slotKey = 'treasure' }
  else if (/^(消耗|消耗品|丹药|灵兽丹|药剂|药品|食物|食品|符箓|符纸|灵石|油料|灯油|燃料|灵油|consumable)$/.test(raw)) category = 'consumable'
  else if (/^(材料|灵材|药材|矿石|妖丹|草药|灵药|种子|锻材|炼器材料|炼丹材料|material)$/.test(raw)) category = 'material'
  else if (/^(重要物品|珍宝|任务物品|信物|钥匙|地图|宝物)$/.test(raw)) category = 'rare'
  const label = {equipment: slotKey === 'weapon' ? '武器' : '护甲', technique:'功法', treasure:'法宝', consumable:'消耗品', material:'材料', rare:'重要物品', misc:'杂物'}[category]
  const icon = {weapon:'fa-khanda', armor:'fa-shield-alt', technique:'fa-book-open', treasure:'fa-gem', consumable:'fa-flask', material:'fa-cubes', rare:'fa-star', misc:'fa-box-open'}[slotKey || category]
  return {category, label, slotKey, indices:slotKey ? allowedEquipmentIndices(slotKey,item) : [], icon}
}

export function equipmentRealmName(owner) {
  const raw = typeof owner === 'string' ? owner : owner?.['2'] || owner?.realm || ''
  return String(raw).replace(/<[^>]*>/g,'').split(/[|｜]/)[0].trim().replace(/\s+/g,'')
    .replace(/[（(]\d+(?:\.\d+)?[%％][）)]$/u,'')
    .replace(/^((?:炼气|筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?)[（(](?:未详|未知|未注明)[）)]$/u,'$1')
}

/** 只读拥有者当前境界，不从身份、描述或法宝名称推断修为。 */
export function canEquipNatalTreasure (owner) {
  const realm = equipmentRealmName(owner)
  return /^(?:结丹|金丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?(?:初期|中期|后期|圆满|大圆满|巅峰)?$/u.test(realm)
    || /^(?:真仙|金仙|太乙(?:玉仙)?|大罗(?:金仙)?|道祖)(?:期|境)?(?:下位|中位|上位|初期|中期|后期|圆满|大圆满|巅峰)?$/u.test(realm)
}

export function isTreasureSet(item) {
  if(!item||classifyItem(item).slotKey!=='treasure')return false;
  const description=String(item['3']??item.description??item.desc??'');
  return item.treasureSet===true||/(?:所使|所用|所炼)的成套[^，。；]{0,16}(?:圆珠|飞剑|阵旗|法宝|法器)/u.test(description);
}

function validEquipmentQuantity(item) {
  const quantity=item['5']??item.quantity;
  return quantity==null||/^[1-9]\d*$/.test(String(quantity))&&
    Number.isSafeInteger(Number(quantity))&&(Number(quantity)===1||isTreasureSet(item));
}

/** Consolidate parts of the same sourced artifact in a single owner's snapshots. */
export function coalesceTreasureSets(remarks) {
  const inventory=remarks?.inventory,treasure=remarks?.equipment?.treasure;
  if(!Array.isArray(inventory)&&!Array.isArray(treasure))return remarks;
  const groups=new Map();
  for(const [slots,rows] of [[true,treasure],[false,inventory]])for(const [index,item] of (Array.isArray(rows)?rows:[]).entries()){
    if(!isTreasureSet(item)||!Number.isSafeInteger(Number(item['5']??item.quantity))||Number(item['5']??item.quantity)<1)continue;
    const key=JSON.stringify([item.treasureSetId??null,item['1']??item.name,item['2']??item.type,
      item['3']??item.description??item.desc,item['4']??item.effect,item.artifactTier??null]);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({slots,index,item});
  }
  const nextInventory=Array.isArray(inventory)?[...inventory]:null, nextTreasure=Array.isArray(treasure)?[...treasure]:null;
  const removed=new Set();
  let changed=false;
  for(const entries of groups.values()){
    if(entries.length<2)continue;
    const [first]=entries, ids=new Map();
    let quantity=0,valid=true;
    for(const {item} of entries){
      const id=item['0']??item.id, count=Number(item['5']??item.quantity);
      if(id&&ids.has(id)){if(ids.get(id)!==count)valid=false;continue;}
      if(id)ids.set(id,count);
      quantity+=count;
    }
    if(!valid||!Number.isSafeInteger(quantity))continue;
    const combined={...first.item,5:String(quantity),treasureSet:true};
    if(Object.hasOwn(combined,'quantity'))combined.quantity=quantity;
    if(first.slots)nextTreasure[first.index]=combined;
    else nextInventory[first.index]=combined;
    for(const {slots,index} of entries.slice(1)){
      if(slots)nextTreasure[index]=null;
      else removed.add(index);
    }
    changed=true;
  }
  if(!changed)return remarks;
  return {...remarks,...(nextInventory?{inventory:nextInventory.filter((_,index)=>!removed.has(index))}:{}),
    ...(nextTreasure?{equipment:{...remarks.equipment,treasure:nextTreasure}}:{})};
}

export function equipmentEligibility (owner, slotKey, index, item) {
  const slots = getEquipmentSlots(slotKey)
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) return {allowed:false, reason:'装备槽位索引越界'}
  if (!item) return {allowed:true, reason:''} // 卸下始终允许
  const info = classifyItem(item), explicitType = itemType(item)
  if (!explicitType || info.slotKey !== slotKey) return {allowed:false, reason:'物品类型不能装备到'+slots[index].label}
  if (!validEquipmentQuantity(item)) return {allowed:false, reason:'装备必须是一件独立物品；普通堆叠须先拆分'}
  if (!allowedEquipmentIndices(slotKey,item).includes(index)) return {allowed:false, reason:'物品与命名位置不匹配；本命位须有本命证据'}
  if (slotKey === 'treasure' && index === 0 && !canEquipNatalTreasure(owner)) return {allowed:false, reason:'结丹期及以上方可装备本命法宝；境界未明确时暂不开放'}
  return {allowed:true, reason:''}
}

/** 游戏与预制编辑器共用的物品类型白名单。旧别名可读，新生成优先使用用途类型。 */
export const SUPPORTED_ITEM_TYPES = Object.freeze(['武器','兵器','护甲','防具','头部','身体','腿部','饰品','凡器','法器','灵器','法宝','普通法宝','本命法宝','飞行法宝','古宝','灵宝','通天灵宝','玄天之宝','宝器','功法','主修功法','炼体功法','神识功法','百艺功法','消耗','消耗品','丹药','灵兽丹','药剂','药品','食物','食品','符箓','符纸','油料','灯油','燃料','灵油','材料','灵材','药材','矿石','妖丹','草药','灵药','种子','锻材','炼器材料','炼丹材料','重要物品','珍宝','任务物品','信物','钥匙','地图','宝物','阵盘','阵具','杂物','凡物','其他物品']);

/** 同一段规则供四份预设和编辑器直接引用，类型、部位与等阶不可混用。 */
export const NPC_ATTIRE_RULE = '【人物行装】按当前身份、地位、背景、职业、财力和场景判断穿戴、惯用物件和随身家当。正常着装的有形 NPC 默认衣装完整，穿着描述写合适的上装、裤裙和鞋履；取得制式衣衫可合理推定配套的普通下装和鞋履，原著未逐件明写时也照常描述。赤足、窘迫、卸装或换装服从实际情况，饰物按身份和习惯决定。没有实际加成的日常衣物只写第16列穿着，没有消费或持续用途的生活杂物留在叙事中。首次建档可按背景、职业和资源建立有实际作用的常备私物、用具和装备，无需写成剧情新获；信物、稀有资源和未来所得仍按情节结算。已建档人物的空槽和空袋不触发重新发放。';
export const NPC_ASSET_RULE = '【人物资产】首次建档按身份、地位、职业、家底和地区经济给出有用途的初始物资和明确的货币余额。修士有正常收入来源或家底时，原著未列数目可依据经济基准保守估算；确实无灵石的凡人、穷困角色或已经花光的角色记0。凡俗家计用实际可用的银钱和实物表现，不换算成灵石。此后承接上次余额，按已发生的差事、定额供给、营生、交易、旅途花费或消耗记入收入与支出。已确定履职或享有待遇的时间跳跃可合计估算；具体数额和支付方式有原文时优先用原文，估算注明依据。普通灵石用原有余额字段和交易渠道，无须生成对应物品。';

export const CURRENCY_SETTLEMENT_RULE = `【货币入账协议】本节决定独立端实际货币命令和钱包字段，优先于旧命令名与旧示例。
- 玩家与 NPC 的铜钱、铜板、碎银、银锭、银票等实物货币用杂物物品入包，按实际币种、单位及面额记录。铜钱/铜板按同类堆叠。用 createItem 新增已到手货币，双方在册且源堆已知用 transferItem 转移，已支付或消耗按实际数量扣库存。例：收到六十枚铜板，在源堆未记录时用 createItem({"owner":"B1","item":{"1":"铜钱","2":"杂物","3":"凡俗流通钱币，按文计数","5":"60"},"evidence":{"source":"story","quote":"把铜板一枚枚收进贴身的麻布钱袋里"}})，证据引用本轮明确收下的原句。已知旧余额加本轮净变化，概称“百余文”不额外猜补；已记过的交易、报价和未兑现报酬不重复发放。银票保留面额，银锭和碎银按各自的记录单位处理。
- 灵石只记钱包，分下品、中品、上品、极品。旧第26列代表下品。缺省按0；新角色先核对实际出身、身份、修为、势力、资源与已知持有，再按当地经济规则保守估初值。凡人无明确灵石来源与财富耗尽者按0，新NPC按现有初始化白名单记账，中品及以上须有相称来源；玩家初值以开局确立的持有或已确认获得为依据。已有角色承接余额，不能重新按境界发一份。
- 已完成的收入、支付、消费、丢失、转移与兑换用原生 transferSpiritStones({"from":角色ID或null,"to":角色ID或null,"grade":"下品","amount":正整数,"evidence":...})。未写品级按下品，说明过品级就逐品级分别结算，任一品级不足不扣别的品级。非灵石交易不自动兑换。
- 世界经济口径：一百块下品兑一块中品是公认兑率，仍须有实际成交。上品和极品没有固定折算，按原文成交条件。本人实际兑换可用 from/to 为同一角色、grade 为支出品级、amount 为支出数、toGrade 与 receivedAmount 为实际收取品级和数量，同一条命令完成扣入。`;

export function equipmentTypeContract () {
  return [
    '【物品用途与装备类型合同 v2】先核对器物等阶和用途，再填第2列、equipmentRole 和 artifactTier。凡器与法器用作随身持用或御使装备时归武器栏；护甲仍按穿戴部位，功法、消耗品、材料与道具按各自用途归类。新物品用明确类型，凭真实等阶和用途落槽。',
    "【来源与因果边界】年表预制是在还原已经确定的原著故事：只依据截至当前时间点的原文与设定，可从已明确拥有、佩带、实际使用及合理上下文还原对应人物当时已有的背包道具和装备，不机械要求另写获取过程；先核对已有物品ID，已有状态不重复发放。明确属于后续时期的物品不能提前补入。",
    NPC_ATTIRE_RULE,
    NPC_ASSET_RULE,
    "实时游戏是按实际因果发展的新故事：首次建档按人物行装与资产规则。已建档人物只依当前权威档案、本轮实际成立的事实和有效行动结算持有与装卸，空袋或空槽不触发补发，不恢复已丢失、赠出、销毁或从未获得的装备。原著补演进入游戏前须经过已确认的时间区间和变异边界，现实游戏已发生的改变优先，不能借补全强拉回原著轨道。",
    'weapon[0]：武器，equipmentRole=weapon。可装备的凡器、法器（包括青蛟旗这类直接持用或御使的器物）填写第2列「武器」，其实际等阶填 artifactTier。一个人物一个主用武器位，其余同类器物可在储物袋备用。法宝及以上的御使器物归法宝栏，器物外形不改变真实等阶。',
    '武器位在满足御使条件的同槽器物中择优。同属性比较实际加成，属性不同时按真实器阶、品质比较；同阶同品且用途不同则保留既有搭配，原文明示的装备与暂缓决定优先。',
    'armor：护甲，必须按实际穿戴部位写 equipmentRole。head→0（冠、盔、帽、面具、头饰）；body→1（法衣、衣袍、胸甲、全身甲、披风、护腕手甲）；legs→2（护腿、胫甲、裤装、战靴、鞋履）；accessory→3（戒指、手镯、项链、玉佩、腰饰）。旧类型头部/身体/腿部/饰品按其类型定位，显式部位优先于名字；无明确部位的旧护甲默认身体，不为新物品省略部位。',
    'technique：只放提供长期修炼路线与完整境界效果的功法实体。equipmentRole=main→0（主修，法修/兵器修炼/长期身法体系）；body→1（炼体）；spirit→2（神识）；craft→3（炼丹、炼器、符箓、阵法等百艺）。旧 spell/weapon/movement 对应 main，shenshi 对应 spirit。可施放法术、秘术、神通、招式及一次性学习秘籍属于技能或知识载体，不因名字带诀就塞功法槽。',
    'treasure：实际等阶达到法宝及以上的可装备器物（如灵宝、通天灵宝、玄天之宝），equipmentRole=normal→1–5，含长期驱使的攻击、防御、辅助、神识、储物或飞行法宝。飞行法宝共用普通位。场景阵台、宗门飞舟、借用物与非本人资产不自动生成随身装备。一次性符箓/符宝、丹药、材料、阵法材料、未启用阵盘、任务信物和普通工具不能装备。',
    'treasure[0]：仅本命法宝，equipmentRole=natal 或 isNatal=true 或既有明确本命名称/类型。必须有真实炼化绑定依据且拥有者当前明确结丹期及以上，普通法宝不能因排首位变本命；isNatal=false 或 normal 明确标记优先，不自动替拥有者绑定。',
    '旧档以已有类型和显式用途读取。新生成及有依据的定向校订按实际等阶和用途填写武器、护甲或法宝，沿用原物品ID。',
    '一格一件。由原文确认合用的整套法宝只写一个物品变量、一个ID及一个法宝槽，标记 treasureSet=true，第5列写该套实际剩余的组件数。换装移动整套，单颗毁损只扣本套数量，不另生成或占用一个槽。几件独立同名法宝仍各自登记。普通堆叠须拆为有独立ID的单件再装备。换装只搬同一拥有者的原ID与完整字段，旧物返其本人背包；卸下只清目标格并返背包，保留null，禁止压缩后续槽位。无法找到物品/ID或槽位时拒绝，不凭空造占位装备、不卸其他物品。',
    '旧档可读取且不能删除：错类型、错命名槽、未达本命门槛的旧物完整退所属背包，不计装备效果；无类型旧装备仅按原有所属组兼容，不能据此生成新物品。未知扩展字段保留，无法可靠迁移时保留原数据并提示。'
  ].join('\n');
}

/* ── normalize 内部：JSON 解包 ───────────────────────────────────── */

const MAX_JSON_LAYERS = 3

/**
 * 把最多三层 JSON 字符串逐层解成值。空串视为"无数据"。
 * 超过层数或 JSON 非法都明确抛错 —— 绝不把未知数据当空丢掉。
 */
function deepParse (value, where) {
  let cur = value
  for (let layer = 0; layer < MAX_JSON_LAYERS; layer += 1) {
    if (typeof cur !== 'string') return cur
    const trimmed = cur.trim()
    if (!trimmed) return null
    try {
      cur = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(where + ' 不是合法 JSON：' + String(error && error.message || error))
    }
  }
  if (typeof cur === 'string' && cur.trim()) {
    throw new Error(where + ' 的 JSON 嵌套超过 ' + MAX_JSON_LAYERS + ' 层，拒绝猜测其内容')
  }
  return cur
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 把一组的原始值解成"旧数组"形态：元素为物品对象或 null。
 *   null/undefined/'' → 空数组
 *   JSON 字符串（可多层）→ 解包后再判
 *   数组 → 原样（保留 null 占位）
 *   单物品对象 → 视作第 0 位的一件物品
 * 其他（数字/布尔/非空坏串）→ 抛错
 */
function parseGroupValue (value, slotKey) {
  const where = '装备组 ' + slotKey
  let v = deepParse(value, where)
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.slice()
  if (isPlainObject(v)) return [v]
  throw new Error(where + ' 既不是数组也不是物品对象（实际类型：' + (typeof v) + '）')
}

function slotCapacity (slotKey) {
  return SLOT_TABLE[slotKey].length
}

/**
 * 把任意历史形态的装备数据投影成 1/4/4/6。
 *
 * @param {object|string|null} raw 装备对象，或最多三层的 JSON 字符串
 * @param {{version?:number}} [options] version=1 表示已是新合同（只做越界收口，不重新推断）
 * @returns {{equipment:{weapon,armor,technique,treasure}, overflow:Array<{slotKey,index,item,reason}>, version:1}}
 */
export function normalizeEquipmentLayout (raw, options) {
  const opts = options || {}
  const version = opts.version

  /* version 只认：未给（旧数据）或 1（新合同）。其他值不猜。 */
  if (version !== undefined && version !== null && version !== 1 && version !== '1') {
    throw new Error('未知的装备布局版本：' + String(version) + '（只支持省略（旧六槽）或 1）')
  }
  const isVersion1 = version === 1 || version === '1'

  /* 顶层：必须是对象（可多层 JSON 串），不能是数组或标量 */
  let root = deepParse(raw, '装备布局根')
  if (root === null || root === undefined) root = {}
  if (!isPlainObject(root)) {
    throw new Error('装备布局根必须是对象（实际：' + (Array.isArray(root) ? '数组' : typeof root) + '）')
  }
  /* 未知键不静默丢弃：返不回调用方，就当场报错让调用方处理 */
  for (const key of Object.keys(root)) {
    if (!SLOT_KEYS.includes(key)) {
      throw new Error('装备布局里出现未知键：' + key + '（只允许 ' + SLOT_KEYS.join('/') + '）')
    }
  }

  const overflow = []
  const equipmentOut = {}
  const parsedByKey = {}

  /* 先全部解析一遍：任何一组坏数据都在这里抛错，不会半途产出 */
  for (const slotKey of SLOT_KEYS) {
    parsedByKey[slotKey] = parseGroupValue(root[slotKey], slotKey)
  }

  for (const slotKey of SLOT_KEYS) {
    const cap = slotCapacity(slotKey)
    const out = new Array(cap).fill(null)
    const source = parsedByKey[slotKey]

    for (let oldIndex = 0; oldIndex < source.length; oldIndex += 1) {
      const originalItem = source[oldIndex]
      if (originalItem === null || originalItem === undefined) continue
      if (!isPlainObject(originalItem)) throw new Error('装备物品必须是对象，保留原数据')
      const item = structuredClone(originalItem)
      const typed = !!itemType(item)
      if (typed && !validEquipmentQuantity(item)) {
        overflow.push({slotKey,index:oldIndex,item,reason:'equipped_stack'}); continue
      }
      if (typed && classifyItem(item).slotKey !== slotKey) {
        overflow.push({slotKey,index:oldIndex,item,reason:'item_type_mismatch'}); continue
      }
      if (slotKey === 'treasure' && isNatalTreasure(item) && Object.prototype.hasOwnProperty.call(opts,'owner') && !canEquipNatalTreasure(opts.owner)) {
        overflow.push({slotKey, index:oldIndex, item, reason:'natal_realm_locked'}); continue
      }

      if (isVersion1 && slotKey === 'treasure' && oldIndex === 0 && Object.prototype.hasOwnProperty.call(opts,'owner') && !isNatalTreasure(item)) {
        overflow.push({slotKey, index:oldIndex, item, reason:'natal_evidence_missing'}); continue
      }

      if (isVersion1) {
        if (typed && !allowedEquipmentIndices(slotKey,item).includes(oldIndex)) {
          overflow.push({slotKey,index:oldIndex,item,reason:'item_slot_mismatch'}); continue
        }
        /* 新合同：合法索引原样保留，不重新推断搬动已命名槽；越界送 overflow */
        if (oldIndex < cap) out[oldIndex] = item
        else overflow.push({ slotKey, index: oldIndex, item, reason: 'out_of_range' })
        continue
      }

      /* 旧六槽：优先保留仍符合 allowedIndices 的原索引，否则放第一个空的合法槽 */
      const allowed = allowedEquipmentIndices(slotKey, item)
      if (allowed.includes(oldIndex) && out[oldIndex] === null) {
        out[oldIndex] = item
        continue
      }
      let placed = false
      for (const candidate of allowed) {
        if (out[candidate] === null) { out[candidate] = item; placed = true; break }
      }
      if (!placed) overflow.push({ slotKey, index: oldIndex, item, reason: 'no_legal_slot' })
    }

    equipmentOut[slotKey] = out
  }

  return { equipment: equipmentOut, overflow, version: 1 }
}
