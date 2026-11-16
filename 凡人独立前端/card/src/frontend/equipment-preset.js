/**
 * equipment-preset.js
 *
 * 把「装备命名槽位 1/4/4/6」合同投影进变量预设。
 *
 * 普通脚本（挂在 window 上），**不 import**：
 *   权威核心由调用方显式传入（layoutCore = 真实 card/src/core/equipment-layout.js），
 *   本文件**不自建**任何槽位数量或名称表。所有索引与命名一律从
 *   layoutCore.getEquipmentSlots(slotKey) 动态生成。
 *
 * 提供两个全局函数：
 *   window.frEquipmentSlotContract(layoutCore, phase)   → 按阶段生成合同正文
 *   window.frAdaptEquipmentLayoutRules(preset, layoutCore) → 就地投影（深拷贝，不改输入）
 *
 * ── 边界 ────────────────────────────────────────────────────────
 *   · 只改预设的规则数组与 meta；不碰业务/存档/数值公式。
 *   · 不制造新命令、不造后台 API、不加偏好开关。
 *   · 不整条替换既有规则：只**追加**受控规则，保留其他规则、顺序、关闭状态、
 *     玩家自定义尾注。
 *   · 二次投影幂等。
 */
(function (global) {
  'use strict'

  var PERSONAL_RULE_ID = 'fr-equipment-layout-personal-v1'
  var ITEMS_RULE_ID = 'fr-equipment-layout-items-v1'
  var MERGED_RULE_ID = 'fr-equipment-layout-merged-v1'
  var META_KEY = 'equipmentLayoutVersion'
  var CONTRACT_VERSION = 1
  /* 不可混淆的机器标记：用来判断某条规则是不是"本模块的合同"。
     不能用中文标题判断 —— 玩家自定义文本里完全可能恰好含"装备命名槽位"字样，
     那样会把玩家的东西误判成我们旧版然后覆盖掉（这是 T-EQUIP-PRESET-018 自查发现的真实缺陷）。 */
  var CONTRACT_MARKER = '<!-- fr-equipment-layout-contract v' + CONTRACT_VERSION + ' -->'

  /* 固定落点：玩家/NPC/灵兽的人物组（任务书要求为"启用且存在"的加规则） */
  var PERSONAL_GROUPS = ['player', 'npc', 'beast']

  /* ── 小工具 ─────────────────────────────────────────────────── */

  function isObject (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

  /** 深拷贝：JSON 安全的值用 JSON 往返；保留 undefined 键与原型无关的普通对象。 */
  function deepClone (value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(deepClone)
    var out = {}
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = deepClone(value[k])
    }
    return out
  }

  /** 取权威槽位定义；核心缺失或形状不对就明确抛错，不猜。 */
  function slotsOf (layoutCore, slotKey) {
    if (!layoutCore || typeof layoutCore.getEquipmentSlots !== 'function') {
      throw new Error('frEquipmentSlotContract: 必须传入真实的 equipment-layout 核心模块（含 getEquipmentSlots），不得自建槽位表')
    }
    var slots = layoutCore.getEquipmentSlots(slotKey)
    if (!Array.isArray(slots) || !slots.length) {
      throw new Error('frEquipmentSlotContract: 核心未返回 ' + slotKey + ' 的槽位定义')
    }
    return slots.map(function (s) {
      return { index: s.index, label: String(s.label), role: String(s.role || 'normal') }
    })
  }

  /** 把一组槽位渲染成「序号. 名称」清单文本。 */
  function renderSlotList (slots) {
    return slots.map(function (s) { return s.index + '. ' + s.label }).join('、')
  }

  /** 本命位索引（由核心标记 primary 推导，不硬写 0）。 */
  function primaryIndexOf (slots) {
    var p = slots.filter(function (s) { return s.role === 'primary' })[0]
    return p ? p.index : null
  }

  /* ── 合同正文 ───────────────────────────────────────────────── */

  /** 公共的"槽位骨架"段落：四组命名与数量，全部来自核心。 */
  function buildSkeleton (layoutCore) {
    var weapon = slotsOf(layoutCore, 'weapon')
    var armor = slotsOf(layoutCore, 'armor')
    var technique = slotsOf(layoutCore, 'technique')
    var treasure = slotsOf(layoutCore, 'treasure')

    var lines = []
    lines.push('装备结构固定四组数组，**数组长度与命名槽位一一对应，不得增多也不得减少**：')
    lines.push('')
    lines.push('- weapon（兵器）：' + weapon.length + ' 格。' + renderSlotList(weapon) + '。实际只能装备一把。')
    lines.push('- armor（护甲）：' + armor.length + ' 格。' + renderSlotList(armor) + '。')
    lines.push('- technique（功法）：' + technique.length + ' 格。' + renderSlotList(technique) + '。')
    lines.push('- treasure（法宝）：' + treasure.length + ' 格。' + renderSlotList(treasure) + '。')

    var natalIndex = primaryIndexOf(treasure)
    if (natalIndex !== null) {
      lines.push('')
      lines.push('  treasure 的 ' + natalIndex + ' 号位是**本命法宝**位，其余为普通法宝位。')
      lines.push('  玩家与所有 NPC 同一限制：当前明确为结丹期及以上才允许装备本命法宝；凡人、炼气、筑基或境界未知时本命位留 null。持有不等于装备，旧不合格本命物品完整回到所属者背包，禁止计加成；卸下始终允许。')
      lines.push('  本命位只能由**明确的本命证据**占用（物品自身标记为本命 / 明确写作"本命"），')
      lines.push('  **不得因为普通法宝原本排在第 ' + natalIndex + ' 位就认定它是本命**。')
    }

    lines.push('')
    lines.push('物品第2列写实际类型：武器、护甲、功法、法宝、消耗品、材料、杂物。equipmentRole 为护甲指定 head/body/legs/accessory，为功法指定 main/body/spirit/craft，为本命法宝指定 natal。材料和消耗品不得为填满装备格改写成法宝；油脂等按本次明确用途分类，未明用途保持杂物。')
    lines.push('旧档物品类型为法器、古宝、灵宝或通天灵宝时，按明确 equipmentRole 判定去向：weapon 到兵器；head/body/legs/accessory 到对应护甲；没有武器/护甲部位声明则作为普通法宝。不能因名称像剑或甲擅自更换物品类型。新生成仍用实际用途对应的武器/护甲/法宝类型，品阶单独记录。')
    if (typeof layoutCore.equipmentTypeContract === 'function') lines.push(layoutCore.equipmentTypeContract())
    lines.push('四组数组是**定长骨架**：每个下标恒定对应一个命名槽，空槽写 null 占位。')
    lines.push('  · 不得用 filter(Boolean) 之类手段压缩数组，否则槽位与名字会整体错位。')
    lines.push('  · 卸下一格只把该格设为 null，后面的格子**不得前移**。')
    lines.push('  · 装备与背包互斥：物品要么在某个槽位，要么在 owner 本人背包，不得同时存在。')

    return lines.join('\n')
  }

  /** personal（人物阶段）合同正文。 */
  function buildPersonalContract (layoutCore) {
    var parts = []
    parts.push('## 装备命名槽位骨架（新档案）')
    parts.push('')
    parts.push(buildSkeleton(layoutCore))
    parts.push('')
    parts.push('## 人物阶段只读、不搬装备')
    parts.push('')
    if (layoutCore.NPC_ATTIRE_RULE) parts.push(layoutCore.NPC_ATTIRE_RULE)
    parts.push('人物阶段**只读取**上述槽位骨架来解释正文里的穿戴/替换动作，并据此判断"当前这一格有没有东西"。')
    parts.push('')
    parts.push('- **不得**在人物阶段执行装备、卸下或物品生成。')
    parts.push('- **不得**直接改写已有角色的 equipment 四组数组，也不得直接增删人物背包里的物品。')
    parts.push('- 若正文确实需要换装，只描述"谁把什么放到哪一格"这一层语义，')
    parts.push('  真正的落库由物品阶段按下面的原生命令完成。')
    return parts.join('\n')
  }

  /** items（物品/合并阶段）合同正文。 */
  function buildItemsContract (layoutCore) {
    var parts = []
    parts.push('## 装备命名槽位骨架')
    parts.push('')
    parts.push(buildSkeleton(layoutCore))
    parts.push('')
    parts.push('## 装备/卸下的原生命令')
    parts.push('')
    parts.push('沿用**既有原生命令**，不新增命令、不造后台接口：')
    parts.push('')
    parts.push('- `equipItem({owner, slot, index, itemId, data})`')
    parts.push('- `unequipItem({owner, slot, index, itemId})`')
    parts.push('')
    parts.push('其中：')
    parts.push('- `slot` 取 weapon / armor / technique / treasure 之一。')
    parts.push('- `index` **必须**与上面列出的命名槽序号一致，指向那个具名格位。')
    parts.push('  weapon 只有一格，`index` 就是它的序号；不得另造"持握手/护甲槽"这类别名位置。')
    parts.push('- `owner` 是物品归属人本人：装备与背包都属于同一个 owner，')
    parts.push('  不得把物品跨人转移，也不得把溢出的旧物品塞进别人背包。')
    parts.push('- `data` 仍是**完整原物品数据**，原样搬运，')
    parts.push('  **不得**在换装时改写白值、传导率或任何数值字段。')
    parts.push('')
    parts.push('## 装备行动与已有物品选择')
    parts.push('- 玩家点击装备/卸下产生下一轮行动意图，不等于已经完成，不得在下一轮结算前宣称已生效。物品阶段或合并阶段读取明确行动中的物品ID、owner、slot和index，核实持有与门槛后输出原生装备/卸下指令；不得替玩家自动挑选、更换或绑定本命法宝。玩家明确选择可用的较弱装备也应执行，不以最强规则否决。')
    parts.push('- 实时游戏正文已明确发生取得并装备或换装时，先核对现有物品ID；未登记的真实取得先创建，再装备。已持有只搬运，不重复创建；静态穿着描述本身不证明新取得。')
    parts.push('- NPC 在本轮实际处理的角色范围内，检查本人已有背包与装备，保持各命名槽中最强的可用现有物品：先过滤类型/部位、境界、本命、白值门槛和明确禁用状态，再比较实际可生效能力；空槽已有合法可用候选应装备，不必等正文再次复述穿戴动作。同等或无法证实更优时保持当前；不得为凑满槽创造物品、跨人拿装备或给未纳入本轮的全世界NPC批量换装。')
    parts.push('- NPC 明确的封印、损坏、任务约束、隐藏身份/外观要求仍优先；最强是可用后的比较，不能拿高门槛、未激活的器物或价格/描述中无关数字冒充收益。玩家不适用NPC自动优选。')
    parts.push('- 以上装备行动只由物品/合并阶段落库；人物阶段仅记录人物状态，不输出物品命令，不新造自动刷装备系统。')
    parts.push('')
    parts.push('## 旧槽溢出的处理')
    parts.push('')
    parts.push('当一件物品按本骨架找不到合法空格时：')
    parts.push('')
    parts.push('- 把它**完整归还它自己的背包**，不删除、不丢弃、不合并、不复制。')
    parts.push('- 不因为溢出就把它改写成另一件物品，也不跨人转移。')
    parts.push('- 同一件物品只能存在一份，不得重复计入数值加成。')
    parts.push('')
    parts.push('## 数值容器口径不变')
    parts.push('')
    parts.push('- 容器公式**仍然只吃无加成白值**，不受槽位命名影响，保持不变。')
    parts.push('- 法力驱动法攻与各项硬锁同样保持不变，不因本骨架改变。')
    parts.push('- 物品先分类再写列：武器、护甲、法宝第4列写器物效果；消耗品写使用效果；材料、信物、杂物写实际用途。非功法用0–5列。功法仅用0–3、5–8列（6品阶、7修炼上限、8完整境界效果），当前效果由游戏计算。物品不写第9至11列，不生成同源印记或同源效果。')
    parts.push('')
    parts.push('## 新档案版本标记')
    parts.push('')
    parts.push('- 新档案在**备注外层**写入 `equipmentLayoutVersion: ' + CONTRACT_VERSION + '`。')
    parts.push('- 该标记**不得**混进 equipment 的四组对象里（那四组只放槽位物品）。')
    parts.push('- 未知的存量数据一律保留，**不得静默裁掉**。')
    return parts.join('\n')
  }

  /**
   * 生成指定阶段的合同正文。
   * @param {object} layoutCore 真实的 equipment-layout 模块（必须含 getEquipmentSlots）
   * @param {'personal'|'items'} phase
   * @returns {string}
   */
  function frEquipmentSlotContract (layoutCore, phase) {
    if (phase === 'personal') return buildPersonalContract(layoutCore)
    if (phase === 'items') return buildItemsContract(layoutCore)
    throw new Error('frEquipmentSlotContract: phase 只支持 personal 或 items，收到 ' + String(phase))
  }

  /* ── 已持久化旧规则迁移 ─────────────────────────────────────── */

  /* 迁移表版本号：进了这个版本的迁移才会被应用；改迁移内容时必须递增，
     否则已迁移过的存档不会被重新处理。 */
  var MIGRATION_VERSION = 3
  var MIGRATION_META_KEY = 'equipmentRuleMigrationVersion'

  /**
   * 已知旧发布句 → 新句。每条只替换**完整的一整句**（逐字精确匹配）。
   *
   * 为什么要这份表：玩家存档里可能已经持久化了旧版预设的规则原文。
   * 只改 evolution-presets.json 只影响新导入/新建的预设，
   * 已存在的旧文本不会被自动纠正，于是旧口径会长期留在提示词里。
   *
   * 安全边界（任务书要求）：
   *   · 只在「原文逐字等于旧句」时替换；带自定义前后文/尾注的行不匹配 → 原样保留
   *   · 不按规则 id 或 marker 整条替换
   *   · 关闭的规则不启用，关闭的组不复活
   *   · 幂等：替换后不再含旧句，二次迁移无变化
   */
  var LEGACY_SENTENCES = [

    /* ── im-5 ── */
    {
      id: "im5-subtype-def",
      from: "定义中不写真实 ID、数量、获得途径或动态实例状态；`quantity`、`acquisition`、物品ID 只写在 createItem 顶层。功法定义可省略 `effect`；完整 createItem 示例见 `输出格式`。新功法必须写 numeric.kind:\"technique\"`、`品质档`、`subtype`、`品质` 与至少一段合法 realmEffects 语义 hint，可选 神识相关限制，并遵循 `Standalone 功法属性语义规则`。",
      to: "定义中不写真实 ID、数量、获得途径或动态实例状态；`quantity`、`acquisition`、物品ID 只写在 createItem 顶层。功法定义可省略 `effect`；完整 createItem 示例见 `输出格式`。新功法必须写 numeric.kind:\"technique\"`、`品质档`、`equipmentRole`、`品质` 与至少一段合法 realmEffects 语义 hint，可选 神识相关限制，并遵循 `Standalone 功法属性语义规则`。"
    },
    {
      id: "im5-subtype-note",
      from: "功法示例、第8列 hint、subtype 属性方向与 `special.shenshiCapTier` 保守性，以 `输出格式` 和 `Standalone 功法属性语义规则` 为准。不要在本文件重复维护另一套功法示例。",
      to: "功法示例、第8列 hint、equipmentRole 属性方向与 `special.shenshiCapTier` 保守性，以 `输出格式` 和 `Standalone 功法属性语义规则` 为准。不要在本文件重复维护另一套功法示例。"
    },
    {
      id: "im5-flying-eq",
      from: "- 飞行法宝若被装备，固定使用 `eq.<owner> = treasure:#6:<itemId>|原因`，即法宝第6槽；普通法宝不得占用第6槽。",
      to: "- 飞行法宝若被装备，与普通法宝一样使用 `eq.<owner> = treasure:<index>:<itemId>|原因`，index 只能取 1-5；index 0 是本命位，只有物品自身带 isNatal:true 或 equipmentRole:\"natal\" 或名称/类型明确写作\"本命\"时才可占用。"
    },
    {
      id: "im5-armor-col",
      from: "| 护甲槽位 / 武器槽位 | 防具或武器的结构化装备字段 |",
      to: "| equipmentRole / 武器槽位 | 防具或武器的结构化装备字段（防具取 head/body/legs/accessory） |"
    },
    /* ── im-14 ── */
    {
      id: "im14-armor-category",
      from: "- 若 物品对象 是防具，必须写 护甲槽位；category 统一写“防具”。按装备形态与用途判定，主体躯干/全身护甲默认写 armor，披挂外层写 cloak，内衣/小衣/肚兜写 underwear，丝袜/长袜/连裤袜写 legs；只有能推断为主甲下方的轻薄副防具、隐蔽护身内层或与外层主甲并存的补充防护时，才写 inner；不得因贴身穿戴、认主绑定、共振或本命温养把主体护甲改写为 inner",
      to: "- 若 物品对象 是防具，必须写 equipmentRole；category 统一写“防具”。按装备形态与用途判定：头部防护（冠/盔/发簪/面具）写 head；主体躯干/全身/主甲/法衣/内层薄甲/手甲护腕/披风斗篷/内衣小衣肚兜一律写 body；腿部/战靴鞋履/护腿/胫甲/膝甲/丝袜/长袜/连裤袜写 legs；佩饰/环佩/镯/链/坠/腰饰写 accessory。不得因贴身穿戴、认主绑定、共振或本命温养改变 equipmentRole"
    },
    {
      id: "im14-technique-six",
      from: "- technique 是六个功法专槽：槽位序号 0=法修(spell)，1=兵器(weapon)，2=炼体(body)，3=神识(shenshi)，4=遁术(movement)，5=百艺(craft)。新生成的功法必须写 numeric.subtype`，并只能装备到对应专槽；未写 subtype 的既有功法只视为未分类旧功法，可沿用或整理到任意 technique 0-5，但不要按旧格式新建。",
      to: "- technique 是四个功法专槽：index 0=主修(main)，1=炼体(body)，2=神识(spirit)，3=百艺(craft)。新生成的功法必须写 equipmentRole（main/body/spirit/craft 之一），并只能装备到对应专槽；未写 equipmentRole 的既有功法只视为未分类旧功法，可沿用或整理到任意 technique 0-3，但不要按旧格式新建。"
    },
    {
      id: "im14-treasure-flying",
      from: "- treasure 第6槽（`槽位序号:5`）是飞行法宝专槽；只有 物品对象.category 为 `法宝` 且明确具备个人御空/飞遁/载行用途、numeric.primaryStats` 包含 `speed` 的飞行法宝，才允许 equipItem 到 `slot:\"treasure\", 槽位序号:5`。",
      to: "- treasure 没有飞行法宝专槽：飞行法宝与普通法宝同类，都只能进 index 1-5。只有 物品对象.category 为 `法宝` 且明确具备个人御空/飞遁/载行用途、numeric.primaryStats` 包含 `speed` 的飞行法宝，才允许 equipItem 到 `slot:\"treasure\", index:1-5`；index 0 是本命位，必须另有明确本命证据才可占用。"
    },
    {
      id: "im14-treasure-normal",
      from: "- 普通法宝只能装备到 treasure #1-#5（`槽位序号:0-4`）。若当前 #6 被普通法宝占用，应先尝试把该普通法宝移入 #1-#5 的空槽；没有空槽时应 unequip 回背包，不得继续占用 #6。",
      to: "- 普通法宝只能装备到 treasure index 1-5。若当前 index 0 被普通法宝占用，应先尝试把该普通法宝移入 index 1-5 的空槽；没有空槽时应 unequip 回背包，不得继续占用 index 0（本命位）。"
    },
    {
      id: "im14-armor-equip",
      from: "- 防具 equipItem 必须显式输出 护甲槽位，且必须与该防具 createItem 中的 护甲槽位 一致；只允许 `armor` / `inner` / `head` / `hands` / `legs` / `feet` / `cloak` / `underwear`；不要为防具输出 `槽位序号`",
      to: "- 防具 equipItem 必须显式输出 index（0 头部 / 1 身体 / 2 腿部 / 3 饰品），且必须与该防具 createItem 中的 equipmentRole 指向同一格：head→index 0、body→1、legs→2、accessory→3。不要输出旧字段 护甲槽位 或 槽位序号"
    },
    {
      id: "im14-weapon-hand",
      from: "- 单手武器 equipItem 必须显式输出 持握手，只允许 `right` / `left`；不要为武器输出 `槽位序号`",
      to: "- 武器 equipItem 恒为 slot:\"weapon\", index:0；左右手持握属于外观描述，写进 物品对象 描述或 第8列 hint，不作为装备命令字段"
    },
    {
      id: "im14-armor-unequip",
      from: "- 若卸下的是防具，必须显式输出 护甲槽位；不要为防具输出 `槽位序号`",
      to: "- 若卸下的是防具，必须显式输出 index（0 头部 / 1 身体 / 2 腿部 / 3 饰品）；不要输出旧字段 护甲槽位"
    },
    {
      id: "im14-weapon-unequip",
      from: "- 若卸下的是单手武器，必须显式输出 持握手；不要为武器输出 `槽位序号`",
      to: "- 若卸下的是武器，slot:\"weapon\", index:0"
    },
    {
      id: "im14-full-battle",
      from: "- 战斗型、敌对、护卫、猎杀、执法、斗法相关，或天骄/核心弟子/长老/同阶强敌等高权重 NPC 走完整战斗装备：按身份资源创建 1 件武器 + 护甲槽位 为 armor / inner / head / hands / legs / feet 的六件防具；只装备神识容量允许且槽位匹配的部分，其余留在背包。",
      to: "- 战斗型、敌对、护卫、猎杀、执法、斗法相关，或天骄/核心弟子/长老/同阶强敌等高权重 NPC 走完整战斗装备：按身份资源创建 1 件武器 + 至多 4 件防具（equipmentRole 分别 head / body / legs / accessory，每格至多一件，可缺可空）；只装备神识容量允许且部位匹配的部分，其余留在背包。"
    },
    {
      id: "im14-prodigy-tech",
      from: "- 功法数量按具体情况决定：贫穷散修、凡人、临时杂役可只有 0-1 本甚至没有；普通宗门弟子通常 1 本；背景较好的修士可有 2-4 本；天骄必须初始化六个功法专槽。",
      to: "- 功法数量按具体情况决定：贫穷散修、凡人、临时杂役可只有 0-1 本甚至没有；普通宗门弟子通常 1 本；背景较好的修士可有 2-3 本；天骄必须初始化四个功法专槽。"
    },
    {
      id: "im14-equip-step4",
      from: "4. **对应的equipItem操作**：只装备确实创建或已有、与槽位匹配且不超出神识容量的物品；超额物品留在背包，功法按 subtype 专槽装备",
      to: "4. **对应的equipItem操作**：只装备确实创建或已有、与槽位匹配且不超出神识容量的物品；超额物品留在背包，功法按 equipmentRole 专槽装备"
    },
    {
      id: "im14-armor-init",
      from: "- 初始化生成防具时，必须为每件防具指定 护甲槽位；只有走完整战斗装备门槛时才强制补齐 armor/inner/head/hands/legs/feet 六件防具",
      to: "- 初始化生成防具时，必须为每件防具指定 equipmentRole（head / body / legs / accessory 之一）；只有走完整战斗装备门槛时才要求尽量补齐 head / body / legs / accessory 四格，每格至多一件"
    },
    {
      id: "im14-tech-init",
      from: "- 初始化生成功法时，必须为每本功法指定 numeric.subtype`，并按 subtype 装备到对应 technique 专槽。天骄必须创建并装备 spell/weapon/body/shenshi/movement/craft 六类功法；非天骄不得机械填满，数量要与其财富、师承、宗门地位、机缘和剧情证据匹配。",
      to: "- 初始化生成功法时，必须为每本功法指定 equipmentRole（main/body/spirit/craft 之一），并按该值装备到对应 technique 专槽。天骄必须创建并装备 main/body/spirit/craft 四类功法；非天骄不得机械填满，数量要与其财富、师承、宗门地位、机缘和剧情证据匹配。"
    },
    {
      id: "im14-flying-init",
      from: "- 新NPC初始化不默认生成飞行法宝；只有境界、身份、长期出行职责、天骄待遇或剧情证据足以支持其拥有个人御空器物时，才可生成飞行法宝；神识容量允许时装备到 treasure 槽，否则留在背包。普通核心法宝不得占用 #6。",
      to: "- 新NPC初始化不默认生成飞行法宝；只有境界、身份、长期出行职责、天骄待遇或剧情证据足以支持其拥有个人御空器物时，才可生成飞行法宝；神识容量允许时装备到 treasure index 1-5（飞行法宝也是普通法宝），否则留在背包。普通核心法宝不得占用 index 0（本命位）。"
    },
    {
      id: "im14-natal-candidate",
      from: "- treasure #1(槽位序号=0) 仅是本命候选位，放入普通法宝不会自动绑定。活着且结丹及以上的 NPC 可选择自己第一格的普通法宝绑定，每人最多一件；不得替玩家自动绑定。",
      to: "- treasure index 0 是本命法宝位，只有物品自身带 isNatal:true 或 equipmentRole:\"natal\" 或名称/类型明确写作\"本命\"时才可占用；放入普通法宝不会自动绑定，也不得因此认定为本命。活着且结丹及以上的 NPC 可选择自己 index 1-5 中的一件普通法宝绑定，每人最多一件；不得替玩家自动绑定。"
    },
    /* ── im-16 ── */
    {
      id: "im16-treasure-six",
      from: "- 法宝槽中 treasure 槽（`槽位序号:5`）固定预留给飞行法宝。普通法宝只检查和补入 treasure #1-#5（`槽位序号:0-4`）；不得为了满槽把普通法宝塞进 #6。",
      to: "- 法宝槽中 treasure index 0 是本命位，只有明确本命证据才可占用；飞行法宝与普通法宝同属普通法宝，只检查和补入 treasure index 1-5；不得为了满槽把普通法宝塞进 index 0。"
    },
    {
      id: "im16-treasure-audit",
      from: "- 若 treasure 槽 当前已装备普通法宝，必须在审计中尝试把它移到 #1-#5 空槽；没有空槽则卸下回背包。若没有飞行法宝候选，#6 可以保持空着。",
      to: "- 若 treasure index 0 当前已装备普通法宝，必须在审计中尝试把它移到 index 1-5 空槽；没有空槽则卸下回背包。若没有本命法宝候选，index 0 可以保持空着。"
    },
    {
      id: "im16-technique-six",
      from: "- 功法作为特殊装备不占用神识容量，但 technique 只有六个专槽：`0` 法修(spell)、`1` 兵器(weapon)、`2` 炼体(body)、`3` 神识(shenshi)、`4` 遁术(movement)、`5` 百艺(craft)。新功法必须写 numeric.subtype` 并只能补入对应专槽；未写 subtype 的既有功法是未分类旧功法，可沿用或整理到任意 technique 0-5，但不要按旧格式新建。",
      to: "- 功法作为特殊装备不占用神识容量，但 technique 只有四个专槽：`0` 主修(main)、`1` 炼体(body)、`2` 神识(spirit)、`3` 百艺(craft)。新功法必须写 equipmentRole 并只能补入对应专槽；未写 equipmentRole 的既有功法是未分类旧功法，可沿用或整理到任意 technique 0-3，但不要按旧格式新建。"
    },
    {
      id: "im16-empty-check",
      from: "- 输出结束前，必须逐项检查 `technique 0-5` 六个专槽、`treasure 0-5`、`accessory 0-5` 是否仍有空槽。",
      to: "- 输出结束前，必须逐项检查 `technique 0-3` 四个专槽、`treasure 0-5`（0 为本命位，1-5 普通）、`accessory 0-5` 是否仍有空槽。"
    },
    {
      id: "im16-empty-fill",
      from: "- 若存在空槽，且背包里有无明确场景冲突、槽位匹配、装备后不超神识容量的同类候选物，就必须输出带 `槽位序号` 的 `equipItem`，或输出可直接定位槽位的 `eq.` 短指令；功法短指令可写 `technique:<subtype>:<itemId>`，subtype 只允许 `spell/weapon/body/shenshi/movement/craft`。“同类候选物”必须先通过上述分类边界，不能把重要物品当饰品、不能把技能当功法、不能把普通法宝当飞行法宝；超额物品留在背包。",
      to: "- 若存在空槽，且背包里有无明确场景冲突、槽位匹配、装备后不超神识容量的同类候选物，就必须输出带 `index` 的 `equipItem`，或输出可直接定位槽位的 `eq.` 短指令；功法短指令可写 `technique:<equipmentRole>:<itemId>`，equipmentRole 只允许 `main/body/spirit/craft`。“同类候选物”必须先通过上述分类边界，不能把重要物品当饰品、不能把技能当功法、不能把普通法宝当飞行法宝；超额物品留在背包。"
    },
    {
      id: "im16-example",
      from: "- 《青叶飞梭》若为个人飞行法宝且装备后不超神识容量，应补入 treasure 槽；超额留在背包。《摄魂铃》《金光盾》这类普通法宝即使轻便，也只能补入 `treasure #1-#5`。",
      to: "- 《青叶飞梭》若为个人飞行法宝且装备后不超神识容量，应补入 treasure index 1-5；超额留在背包。《摄魂铃》《金光盾》这类普通法宝即使轻便，也只能补入 `treasure index 1-5`。"
    },
    {
      id: "im16-example2",
      from: "- 《金身诀》若 numeric.subtype:\"body\"`，只能补入 `technique #3(槽位序号=2)`；若为本批次 createItem 获得，直接 equipItem 到 C1 的 technique 槽。《大衍炼神诀》若 `subtype:\"shenshi\"`，只能补入 `technique #4(槽位序号=3)`。",
      to: "- 《金身诀》若 equipmentRole:\"body\"，只能补入 `technique index 1`；若为本批次 createItem 获得，直接 equipItem 到 C1 的 technique 槽。《大衍炼神诀》若 equipmentRole:\"spirit\"，只能补入 `technique index 2`。"
    },
    {
      id: "im16-flying-subtype",
      from: "法宝用途以 物品对象.特殊子类 为准：general（普通，省略时同义）/ flying（飞行）。仅 category=法宝 可写此字段；flying 必须 类型=equipment 且 加成方向 含 speed，只能进入 treasure 槽，不得绑定本命；general 仅能进入 #1-#5。numeric.artifactTier 仍只表示器类位格。不得凭名称或速度词条把未分类法宝当作 flying；已有物品需有明确用途证据才可 refreshItemData 补写子类。",
      to: "法宝用途以 物品对象.特殊子类 为准：general（普通，省略时同义）/ flying（飞行）。仅 category=法宝 可写此字段；flying 必须 类型=equipment 且 加成方向 含 speed，只能进入 treasure index 1-5，不得绑定本命；general 同样只能进入 index 1-5。numeric.artifactTier 仍只表示器类位格。不得凭名称或速度词条把未分类法宝当作 flying；已有物品需有明确用途证据才可 refreshItemData 补写子类。"
    },
    /* ── im-17 ── */
    {
      id: "im17-check3",
      from: "3. numeric.subtype` 是否存在且为 `spell/weapon/body/shenshi/movement/craft` 之一；新功法缺 subtype 必须补上，只有旧存量可标为未分类旧功法。",
      to: "3. equipmentRole 是否存在且为 `main/body/spirit/craft` 之一；新功法缺 equipmentRole 必须补上，只有旧存量可标为未分类旧功法。"
    },
    {
      id: "im17-check4",
      from: "4. subtype 与功法主题是否一致：法修=spell，兵器/剑诀/刀法/枪诀/弓术/棍法/飞剑=weapon，炼体=body，神识/炼神=shenshi，身法/遁术=movement，炼丹/炼器/符阵/百艺=craft。",
      to: "4. equipmentRole 与功法主题是否一致：法修/剑诀/刀法/枪诀/弓术/棍法/飞剑等主修传承=main，炼体=body，神识/炼神=spirit，身法/遁术=body（归入炼体与身法一体，不单设槽），炼丹/炼器/符阵/百艺=craft。"
    },
    {
      id: "im17-check7",
      from: "7. 每段 `realmEffects[].加成方向` 是否能回扣 subtype 与功法主题，且只从候选属性枚举中选择，不含权重、倍率或手算数值；每段条数不得超过 品质 上限。",
      to: "7. 每段 `realmEffects[].加成方向` 是否能回扣 equipmentRole 与功法主题，且只从候选属性枚举中选择，不含权重、倍率或手算数值；每段条数不得超过 品质 上限。"
    },
    /* ── im-18 ── */
    {
      id: "im18-flying-def",
      from: "- 若出现飞舟、飞梭、云帕、御空飞剑、飞轮、遁光葫芦或任何可载人飞遁器物，必须先判定它是个人可长期驱使的飞行法宝、普通法宝、技能/遁术，还是场景交通工具；只有个人飞行法宝才可作为 `法宝` createItem，并固定装备到 treasure 槽。",
      to: "- 若出现飞舟、飞梭、云帕、御空飞剑、飞轮、遁光葫芦或任何可载人飞遁器物，必须先判定它是个人可长期驱使的飞行法宝、普通法宝、技能/遁术，还是场景交通工具；只有个人飞行法宝才可作为 `法宝` createItem，并装备到 treasure index 1-5（飞行法宝属普通法宝，无专属槽位）。"
    },
    {
      id: "im18-armor-six",
      from: "- 完整战斗装备：按身份资源生成 1 件武器 + 护甲槽位 = armor / inner / head / hands / legs / feet 六件防具；只装备神识容量允许的部分，超额留在背包；不要求 cloak（披风）和 accessory（饰品），underwear 不作为防具初始化要求。",
      to: "- 完整战斗装备：按身份资源生成 1 件武器 + 至多 4 件防具（equipmentRole = head / body / legs / accessory，每格至多一件）；只装备神识容量允许的部分，超额留在背包；不要求把四格全部填满。"
    },
    {
      id: "im18-subtype-normal",
      from: "- 普通新建NPC功法数量按具体情况决定：贫穷散修/凡人/杂役可 0-1 本；普通宗门弟子通常 1 本；背景较好者可 2-4 本；每本新功法必须写 numeric.subtype` 并装备到对应 technique 专槽。",
      to: "- 普通新建NPC功法数量按具体情况决定：贫穷散修/凡人/杂役可 0-1 本；普通宗门弟子通常 1 本；背景较好者可 2-3 本；每本新功法必须写 equipmentRole 并装备到对应 technique 专槽。"
    },
    {
      id: "im18-prodigy-tech",
      from: "- 天骄新建NPC：适用完整战斗装备，且必须创建并装备六类功法 `spell/weapon/body/shenshi/movement/craft`；装备稀有度必须明显高于普通NPC：品阶通常高半档到一档，品质 以 xuan/di 为主，核心武器、主甲或核心功法可 tian；有强来源时必须写清家族/宗门/师承/机缘来源与限制。",
      to: "- 天骄新建NPC：适用完整战斗装备，且必须创建并装备四类功法 `main/body/spirit/craft`（equipmentRole）；装备稀有度必须明显高于普通NPC：品阶通常高半档到一档，品质 以 xuan/di 为主，核心武器、主甲或核心功法可 tian；有强来源时必须写清家族/宗门/师承/机缘来源与限制。"
    },
    {
      id: "im18-armor-role",
      from: "- 每件新建防具都必须同步确定 护甲槽位",
      to: "- 每件新建防具都必须同步确定 equipmentRole（head / body / legs / accessory 之一）"
    },
    {
      id: "im18-tech-role",
      from: "- 每件新建功法定义都必须同步确定 类型=\"technique\"、品质档、品质、subtype 与至少一段合法 第8列 hint；可选 神识限制.shenshiCapTier，加成方向 必须回扣 subtype，equipItem 必须引用实例 @i 并写对应 technique 槽位序号。",
      to: "- 每件新建功法定义都必须同步确定 类型=\"technique\"、品质档、品质、equipmentRole 与至少一段合法 第8列 hint；可选 神识限制.shenshiCapTier，加成方向 必须回扣 equipmentRole，equipItem 必须引用实例 @i 并写对应 technique index。"
    },
    {
      id: "im18-weapon-subtype",
      from: "- 新 NPC 初始化武器、法宝与兵器功法时，必须先按角色身份、门派、灵根、职责、地域、资源来源和剧情定位决定器类；不得因为主角当前使用某类法器或主修某类功法，就镜像生成同类器物或同类功法。兵器 subtype 只能写 `weapon`，可表现为剑、刀、枪、戟、弓、锤、棍、鞭、针等不同兵器；没有明确剑修证据时不要默认写剑诀、飞剑或剑阵。",
      to: "- 新 NPC 初始化武器、法宝与兵器功法时，必须先按角色身份、门派、灵根、职责、地域、资源来源和剧情定位决定器类；不得因为主角当前使用某类法器或主修某类功法，就镜像生成同类器物或同类功法。兵器向功法 equipmentRole 写 `main`，可表现为剑、刀、枪、戟、弓、锤、棍、鞭、针等不同兵器；没有明确剑修证据时不要默认写剑诀、飞剑或剑阵。"
    },
    {
      id: "im18-array-subtype",
      from: "- 每件新建阵具定义都必须同步确定 类型=\"array\"、品质档、品质、阵具用途、作用对象、作用范围、持续回合、最大充能、充能消耗 与 subtype；聚灵闭关阵具还必须写 聚灵加成。动态 currentCharge 不得写入 物品对象。",
      to: "- 每件新建阵具定义都必须同步确定 类型=\"array\"、品质档、品质、阵具用途、作用对象、作用范围、持续回合、最大充能、充能消耗；聚灵闭关阵具还必须写 聚灵加成。动态 currentCharge 不得写入 物品对象。"
    },
    {
      id: "im18-init-summary",
      from: "- 新角色初始化：角色ID → 初始化门槛（轻量/完整战斗/天骄）→ 创建的武器、防具 护甲槽位、功法数量/各 subtype/物品清单摘要；若走轻量，说明不补满六防具的依据",
      to: "- 新角色初始化：角色ID → 初始化门槛（轻量/完整战斗/天骄）→ 创建的武器、防具 equipmentRole、功法数量/各 equipmentRole/物品清单摘要；若走轻量，说明不补满四格防具的依据"
    },
    {
      id: "im18-audit-line",
      from: "- 天骄稀有度审计：若是天骄，逐项说明武器/防具的 品质档 与 品质、六类功法的 subtype/品质档/品质 与来源为什么明显高于普通NPC；若不是天骄，说明为什么按轻量或普通战斗尺度处理",
      to: "- 天骄稀有度审计：若是天骄，逐项说明武器/防具的 品质档 与 品质、四类功法的 equipmentRole/品质档/品质 与来源为什么明显高于普通NPC；若不是天骄，说明为什么按轻量或普通战斗尺度处理"
    },
    {
      id: "im18-treasure-audit",
      from: "- 法宝槽检查必须分两类：普通法宝只检查 treasure #1-#5(槽位序号 0-4)；飞行法宝只检查 treasure 槽(槽位序号 5)。#6 没有飞行法宝候选时允许空着，不得用普通法宝补满。",
      to: "- 法宝槽检查必须分两类：普通法宝（含飞行法宝）只检查 treasure index 1-5；本命位 index 0 只接受物品自身 isNatal:true 或 equipmentRole:\"natal\" 或名称/类型明确写作\"本命\"的本命法宝。index 0 没有本命法宝候选时允许空着，不得用普通法宝补满。"
    },
    {
      id: "im18-selfconsistent",
      from: "- equipItem/unequipItem 必须与 createItem 的结构化装备字段自洽：护甲槽位 不得缺失或冲突，披风/斗篷不得误写 inner，内衣/肚兜/胸衣/bra/内裤/情趣内衣不得误写 inner/accessory/treasure，单手武器必须给 持握手，双手武器不得给 持握手",
      to: "- equipItem/unequipItem 必须与 createItem 的结构化装备字段自洽：equipmentRole 不得缺失或冲突，披风/斗篷/内衣/肚兜/胸衣/bra/内裤/情趣内衣一律写 body，不得写成 accessory/treasure；武器恒为 index 0，不需 持握手 字段"
    },
    {
      id: "im18-check-line",
      from: "- 对每个发生装备变动或拥有功法/法宝/饰品候选的角色，逐项写出：`角色ID -> technique六专槽(spell/weapon/body/shenshi/movement/craft)当前占用/空槽/匹配候选/剔除的skill伪功法/是否补位；treasure普通槽#1-#5空槽/普通法宝候选/是否补位；treasure飞行专槽#6当前占用/飞行法宝候选/是否装备或清空普通法宝；accessory空槽/候选/剔除的重要物品伪饰品/是否补位`",
      to: "- 对每个发生装备变动或拥有功法/法宝/饰品候选的角色，逐项写出：`角色ID -> technique四专槽(main/body/spirit/craft)当前占用/空槽/匹配候选/剔除的skill伪功法/是否补位；treasure本命位index 0占用/本命证据；treasure普通槽index 1-5空槽/普通法宝候选（含飞行法宝）/是否补位；accessory空槽/候选/剔除的重要物品伪饰品/是否补位`"
    },
    {
      id: "im18-compat-template",
      from: "- 兼容性简写模板也必须能在审计中对应体现：`角色ID -> technique专槽空缺与 subtype 候选/剔除的skill伪功法/是否补位；treasure空槽/候选/是否补位；accessory空槽/候选/剔除的重要物品伪饰品/是否补位`",
      to: "- 兼容性简写模板也必须能在审计中对应体现：`角色ID -> technique专槽空缺与 equipmentRole 候选/剔除的skill伪功法/是否补位；treasure本命位与普通槽位空槽/候选/是否补位；accessory空槽/候选/剔除的重要物品伪饰品/是否补位`"
    },
    {
      id: "im18-tech-review",
      from: "- 功法/法宝/饰品复核：若这些槽位仍空着，且背包里还有无冲突候选，必须优先考虑补位；功法只能补入 subtype 匹配的 technique 专槽。禁止只调整防具后直接结束",
      to: "- 功法/法宝/饰品复核：若这些槽位仍空着，且背包里还有无冲突候选，必须优先考虑补位；功法只能补入 equipmentRole 匹配的 technique 专槽。禁止只调整防具后直接结束"
    },
    {
      id: "im18-flying-review",
      from: "- 飞行法宝专槽复核：treasure 槽 只能保留飞行法宝；若当前或最终操作把普通法宝放在 #6，必须改为 #1-#5 或卸下。飞行法宝的 createItem 必须归类 `法宝`，numeric.primaryStats` 必含 `speed`，神识容量允许才输出 equipItem，且必须写 `槽位序号:5`，否则留在背包。",
      to: "- 法宝槽复核：treasure index 1-5 放普通法宝（含飞行法宝），index 0 只放有明确本命证据的本命法宝；若当前或最终操作把普通法宝放在 index 0，必须改为 index 1-5 或卸下。飞行法宝的 createItem 必须归类 `法宝`，numeric.primaryStats` 必含 `speed`，神识容量允许才输出 equipItem，且必须写 index 1-5 之一，否则留在背包。"
    },
    /* ── im-19 ── */
    {
      id: "im19-armor-six",
      from: "- 战斗型、敌对、护卫、猎杀、执法、斗法相关，或天骄/核心弟子/长老/同阶强敌等高权重 NPC，按身份资源创建 1 件武器 + 六件防具：armor（主甲/法衣主体）、inner（内甲/护身内层）、head（冠/盔/发簪类头部防护）、hands（护腕/手甲）、legs（腿甲/裙甲/护膝）、feet（靴）；只装备神识容量允许且槽位匹配的部分，超额留在背包。",
      to: "- 战斗型、敌对、护卫、猎杀、执法、斗法相关，或天骄/核心弟子/长老/同阶强敌等高权重 NPC，按身份资源创建 1 件武器 + 至多 4 件防具：equipmentRole head（冠/盔/发簪类头部防护）、body（主甲/法衣主体/内甲/护身内层/护腕手甲/靴）、legs（腿甲/裙甲/护膝）、accessory（佩饰）；只装备神识容量允许且部位匹配的部分，超额留在背包；每格至多一件。"
    },
    {
      id: "im19-no-accessory",
      from: "- 不强制创建饰品/accessory、法宝/treasure、披风/cloak；不要为了凑数把身份令牌、地图、任务凭证写成饰品。",
      to: "- 不强制创建饰品/accessory 格、法宝/treasure 格；不要为了凑数把身份令牌、地图、任务凭证写成饰品。"
    },
    {
      id: "im19-prodigy-tech",
      from: "- 功法数量必须按 NPC 具体情况决定：贫穷散修、凡人、临时杂役可只有 0-1 本甚至没有；普通宗门弟子通常 1 本；背景较好的修士可有 2-4 本；天骄必须创建并装备六类功法 `spell/weapon/body/shenshi/movement/craft`。每本新功法必须写 numeric.subtype` 并装备到对应 technique 专槽。",
      to: "- 功法数量必须按 NPC 具体情况决定：贫穷散修、凡人、临时杂役可只有 0-1 本甚至没有；普通宗门弟子通常 1 本；背景较好的修士可有 2-3 本；天骄必须创建并装备四类功法 `main/body/spirit/craft`（equipmentRole）。每本新功法必须写 equipmentRole 并装备到对应 technique 专槽。"
    },
    {
      id: "im19-six-slots",
      from: "- 必须填满六个功法专槽：槽位序号 0 法修(spell)、1 兵器(weapon)、2 炼体(body)、3 神识(shenshi)、4 遁术(movement)、5 百艺(craft)，且 `realmEffects[].加成方向` 与 subtype 方向一致。兵器槽可承载剑、刀、枪、棍、弓、锤、鞭、针等兵器向传承；不得无证据地默认写成剑诀或飞剑。",
      to: "- 功法专槽共四个：index 0 主修(main)、1 炼体(body)、2 神识(spirit)、3 百艺(craft)，且 `realmEffects[].加成方向` 与 equipmentRole 方向一致；天骄应尽量填满，非天骄按证据决定。剑、刀、枪、棍、弓、锤、鞭、针等兵器向传承归入 0 主修；不得无证据地默认写成剑诀或飞剑。"
    },
    /* ── im-20 ── */
    {
      id: "im20-armor-boundary",
      from: "护甲槽位 语义边界：inner 只用于可推断为主甲下方轻薄副防具、隐蔽护身内层或与外层主甲并存的补充防护；主体躯干/全身防具应写 `armor`。",
      to: "equipmentRole 语义边界：只有 head / body / legs / accessory 四个合法值；主体躯干/全身防具、内层薄甲、护腕手甲、披风斗篷、内衣一律写 `body`。 战靴鞋履足甲写 equipmentRole=legs。"
    },
    {
      id: "im20-flying-noslot",
      from: "本系统没有飞行法宝专槽，飞行法宝同样进 treasure 槽，加成属性写\"脚力\"。",
      to: "本系统没有飞行法宝专槽，飞行法宝同样进 treasure index 1-5（属普通法宝），加成属性写\"脚力\"。"
    },
    {
      id: "im20-no-subtype",
      from: "本系统功法不分 subtype，直接用 technique 槽；侧重方向用第8列的倍率表达。",
      to: "本系统功法用 equipmentRole 区分（main/body/spirit/craft），对应 technique index 0/1/2/3；侧重方向用第8列的倍率表达。"
    },
    {
      id: "im20-shortcmd",
      from: "功法装备短指令注意：功法可用 `eq.<owner> = technique:<subtype>:<itemId>|原因` / `uneq.<owner> = technique:<subtype>:<itemId>|原因`，其中 subtype 只允许 `spell/weapon/body/shenshi/movement/craft`，并分别对应 technique `槽位序号` 0/1/2/3/4/5；也可继续使用 `technique:#1` 至 `technique:#6` 明确槽位。",
      to: "功法装备短指令注意：功法可用 `eq.<owner> = technique:<equipmentRole>:<itemId>|原因` / `uneq.<owner> = technique:<equipmentRole>:<itemId>|原因`，其中 equipmentRole 只允许 `main/body/spirit/craft`，并分别对应 technique index 0/1/2/3；也可继续使用 `technique:#1` 至 `technique:#4` 明确槽位。"
    },
    {
      id: "im20-flying",
      from: "飞行法宝注意：不要输出 `飞行法宝` 作为分类；分类仍写 `法宝`，物品对象 顶层必须写 `飞行法宝（第4列加成写脚力）`。飞行法宝装备时必须写 `slot:\"treasure\", 槽位序号:5`，普通法宝不得占用 `槽位序号:5`。",
      to: "飞行法宝注意：不要输出 `飞行法宝` 作为分类；分类仍写 `法宝`，物品对象 顶层必须写 `飞行法宝（第4列加成写脚力）`。飞行法宝与普通法宝一样装备时必须写 `slot:\"treasure\", index:1-5`，普通法宝和飞行法宝都不得占用 index 0（本命位）。"
    },
    /* ── shared-item-domain-contract ── */
    {
      id: "shared-tech-subtype",
      from: "- `technique.subtype=\"spell\"` 表示法修类长期功法槽，不表示任意主动法术。不得因为能力名含“诀/术/法”或使用法力，就把它归入该槽。",
      to: "- `technique` 的 equipmentRole=\"main\" 表示主修类长期功法槽（含法修、剑诀、刀法、枪诀等），不表示任意主动法术。不得因为能力名含“诀/术/法”或使用法力，就把它归入该槽。"
    },
    {
      id: "shared-realm-effect",
      from: "- `realmEffects`：功法专用语义 hint，每段可包含 `unlockRealm`、`description`、`加成属性` 和可选 `breakthrough`；不要在其中手写完整层表、倍率表、预算或每层数值。实际数值由代码按已激活境界段独立结算。新生成的功法至少写一段合法 hint：`unlockRealm` 不得超过该功法品阶对应的境界上限，`description` 必须具体可读，`加成属性` 至少包含一个合法且与 subtype 匹配的属性方向。",
      to: "- `realmEffects`：功法专用语义 hint，每段可包含 `unlockRealm`、`description`、`加成属性` 和可选 `breakthrough`；不要在其中手写完整层表、倍率表、预算或每层数值。实际数值由代码按已激活境界段独立结算。新生成的功法至少写一段合法 hint：`unlockRealm` 不得超过该功法品阶对应的境界上限，`description` 必须具体可读，`加成属性` 至少包含一个合法且与 equipmentRole 匹配的属性方向。"
    },
    {
      id: "shared-subtype-enum",
      from: "- 新生成的功法必须写 `numeric.subtype`，只允许：`spell` 法修 / `weapon` 兵器 / `body` 炼体 / `shenshi` 神识 / `movement` 遁术 / `craft` 百艺。未写 subtype 的既有功法是未分类旧功法，只用于兼容旧存量，不得作为新功法格式。",
      to: "- 新生成的功法必须写 equipmentRole，只允许：`main` 主修（法修/兵器/剑诀刀法等主修传承）/ `body` 炼体（含身法遁术）/ `spirit` 神识 / `craft` 百艺。未写 equipmentRole 的既有功法是未分类旧功法，只用于兼容旧存量，不得作为新功法格式。"
    },
    {
      id: "shared-subtype-dir",
      from: "- 功法 subtype 决定默认属性方向：`spell` 偏 `magAtk/magPen/mp/cultivationSpeed`；`weapon` 偏 `physAtk/magAtk/physPen/cultivationSpeed`；`body` 偏 `hp/physDef/physAtk/magDef`；`shenshi` 偏 `shenshi/mp/magDef/cultivationSpeed`；`movement` 偏 `speed/physPen/shenshi/cultivationSpeed`；`craft` 偏 `cultivationSpeed/shenshi/luck/mp`。每段 `realmEffects[].加成属性` 可以按具体主题微调，但必须能回扣 subtype。",
      to: "- 功法 equipmentRole 决定默认属性方向：`main` 偏 `magAtk/magPen/mp/cultivationSpeed`（兵器向主修可偏 `physAtk/physPen`）；`body` 偏 `hp/physDef/physAtk/magDef`（身法向可偏 `speed`）；`spirit` 偏 `shenshi/mp/magDef/cultivationSpeed`；`craft` 偏 `cultivationSpeed/shenshi/luck/mp`。每段 `realmEffects[].加成属性` 可以按具体主题微调，但必须能回扣 equipmentRole。"
    },
    {
      id: "shared-armor-slots",
      from: "- 防具必须显式输出 护甲槽，只允许：`armor` / `inner` / `head` / `hands` / `legs` / `feet` / `cloak` / `underwear`。",
      to: "- 防具必须显式输出 equipmentRole，只允许：`head`（头部）/ `body`（身体）/ `legs`（腿部）/ `accessory`（饰品）。"
    },
    {
      id: "shared-armor-detail",
      from: "- 防具部位按装备形态与用途判断：主体躯干/全身防具写 `armor`；轻薄副防具或能与主甲并存的内层写 `inner`；头部防护写 `head`；手甲/护腕/盾类写 `hands`；护腿/腿甲/胫甲/膝甲/丝袜/长袜/连裤袜写 `legs`；战靴/鞋履/足甲写 `feet`；披风斗篷写 `cloak`；内衣/小衣/肚兜/胸衣/内裤/亵衣写 `underwear`。",
      to: "- 防具部位按装备形态与用途判断：主体躯干/全身防具、轻薄副防具、可与主甲并存的内层、手甲/护腕/盾类、披风斗篷、内衣/小衣/肚兜/胸衣/内裤/亵衣，一律写 `body`；头部防护（冠/盔/发簪/面具）写 `head`；战靴/鞋履/足甲/护腿/腿甲/胫甲/膝甲/丝袜/长袜/连裤袜写 `legs`；佩饰/环佩/镯/链/坠/腰饰写 `accessory`。"
    },
    {
      id: "shared-armor-keyword",
      from: "- 护甲槽 不得按单个关键词命中判断；贴身穿戴、认主绑定、血脉共振、本命温养等语义本身不等于 `inner`，必须结合装备形态、是否主甲、是否可与主甲并存来判定。",
      to: "- equipmentRole 不得按单个关键词命中判断；贴身穿戴、认主绑定、血脉共振、本命温养等语义本身不改变 equipmentRole，必须结合装备形态与主要防护部位判定。"
    },
    {
      id: "shared-armor-notcategory",
      from: "- 装备部位不是分类：防具类物品的具体部位写 护甲槽，不要把“护甲/内甲/头部/披风/内衣/腿部/足部/丝袜”写成 category，也不得把丝袜、内衣写成 `饰品`。",
      to: "- 装备部位不是分类：防具类物品的具体部位写 equipmentRole，不要把“头部/身体/腿部/饰品/内甲/披风/内衣/丝袜”写成 category。"
    },
    {
      id: "shared-armor-nonarmor",
      from: "- 非防具禁止输出 护甲槽；非武器禁止输出 `武器槽`。",
      to: "- 非防具禁止输出 equipmentRole 作为护甲部位；非武器禁止输出 `武器槽`。"
    },
    {
      id: "shared-treasure-general",
      from: "法宝用途以 物品对象.飞行标识 为准：general（普通，省略时同义）/ flying（飞行）。仅 category=法宝 可写此字段；flying 必须 numeric.kind=equipment 且 加成属性 含 speed，只能进入 treasure 槽，不得绑定本命；general 仅能进入 #1-#5。numeric.artifactTier 仍只表示器类位格。不得凭名称或速度词条把未分类法宝当作 flying；已有物品需有明确用途证据才可 updateItem 补写子类。",
      to: "法宝用途以 物品对象.飞行标识 为准：general（普通，省略时同义）/ flying（飞行）。仅 category=法宝 可写此字段；flying 必须 numeric.kind=equipment 且 加成属性 含 speed，只能进入 treasure index 1-5，不得绑定本命；general 同样只能进入 index 1-5。numeric.artifactTier 仍只表示器类位格。不得凭名称或速度词条把未分类法宝当作 flying；已有物品需有明确用途证据才可 updateItem 补写子类。"
    },
    {
      id: "existing-npc-equipment-action",
      from: "AI 正文里单纯出现“穿着、披着、戴着、换了一身”等静态服饰描写，不等于角色实际取得或装备了新物品。只有本轮材料明确写出已经完成的取得、交付、购买、炼制、拾取、收纳或主动装备行为，才允许 createItem / transferItem / equipItem；证据不足时输出无操作。若运行时“严格人设外观锚点”列出 owner，不得自动创建防具/饰品或改变其可见装备。",
      to: "AI 正文的静态服饰描写不证明新取得物品；createItem / transferItem 需真实取得、交付等证据。玩家明确的下一轮装备行动与正文已完成的换装，由物品阶段或合并阶段核对持有和门槛后执行 equipItem；NPC 在本轮处理范围内可从本人已有背包选择更强可用装备补入合法槽位，不要求正文再次描述穿戴。不得虚构物品、替玩家自动换装或绕过严格人设外观锚点。"
    },
    {"id":"boots-role-v3-0","from":"- 若 物品对象 是防具，必须写 equipmentRole；category 统一写“防具”。按装备形态与用途判定：头部防护（冠/盔/发簪/面具）写 head；主体躯干/全身/主甲/法衣/内层薄甲/手甲护腕/战靴鞋履/披风斗篷/内衣小衣肚兜一律写 body；腿部/护腿/胫甲/膝甲/丝袜/长袜/连裤袜写 legs；佩饰/环佩/镯/链/坠/腰饰写 accessory。不得因贴身穿戴、认主绑定、共振或本命温养改变 equipmentRole","to":"- 若 物品对象 是防具，必须写 equipmentRole；category 统一写“防具”。按装备形态与用途判定：头部防护（冠/盔/发簪/面具）写 head；主体躯干/全身/主甲/法衣/内层薄甲/手甲护腕/披风斗篷/内衣小衣肚兜一律写 body；腿部/战靴鞋履/护腿/胫甲/膝甲/丝袜/长袜/连裤袜写 legs；佩饰/环佩/镯/链/坠/腰饰写 accessory。不得因贴身穿戴、认主绑定、共振或本命温养改变 equipmentRole"},
    {"id":"boots-role-v3-1","from":"equipmentRole 语义边界：只有 head / body / legs / accessory 四个合法值；主体躯干/全身防具、内层薄甲、护腕手甲、战靴、披风斗篷、内衣一律写 `body`。","to":"equipmentRole 语义边界：只有 head / body / legs / accessory 四个合法值；主体躯干/全身防具、内层薄甲、护腕手甲、披风斗篷、内衣一律写 `body`。 战靴鞋履足甲写 equipmentRole=legs。"},
    {"id":"boots-role-v3-2","from":"- 防具部位按装备形态与用途判断：主体躯干/全身防具、轻薄副防具、可与主甲并存的内层、手甲/护腕/盾类、战靴/鞋履/足甲、披风斗篷、内衣/小衣/肚兜/胸衣/内裤/亵衣，一律写 `body`；头部防护（冠/盔/发簪/面具）写 `head`；护腿/腿甲/胫甲/膝甲/丝袜/长袜/连裤袜写 `legs`；佩饰/环佩/镯/链/坠/腰饰写 `accessory`。","to":"- 防具部位按装备形态与用途判断：主体躯干/全身防具、轻薄副防具、可与主甲并存的内层、手甲/护腕/盾类、披风斗篷、内衣/小衣/肚兜/胸衣/内裤/亵衣，一律写 `body`；头部防护（冠/盔/发簪/面具）写 `head`；战靴/鞋履/足甲/护腿/腿甲/胫甲/膝甲/丝袜/长袜/连裤袜写 `legs`；佩饰/环佩/镯/链/坠/腰饰写 `accessory`。"}
  ]

  /**
   * 对一条规则文本做旧句迁移。
   * @returns {{text:string, changed:boolean, applied:number}}
   */
  function migrateLegacySentences (text) {
    if (typeof text !== 'string' || !text) return { text: text, changed: false, applied: 0 }
    var out = text
    var applied = 0
    for (var i = 0; i < LEGACY_SENTENCES.length; i += 1) {
      var m = LEGACY_SENTENCES[i]
      if (out.indexOf(m.from) >= 0) {
        out = out.split(m.from).join(m.to)
        applied += 1
      }
    }
    return { text: out, changed: out !== text, applied: applied }
  }

  /**
   * 遍历预设内所有规则对象（不限容器），对其 content 做旧句迁移。
   * 就地改写传入对象；关闭状态、id、name、顺序全部不动。
   */
  function migratePresetInPlace (preset) {
    var migrated = []
    var seen = typeof Set === 'function' ? new Set() : null
    function visit (node) {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i += 1) {
          var rule = node[i]
          if (rule && typeof rule === 'object' && typeof rule.content === 'string') {
            if (seen && seen.has(rule)) continue
            if (seen) seen.add(rule)
            var r = migrateLegacySentences(rule.content)
            if (r.changed) {
              rule.content = r.text
              migrated.push({ id: rule.id || '(no-id)', applied: r.applied })
            }
          } else {
            visit(rule)
          }
        }
        return
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) visit(node[k])
      }
    }
    visit(preset)
    return migrated
  }

  /* ── 投影 ───────────────────────────────────────────────────── */

  /** 构造一条受控规则对象。enabled 显式 true（本模块不复活关闭的组，但新增规则本身是启用的）。 */
  function makeRule (id, name, content) {
    return { id: id, name: name, content: CONTRACT_MARKER + '\n' + content, enabled: true }
  }

  /**
   * 在 rules 数组里装一条受控规则，遵守去重与"不吞自定义"约定。
   * 返回 { added:boolean, replacedOwn:boolean, warning:string|null }
   */
  function installRule (rules, id, name, content) {
    // 标记可以随用户尾注一起保留，不能证明整条内容仍是发布原文。
    var fullContent = CONTRACT_MARKER + '\n' + content
    var ownedId = function (value) { return value === id || String(value || '').indexOf(id + '-alt') === 0 }
    var exact = rules.findIndex(function (row) { return row && ownedId(row.id) && row.content === fullContent })
    if (exact >= 0) {
      for (var i = rules.length - 1; i > exact; i -= 1) {
        if (rules[i] && ownedId(rules[i].id) && rules[i].content === fullContent) rules.splice(i, 1)
      }
      return { added: false, replacedOwn: false, warning: null }
    }
    var chosen = id, suffix = 0
    while (rules.some(function (row) { return row && row.id === chosen })) {
      suffix += 1; chosen = id + '-alt' + (suffix > 1 ? '-' + suffix : '')
    }
    rules.push(makeRule(chosen, name + (suffix ? '（受控副本）' : ''), content))
    return { added: true, replacedOwn: false, warning: suffix ? 'same_id_user_modified:' + id : null }
  }

  /**
   * 把装备命名槽位合同投影进一套预设。
   *
   * @param {object} preset      预设对象（不会被修改；返回深拷贝）
   * @param {object} layoutCore  真实核心模块
   * @returns {object} 投影后的**新**预设对象
   */
  function frAdaptEquipmentLayoutRules (preset, layoutCore) {
    if (!isObject(preset)) throw new Error('frAdaptEquipmentLayoutRules: preset 必须是对象')
    /* 核心先验一次，缺核心立刻抛错（不能让调用方静默拿到没有合同的预设） */
    slotsOf(layoutCore, 'weapon')

    var out = deepClone(preset)

    /* 1) 旧发布句迁移：在深拷贝上进行，绝不改动传入的 preset。
       只替换逐字匹配的已知旧句，自定义前后文/尾注/未知近似句原样保留；
       关闭状态、id、顺序均不动。放在其它投影之前，
       这样后续合同注入看到的是已统一的文本。 */
    var migrated = migratePresetInPlace(out)

    var personalContract = frEquipmentSlotContract(layoutCore, 'personal')
    var itemsContract = frEquipmentSlotContract(layoutCore, 'items')
    var report = {
      warnings: [],
      addedRules: [],
      dedupedRules: [],
      keptUserRules: [],
      migratedLegacyRules: migrated
    }

    /* 1) 人物组：启用且存在的 player/npc/beast 各加一条 personal 合同 */
    var prompts = isObject(out.prompts) ? out.prompts : null
    if (prompts) {
      for (var gi = 0; gi < PERSONAL_GROUPS.length; gi += 1) {
        var groupKey = PERSONAL_GROUPS[gi]
        var group = prompts[groupKey]
        if (!isObject(group)) continue            /* 不存在就不凭空创建 */
        if (group.enabled === false) continue      /* 关闭的组不复活 */
        if (!Array.isArray(group.rules)) continue

        var pr = installRule(group.rules, PERSONAL_RULE_ID, '装备命名槽位（人物阶段只读）', personalContract)
        if (pr.added) report.addedRules.push(groupKey + ':' + PERSONAL_RULE_ID)
        if (pr.replacedOwn) report.dedupedRules.push(groupKey + ':' + PERSONAL_RULE_ID)
        if (pr.warning) report.warnings.push(groupKey + ':' + pr.warning)
      }
    }

    /* 2) itemSharedRules：追加 items 合同 */
    if (!Array.isArray(out.itemSharedRules)) out.itemSharedRules = []
    var ir = installRule(out.itemSharedRules, ITEMS_RULE_ID, '装备命名槽位（物品阶段）', itemsContract)
    if (ir.added) report.addedRules.push('itemSharedRules:' + ITEMS_RULE_ID)
    if (ir.replacedOwn) report.dedupedRules.push('itemSharedRules:' + ITEMS_RULE_ID)
    if (ir.warning) report.warnings.push('itemSharedRules:' + ir.warning)

    /* 3) merged_variables：仅在已存在且启用时追加（full 两套不凭空产生合并组；关闭的组不复活） */
    if (prompts && isObject(prompts.merged_variables) &&
        Array.isArray(prompts.merged_variables.rules) &&
        prompts.merged_variables.enabled !== false) {
      var mr = installRule(prompts.merged_variables.rules, MERGED_RULE_ID,
        '装备命名槽位（合并阶段）', itemsContract)
      if (mr.added) report.addedRules.push('merged_variables:' + MERGED_RULE_ID)
      if (mr.replacedOwn) report.dedupedRules.push('merged_variables:' + MERGED_RULE_ID)
      if (mr.warning) report.warnings.push('merged_variables:' + mr.warning)
    }

    /* 4) meta：用独立标记，不抢占 frPresetCompat 的其他标记 */
    if (!isObject(out.meta)) out.meta = {}
    out.meta[META_KEY] = CONTRACT_VERSION
    /* 旧句迁移版本：独立键，便于将来判断这份预设是否已按当前迁移表处理过 */
    out.meta[MIGRATION_META_KEY] = MIGRATION_VERSION

    /* 把本次投影的告警挂到 meta（独立子对象，不覆盖既有标记） */
    if (report.warnings.length) {
      if (!isObject(out.meta.equipmentLayoutWarnings)) out.meta.equipmentLayoutWarnings = {}
      for (var wi = 0; wi < report.warnings.length; wi += 1) {
        var w = report.warnings[wi]
        out.meta.equipmentLayoutWarnings[w] = true
      }
    }

    /* 非枚举返回值：调用方可读，序列化预设不受影响 */
    Object.defineProperty(out, '__equipmentLayoutReport', {
      value: report, enumerable: false, configurable: true, writable: true
    })

    return out
  }

  var api = {
    frEquipmentSlotContract: frEquipmentSlotContract,
    frAdaptEquipmentLayoutRules: frAdaptEquipmentLayoutRules,
    /* 常量暴露给测试与根侧接线用，避免各处重复硬写字符串 */
    EQUIPMENT_PRESET_RULE_IDS: {
      personal: PERSONAL_RULE_ID,
      items: ITEMS_RULE_ID,
      merged: MERGED_RULE_ID
    },
    EQUIPMENT_LAYOUT_META_KEY: META_KEY,
    EQUIPMENT_LAYOUT_VERSION: CONTRACT_VERSION,
    /* 旧句迁移：暴露给测试与根侧接线 */
    EQUIPMENT_RULE_MIGRATION_META_KEY: MIGRATION_META_KEY,
    EQUIPMENT_RULE_MIGRATION_VERSION: MIGRATION_VERSION,
    frMigrateLegacyRuleSentences: migrateLegacySentences,
    frMigratePresetLegacyRulesInPlace: migratePresetInPlace,
    LEGACY_RULE_SENTENCES: LEGACY_SENTENCES
  }

  if (global) {
    global.frEquipmentSlotContract = api.frEquipmentSlotContract
    global.frAdaptEquipmentLayoutRules = api.frAdaptEquipmentLayoutRules
    global.FrEquipmentPreset = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : undefined));
