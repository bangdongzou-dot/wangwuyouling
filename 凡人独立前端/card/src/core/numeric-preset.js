import { numericRulesText, legacyMortalNumericRulesText } from './numeric-realms.js';
function numericRuleSha256(text) {
  var str = String(text == null ? '' : text);
  /* 先按 UTF-8 转字节 */
  var bytes = [];
  for (var i = 0; i < str.length; i += 1) {
    var c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i += 1;
        continue;
      }
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  /* 64 位长度（高 32 位这里按 0 处理，文本远小于 512MB） */
  bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t += 1) {
      w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
    }
    for (t = 16; t < 64; t += 1) {
      var s0 = (((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3)) >>> 0;
      var s1 = (((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t += 1) {
      var S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      var S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  var out = '';
  for (var k = 0; k < 8; k += 1) out += ('00000000' + H[k].toString(16)).slice(-8);
  return out;
}

export const COMPRESSED_NUMERIC_PATCHES = [
  {
    "scope": "sharedRules",
    "id": "rule-8",
    "length": 10244,
    "hash": "d784c335b6fc4d925f89e110e6a1b5be89d8caa363769f395ba9a50bba0b4074",
    "edits": [
      [
        "2. **境界突破** → 只同步境界/修为进度；不手写基础数值",
        "2. **境界突破** → 真实完成才按压缩白值表维护受影响基础值及实际境界/进度，不重算装备/功法/特质加成"
      ]
    ],
    "newLength": 10267,
    "newHash": "9368f161f2cc22bea8d5d514a3e8702ad3e7144bc58d8fac4a6b8d9985da6298"
  },
  {
    "scope": "player",
    "id": "player-supreme-rules",
    "length": 745,
    "hash": "ce6f310ec29db0f781229849ef9c0569d322f94c4ee133f0d34f7af298389bab",
    "edits": [
      [
        "7. **角色数值边界**：禁止写角色白值、HP/MP max；HP/MP 当前资源变化只写 <state> 的 `hp.B1` / `mp.B1` 短指令",
        "7. **角色数值边界**：按压缩白值规则表维护有依据的第11列原始值；HP/MP变化用原生updateAttribute并携带current/max，不写最终加成，不使用失效的路径/短指令。"
      ]
    ],
    "newLength": 763,
    "newHash": "07428222fa019c965f5451bb43fd4ddf2bc3f5def4041c8f418273a902a398bc"
  },
  {
    "scope": "player",
    "id": "player-attr-rules",
    "length": 355,
    "hash": "f20d3a040293572a0d67671beadf21bf452136bb3712860599a6503314d9d1a2",
    "edits": [
      [
        "本阶段不写角色白值、基础数值、HP/MP max 或最终属性。",
        "本阶段只按压缩白值规则表，在新建、补齐真实缺失或已发生永久变化时写第11列白值；不写最终属性，不改无变化的旧值。"
      ],
      [
        "不写角色基础白值或最终属性；装备、功法、Trait、Buff 的 numeric 只保留在对应词条/物品/Buff 字段中。",
        "白值与来源分开：本阶段按表生成有依据的白值；装备给容器公式，功法给第8列，Trait给原生bonus/effects，Buff给第4列；本地统一叠加，禁止回写最终值。"
      ],
      [
        "境界突破只同步境界和修为进度，不手动刷新 HP/MP、攻防、穿透、脚力、修炼速度。",
        "已完成突破可按压缩白值表与真实成长维护受影响的基础值，保留实际资源比例与已有独立成长；未完成突破不改。修炼速度按灵根与独立修炼规则，不随战斗境界抬高。"
      ]
    ],
    "newLength": 435,
    "newHash": "7894d705e0f86a062c09b5311ef07412f93fbf1451050a8a5189ae1ed48d03e4"
  },
  {
    "scope": "player",
    "id": "player-cot-phase1",
    "length": 7369,
    "hash": "81fe9746aca6d56309a307f9294f5e15871796eacfbf72fc5b2a8a60cd0e580d",
    "edits": [
      [
        "不评估或重算角色基础属性、最终属性、HP/MP max。",
        "只在新建、真实缺失或已完成永久变化时按压缩表处理白值；不重算最终属性，不每轮重赋旧值。"
      ]
    ],
    "newLength": 7384,
    "newHash": "0f9d07de13ab1c767e36ad289bd07909687544f4c1c5f4e24735c8331eaaae3f"
  },
  {
    "scope": "player",
    "id": "player-cot-phase1-male",
    "length": 6931,
    "hash": "a50049f406a5bc2f4decdf04505e4499e76bfa98a4e5ee7123f34565bf56293b",
    "edits": [
      [
        "不评估或重算角色基础属性、最终属性、HP/MP max。",
        "只在新建、真实缺失或已完成永久变化时按压缩表处理白值；不重算最终属性，不每轮重赋旧值。"
      ]
    ],
    "newLength": 6946,
    "newHash": "d47c7ebfa46fedac175c9f3ba7f6387840d3e0dc737c3baf108bce76eee637ff"
  },
  {
    "scope": "player",
    "id": "player-cot-phase2",
    "length": 1022,
    "hash": "bcd9b7b7bc4d9c22a854129cffcde2fe903743f9d9fd65f6f644334f28a9b72b",
    "edits": [
      [
        "不查表刷新白值或最终属性。正文明确造成伤势、恢复、消耗时，只输出 <state> 的 `hp.B1` / `mp.B1` 当前值变化；突破、装备、功法、trait、buff 不得带来手写属性数值。",
        "按压缩白值表查真正需要变动的原始属性；正文明确伤势、恢复、消耗时updateAttribute同时给current与原max。装备、功法、trait、buff的加成留在各自来源，不得写回白值。"
      ]
    ],
    "newLength": 1020,
    "newHash": "5d7f4fd3459236104da6ef226f40ccdae56a083f4f5d5658c6fad57314c5e2f8"
  },
  {
    "scope": "player",
    "id": "player-cot-phase4",
    "length": 2366,
    "hash": "b1a2a8d1994d46ed07a0ca284f0970b526a66cd5f8c31186b6e4ab5ca83aa5b9",
    "edits": [
      [
        "| 7 | 手写基础数值 | 输出物攻/法攻/穿透/脚力/修炼速度等角色白值 | 删除，交给 容器体系 |",
        "| 7 | 重复结算 | 把装备/功法/Trait/Buff最终加成写成白值 | 删除重复项；真实新建或永久成长仍按压缩表维护白值 |"
      ]
    ],
    "newLength": 2380,
    "newHash": "1e7ef4c7d98f6fd68c37c5079785a053195475377d5d5ae697f8fc19fd4b4bc2"
  },
  {
    "scope": "player",
    "id": "player-cot-phase4-male",
    "length": 1888,
    "hash": "e89f59e1a3c6a48c0cf562769d9f131da8fd351c9ec6e494183cc366dd966182",
    "edits": [
      [
        "| 7 | 手写基础数值 | 输出物攻/法攻/穿透/脚力/修炼速度等角色白值 | 删除，交给 容器体系 |",
        "| 7 | 重复结算 | 把装备/功法/Trait/Buff最终加成写成白值 | 删除重复项；真实新建或永久成长仍按压缩表维护白值 |"
      ]
    ],
    "newLength": 1902,
    "newHash": "80e4a3ea5a3682c093c0f452c95a9b0a5c206568723078315dc590cffc38de27"
  },
  {
    "scope": "player",
    "id": "rule-49",
    "length": 1427,
    "hash": "bef2c0fcf2382c2deadcd4a641d06f302e2f1c3c6e6ec5d56898f96859b880bc",
    "edits": [
      [
        "所有属性数值由系统结算；你只输出结构化方向（numeric）与明确发生的 HP/MP 当前值变化，不计算、不查表、不补最终数值。",
        "分工：变量按压缩规则表生成和维护有因果依据的白值，提供容器公式、功法、Trait、Buff来源；本地计算最终属性与等效描述。不得生成不支持的numeric/profile引擎，不手算最终加成。"
      ],
      [
        "| B1及所有C.../G... | 是否尝试写角色白值、HP/MP max、物攻/法攻/穿透/脚力/修炼速度等基础数值 | 删除该数值指令 |",
        "| B1及所有C.../G... | 是否无因果重赋白值或把最终加成回写白值 | 删除无依据/重复部分，保留按表的新建、真实补缺和永久成长 |"
      ],
      [
        "不补气运/魅力/修炼速度默认值。剧情永久特质用 addTrait 的 numeric 表达，不能改角色白值。",
        "新建或真正缺失时按对应独立标尺及修炼速度合同生成气运/魅力/修炼速度白值；已存在值不重置。永久特质仍用原生bonus/effects单独记录，不能再加进白值。"
      ],
      [
        "| HP/MP上限 | 写入 max | 删除 max；只允许 current 资源变化 |",
        "| HP/MP上限 | 临时消耗改了max或最终加成回写max | 临时变化保留原max；真实永久基础变化按表并保留资源比例 |"
      ],
      [
        "| 写 HP/MP max | 禁止；只允许 current 变化 |",
        "| HP/MP双值 | updateAttribute须同时提供current/max；临时损耗保留原max |"
      ],
      [
        "| 遗漏角色数值未补全 | 不补 |",
        "| 真实缺失白值 | 按压缩表补缺；0不是缺失，不覆盖已有值 |"
      ],
      [
        "| 参照旧境界表设定数值 | 禁止；容器体系 是属性结算权威 |",
        "| 按旧巨量表生成 | 禁止；统一当前压缩白值表，最终加成交本地容器计算 |"
      ]
    ],
    "newLength": 1542,
    "newHash": "eb70c7f0650cda7f62a53ec181880ea58aeadffeb45478718f636d258780fe97"
  },
  {
    "scope": "npc",
    "id": "npc-commands",
    "length": 6137,
    "hash": "c81ad3f6d684688be656b5245af958416e0b2d51ddd08e52af366025f9c68422",
    "edits": [
      [
        "- 不允许用此规则写 HP/MP max、物攻、法攻、穿透、脚力、修炼速度等其他基础数值。",
        "- 其他基础数值按压缩白值规则表和原生updateAttribute协议，仅新建、真实缺失或永久变化时维护。"
      ],
      [
        "本阶段只提供 NPC 气运/魅力白值写入指令，其余角色白值仍禁止写入。",
        "本阶段按当前目标维护有事实依据的13项白值，均使用updateAttribute或新建/补缺原生第11列；禁止处理他人及最终加成。"
      ],
      [
        "- 不输出其他角色白值属性。",
        "- 不输出其他人物的白值；当前目标按压缩表和真实变化维护。"
      ],
      [
        "- 不输出 HP/MP max。",
        "- HP/MP必须保留current/max双值，临时消耗不改max。"
      ]
    ],
    "newLength": 6210,
    "newHash": "592cf5eb6e4e20fc149ec57c339e8a1fdda8547f3ddc808fe197499704b4bdd0"
  },
  {
    "scope": "npc",
    "id": "npc-cot-step4",
    "length": 1085,
    "hash": "8e6ee9cbc056f41028283aadfcd2bd132548ee1151ffb896feda4378dbca3f1f",
    "edits": [
      [
        "- 是否删除了角色白值、HP/MP max、物攻/法攻/穿透/脚力/修炼速度等基础数值写入？",
        "- 是否仅保留有新建/真实缺失/永久变化依据的白值指令，并排除最终加成回写与无因果重采样？"
      ]
    ],
    "newLength": 1084,
    "newHash": "ee6402bca3459c6440691447dfe59a4eec83306b81e84898c2d66fd4044475d8"
  },
  {
    "scope": "npc",
    "id": "rule-49",
    "length": 521,
    "hash": "793561d36942720c7c4affcf16a905879f5acb7f827366fae3ce305a49c0b584",
    "edits": [
      [
        "1. 不输出角色基础数值、HP/MP max 或最终属性。",
        "1. 基础白值只按压缩规则表与已发生事实维护，不输出最终加成。"
      ],
      [
        "4. 不输出境界、装备、功法、trait、buff 形成的基础白值和最终属性。",
        "4. 已完成境界成长可维护基础白值；装备、功法、trait、buff形成的最终加成不可回写。"
      ]
    ],
    "newLength": 530,
    "newHash": "dba764bcb98e46fd84b48d1f029306237bae7872f91a575b60e3e2c5735590f8"
  },
  {
    "scope": "npc",
    "id": "rule-50",
    "length": 1678,
    "hash": "9c07df06993644f24dcd9768bc74a80be5da895fa2ca199dae74119f83db152a",
    "edits": [
      [
        "所有属性数值由系统结算；你只输出结构化方向（numeric）与明确发生的 HP/MP 当前值变化，不计算、不查表、不补最终数值。",
        "分工：变量按压缩规则表生成和维护有因果依据的白值，提供容器公式、功法、Trait、Buff来源；本地计算最终属性与等效描述。不得生成不支持的numeric/profile引擎，不手算最终加成。"
      ],
      [
        "| B1及所有C.../G... | 是否尝试写 HP/MP max、物攻/法攻/穿透/脚力/修炼速度等基础数值 | 删除该数值指令 |",
        "| B1及所有C.../G... | 是否无因果重赋白值或把最终加成回写白值 | 删除无依据/重复部分，保留按表的新建、真实补缺和永久成长 |"
      ],
      [
        "不补修炼速度默认值。新NPC首次建档、全量追溯补全，或已有稳定外貌/声名/体质证据但缺少气运/魅力白值时，可按标尺一次性写入基础气运/魅力；剧情永久特质用 addTrait 的 numeric 表达，不能把装备、功法、trait 或 buff 的最终加成改写成角色白值。",
        "新NPC建档或真实缺失时按对应标尺与灵根修炼合同一次性补齐13项白值，不重置已有值；气运/魅力仍依事实，永久特质用原生bonus/effects，装备/功法/trait/Buff最终加成不回写。"
      ],
      [
        "| HP/MP上限 | 写入 max | 删除 max；只允许 current 资源变化 |",
        "| HP/MP上限 | 临时消耗改了max或最终加成回写max | 临时变化保留原max；真实永久基础变化按表并保留资源比例 |"
      ],
      [
        "| 写 HP/MP max | 禁止；只允许 current 变化 |",
        "| HP/MP双值 | updateAttribute须同时提供current/max；临时损耗保留原max |"
      ],
      [
        "| 遗漏角色数值未补全 | 不补 |",
        "| 真实缺失白值 | 按压缩表补缺；0不是缺失，不覆盖已有值 |"
      ],
      [
        "| 参照旧境界表设定数值 | 禁止；容器体系 是属性结算权威 |",
        "| 按旧巨量表生成 | 禁止；统一当前压缩白值表，最终加成交本地容器计算 |"
      ]
    ],
    "newLength": 1734,
    "newHash": "070a23396ff3c05d9379abadfe22874aa14f313986996112e1ad6634f3d25d43"
  },
  {
    "scope": "humanoid_beast",
    "id": "humanoid-beast-npc-commands",
    "length": 6106,
    "hash": "6ac5aa66a8ee43c82ab06e47fa6c20682c5f1d6617c8d77ac3a19bc1906b8a6d",
    "edits": [
      [
        "- 不允许用此规则写 HP/MP max、物攻、法攻、穿透、脚力、修炼速度等其他基础数值。",
        "- 其他基础数值按压缩白值规则表和原生updateAttribute协议，仅新建、真实缺失或永久变化时维护。"
      ],
      [
        "本阶段只提供 NPC 气运/魅力白值写入指令，其余角色白值仍禁止写入。",
        "本阶段按当前目标维护有事实依据的13项白值，均使用updateAttribute或新建/补缺原生第11列；禁止处理他人及最终加成。"
      ],
      [
        "- 不输出其他角色白值属性。",
        "- 不输出其他人物的白值；当前目标按压缩表和真实变化维护。"
      ],
      [
        "- 不输出 HP/MP max。",
        "- HP/MP必须保留current/max双值，临时消耗不改max。"
      ]
    ],
    "newLength": 6179,
    "newHash": "57cf51de0b5379e2785e0cd2c1e3794540a89c97aa99ad63632bdf4afa0da4c9"
  },
  {
    "scope": "humanoid_beast",
    "id": "humanoid-beast-rule-49",
    "length": 521,
    "hash": "793561d36942720c7c4affcf16a905879f5acb7f827366fae3ce305a49c0b584",
    "edits": [
      [
        "1. 不输出角色基础数值、HP/MP max 或最终属性。",
        "1. 基础白值只按压缩规则表与已发生事实维护，不输出最终加成。"
      ],
      [
        "4. 不输出境界、装备、功法、trait、buff 形成的基础白值和最终属性。",
        "4. 已完成境界成长可维护基础白值；装备、功法、trait、buff形成的最终加成不可回写。"
      ]
    ],
    "newLength": 530,
    "newHash": "dba764bcb98e46fd84b48d1f029306237bae7872f91a575b60e3e2c5735590f8"
  },
  {
    "scope": "humanoid_beast",
    "id": "humanoid-beast-rule-50",
    "length": 1678,
    "hash": "9c07df06993644f24dcd9768bc74a80be5da895fa2ca199dae74119f83db152a",
    "edits": [
      [
        "所有属性数值由系统结算；你只输出结构化方向（numeric）与明确发生的 HP/MP 当前值变化，不计算、不查表、不补最终数值。",
        "分工：变量按压缩规则表生成和维护有因果依据的白值，提供容器公式、功法、Trait、Buff来源；本地计算最终属性与等效描述。不得生成不支持的numeric/profile引擎，不手算最终加成。"
      ],
      [
        "| B1及所有C.../G... | 是否尝试写 HP/MP max、物攻/法攻/穿透/脚力/修炼速度等基础数值 | 删除该数值指令 |",
        "| B1及所有C.../G... | 是否无因果重赋白值或把最终加成回写白值 | 删除无依据/重复部分，保留按表的新建、真实补缺和永久成长 |"
      ],
      [
        "不补修炼速度默认值。新NPC首次建档、全量追溯补全，或已有稳定外貌/声名/体质证据但缺少气运/魅力白值时，可按标尺一次性写入基础气运/魅力；剧情永久特质用 addTrait 的 numeric 表达，不能把装备、功法、trait 或 buff 的最终加成改写成角色白值。",
        "新NPC建档或真实缺失时按对应标尺与灵根修炼合同一次性补齐13项白值，不重置已有值；气运/魅力仍依事实，永久特质用原生bonus/effects，装备/功法/trait/Buff最终加成不回写。"
      ],
      [
        "| HP/MP上限 | 写入 max | 删除 max；只允许 current 资源变化 |",
        "| HP/MP上限 | 临时消耗改了max或最终加成回写max | 临时变化保留原max；真实永久基础变化按表并保留资源比例 |"
      ],
      [
        "| 写 HP/MP max | 禁止；只允许 current 变化 |",
        "| HP/MP双值 | updateAttribute须同时提供current/max；临时损耗保留原max |"
      ],
      [
        "| 遗漏角色数值未补全 | 不补 |",
        "| 真实缺失白值 | 按压缩表补缺；0不是缺失，不覆盖已有值 |"
      ],
      [
        "| 参照旧境界表设定数值 | 禁止；容器体系 是属性结算权威 |",
        "| 按旧巨量表生成 | 禁止；统一当前压缩白值表，最终加成交本地容器计算 |"
      ]
    ],
    "newLength": 1734,
    "newHash": "070a23396ff3c05d9379abadfe22874aa14f313986996112e1ad6634f3d25d43"
  },
  {
    "scope": "sharedRules",
    "id": "rule-8",
    "length": 9844,
    "hash": "e4f6e764fbb6f7d60940cd2b75b3d504eae8e2860900725279d1156141011fc1",
    "edits": [
      [
        "2. **境界突破** → 只同步境界/修为进度；不手写基础数值",
        "2. **境界突破** → 真实完成才按压缩白值表维护受影响基础值及实际境界/进度，不重算装备/功法/特质加成"
      ]
    ],
    "newLength": 9867,
    "newHash": "ae8edc76da78d79b1674a033d85f74a32f916999ae9b90aca3220855e694c37a"
  },
  {
    "scope": "player",
    "id": "player-supreme-rules",
    "length": 538,
    "hash": "59151ba92accecc14162b8cbb0eaa81161bfb7747173ddb4669cfef290024e54",
    "edits": [
      [
        "7. **角色数值边界**：禁止写角色白值、HP/MP max；HP/MP 当前资源变化只写 <state> 的 `hp.B1` / `mp.B1` 短指令",
        "7. **角色数值边界**：按压缩白值规则表维护有依据的第11列原始值；HP/MP变化用原生updateAttribute并携带current/max，不写最终加成，不使用失效的路径/短指令。"
      ]
    ],
    "newLength": 556,
    "newHash": "011e79f485978946a02a55c0cb3ceedf284e2e3d8eb50bdf6203c0f656744c3b"
  },
  {
    "scope": "player",
    "id": "player-attr-rules",
    "length": 340,
    "hash": "adc540849579ae77e2e4842030eaacab565ed237369f874d463858fc9c2e56af",
    "edits": [
      [
        "本阶段不写角色白值、基础数值、HP/MP max 或最终属性。",
        "本阶段只按压缩白值规则表，在新建、补齐真实缺失或已发生永久变化时写第11列白值；不写最终属性，不改无变化的旧值。"
      ],
      [
        "不写角色基础白值或最终属性；装备、功法、Trait、Buff 的 numeric 只保留在对应词条/物品/Buff 字段中。",
        "白值与来源分开：本阶段按表生成有依据的白值；装备给容器公式，功法给第8列，Trait给原生bonus/effects，Buff给第4列；本地统一叠加，禁止回写最终值。"
      ],
      [
        "境界突破只同步境界和修为进度，不手动刷新 HP/MP、攻防、穿透、脚力、修炼速度。",
        "已完成突破可按压缩白值表与真实成长维护受影响的基础值，保留实际资源比例与已有独立成长；未完成突破不改。修炼速度按灵根与独立修炼规则，不随战斗境界抬高。"
      ]
    ],
    "newLength": 420,
    "newHash": "1967bbb3be27a101ed6e625cf6cddf3e26b4775fc7791de6663549517157439f"
  },
  {
    "scope": "player",
    "id": "player-cot-phase1",
    "length": 7370,
    "hash": "642ad6732abacb7894fbbc7b70b80dcc19699a1f9550c9df4ea84660484444be",
    "edits": [
      [
        "不评估或重算角色基础属性、最终属性、HP/MP max。",
        "只在新建、真实缺失或已完成永久变化时按压缩表处理白值；不重算最终属性，不每轮重赋旧值。"
      ]
    ],
    "newLength": 7385,
    "newHash": "e1c3f119f06c405bf2889e68e20f7a1a593d7fcb351a18f1abe005919bfe4916"
  },
  {
    "scope": "player",
    "id": "player-cot-phase1-male",
    "length": 6957,
    "hash": "b3d3835bdb63fd8e4697f9a30a7f90c7973cfa788201bc725732d847d0f9589d",
    "edits": [
      [
        "不评估或重算角色基础属性、最终属性、HP/MP max。",
        "只在新建、真实缺失或已完成永久变化时按压缩表处理白值；不重算最终属性，不每轮重赋旧值。"
      ]
    ],
    "newLength": 6972,
    "newHash": "5e2b396fc520b69223b2df1fd52ee35fe25713263ef5b751191acf29a1b25f9a"
  },
  {
    "scope": "player",
    "id": "player-cot-phase4",
    "length": 2006,
    "hash": "3f33a1d68e7a3545a72a556ec946a6cf7632ed793787cf90c6eead5a92e5a09c",
    "edits": [
      [
        "| 7 | 手写基础数值 | 输出物攻/法攻/穿透/脚力/修炼速度等角色白值 | 删除，交给 容器体系 |",
        "| 7 | 重复结算 | 把装备/功法/Trait/Buff最终加成写成白值 | 删除重复项；真实新建或永久成长仍按压缩表维护白值 |"
      ]
    ],
    "newLength": 2020,
    "newHash": "e7aa251c3b66c494866fc905f96518900205dd59a4b86bbff1c0eed48b5b04a3"
  },
  {
    "scope": "npc",
    "id": "npc-commands",
    "length": 5574,
    "hash": "3453ed74893f3b5a344f8281956066beef26ebac5e1270291406b6bbf8b05e32",
    "edits": [
      [
        "- 不允许用此规则写 HP/MP max、物攻、法攻、穿透、脚力、修炼速度等其他基础数值。",
        "- 其他基础数值按压缩白值规则表和原生updateAttribute协议，仅新建、真实缺失或永久变化时维护。"
      ],
      [
        "本阶段只提供 NPC 气运/魅力白值写入指令，其余角色白值仍禁止写入。",
        "本阶段按当前目标维护有事实依据的13项白值，均使用updateAttribute或新建/补缺原生第11列；禁止处理他人及最终加成。"
      ],
      [
        "- 不输出其他角色白值属性。",
        "- 不输出其他人物的白值；当前目标按压缩表和真实变化维护。"
      ],
      [
        "- 不输出 HP/MP max。",
        "- HP/MP必须保留current/max双值，临时消耗不改max。"
      ]
    ],
    "newLength": 5647,
    "newHash": "41f550b410771863da5c7144c811f5aced2f353a07f8379d2400fb6e797c06ee"
  },
  {
    "scope": "npc",
    "id": "rule-50",
    "length": 1577,
    "hash": "c10af3a686e7ea74f73c04b6be74e185d9a33dbe158db57d0d38de679d9e62fe",
    "edits": [
      [
        "所有属性数值由系统结算；你只输出结构化方向（numeric）与明确发生的 HP/MP 当前值变化，不计算、不查表、不补最终数值。",
        "分工：变量按压缩规则表生成和维护有因果依据的白值，提供容器公式、功法、Trait、Buff来源；本地计算最终属性与等效描述。不得生成不支持的numeric/profile引擎，不手算最终加成。"
      ],
      [
        "| B1及所有C.../G... | 是否尝试写 HP/MP max、物攻/法攻/穿透/脚力/修炼速度等基础数值 | 删除该数值指令 |",
        "| B1及所有C.../G... | 是否无因果重赋白值或把最终加成回写白值 | 删除无依据/重复部分，保留按表的新建、真实补缺和永久成长 |"
      ],
      [
        "不补修炼速度默认值。新NPC首次建档、全量追溯补全，或已有稳定外貌/声名/体质证据但缺少气运/魅力白值时，可按标尺一次性写入基础气运/魅力；剧情永久特质用 addTrait 的 numeric 表达，不能把装备、功法、trait 或 buff 的最终加成改写成角色白值。",
        "新NPC建档或真实缺失时按对应标尺与灵根修炼合同一次性补齐13项白值，不重置已有值；气运/魅力仍依事实，永久特质用原生bonus/effects，装备/功法/trait/Buff最终加成不回写。"
      ],
      [
        "| HP/MP上限 | 写入 max | 删除 max；只允许 current 资源变化 |",
        "| HP/MP上限 | 临时消耗改了max或最终加成回写max | 临时变化保留原max；真实永久基础变化按表并保留资源比例 |"
      ],
      [
        "| 写 HP/MP max | 禁止；只允许 current 变化 |",
        "| HP/MP双值 | updateAttribute须同时提供current/max；临时损耗保留原max |"
      ],
      [
        "| 遗漏角色数值未补全 | 不补 |",
        "| 真实缺失白值 | 按压缩表补缺；0不是缺失，不覆盖已有值 |"
      ],
      [
        "| 参照旧境界表设定数值 | 禁止；容器体系 是属性结算权威 |",
        "| 按旧巨量表生成 | 禁止；统一当前压缩白值表，最终加成交本地容器计算 |"
      ]
    ],
    "newLength": 1633,
    "newHash": "9782648f7ac2d547455afb0e51b29d9d99c783f3e5e2f4d390d7da96859302f2"
  },
  {
    "scope": "player",
    "id": "player-cultivation-formula",
    "length": 2756,
    "hash": "51ae1050cb1722c82afb7eaa2175bd8773ffbc3456d7bfc832f64994ffe16e76",
    "newLength": 2802,
    "newHash": "43b39919ffa2a2ed3c37b3af090489a7c5d671dbffa1135a39cc269380653f17",
    "edits": [
      [
        "* 自动突破规则：低于元婴的小境界，修为进度超过100%后可自动突破；元婴及以上小境界与所有大境界都需单独突破，普通修炼停在当前境界99%。",
        "* 突破边界：仅按已有且明确完成的突破事实更新境界，否则普通修炼停在当前境界99%；不能凭数值自动跨境。"
      ],
      [
        "效率系数 = 聚灵阵 × 灵脉品阶 × 炼制抑制系数 × 先天气运 × 修炼速度系数 × 环境系数",
        "效率系数 = 最终修炼速度X/100 × 未进入最终面板的外部效率（聚灵阵/灵脉/环境/实际修炼占用等）；同一来源只计一次"
      ],
      [
        "*先天气运＝1 + 先天气运加成",
        "*先天气运：若已作为特质/bonus计入最终修炼速度，不得额外再乘；仅未入面板且有依据的独立条件效果可算外部效率"
      ],
      [
        "修炼速度系数＝角色快照最终修炼速度/100（读取当前角色最终属性“修炼速度”，缺失按100）",
        "修炼速度系数＝角色快照最终修炼速度/100；读取11_修炼效率_只读，真正缺白值按已确认灵根初始化；不是再乘一次灵根"
      ]
    ]
  },
  {
    "scope": "npc",
    "id": "rule-45",
    "length": 3104,
    "hash": "2a0484c93320399415efd770d9e9755c6539ab05d0e449f8ce0a375ec76e99bb",
    "newLength": 3070,
    "newHash": "6577bbb923410d3aa2e1233f0c793c9802dea95a5a5a34a4efc53f2ec1963df0",
    "edits": [
      [
        "- **默认值铁则**：修炼速度默认固定为 `{\"current\":100,\"max\":100}`，除非正文明确出现修炼效率变化，否则禁止写成 `1/1`、`0/0` 或任何小于100的值。气运、魅力默认同样按当前身份给出有效数值，不得留 0/0 敷衍。",
        "- **初始值铁则**：新建或真正缺失的修炼速度按统一灵根合同生成，可小于100或为0；混沌灵根为2000。已有合法白值不重置。气运/魅力按独立标尺与真实依据生成，零值不能自动视为缺失。"
      ]
    ]
  },
  {
    "scope": "contentTemplates",
    "id": "character-cultivation-formula",
    "length": 2662,
    "hash": "882b09f65f7fd8529b54ba4641f9906870e21ddeab7161f7b2e396991f814330",
    "newLength": 2708,
    "newHash": "9f946d5fb76bef2447e20abd6b04780a5d06b9c70bc79ab323dc8b0a0ad7872d",
    "edits": [
      [
        "* 自动突破规则：低于元婴的小境界，修为进度超过100%后可自动突破；元婴及以上小境界与所有大境界都需单独突破，普通修炼停在当前境界99%。",
        "* 突破边界：仅按已有且明确完成的突破事实更新境界，否则普通修炼停在当前境界99%；不能凭数值自动跨境。"
      ],
      [
        "效率系数 = 聚灵阵 × 灵脉品阶 × 炼制抑制系数 × 先天气运 × 修炼速度系数 × 环境系数",
        "效率系数 = 最终修炼速度X/100 × 未进入最终面板的外部效率（聚灵阵/灵脉/环境/实际修炼占用等）；同一来源只计一次"
      ],
      [
        "*先天气运＝1 + 先天气运加成",
        "*先天气运：若已作为特质/bonus计入最终修炼速度，不得额外再乘；仅未入面板且有依据的独立条件效果可算外部效率"
      ],
      [
        "修炼速度系数＝角色快照最终修炼速度/100（读取当前角色最终属性“修炼速度”，缺失按100）",
        "修炼速度系数＝角色快照最终修炼速度/100；读取11_修炼效率_只读，真正缺白值按已确认灵根初始化；不是再乘一次灵根"
      ]
    ]
  },
  {
    "scope": "npc",
    "id": "rule-45",
    "length": 2969,
    "hash": "50a47d2f27886c482f3a000101068b93a61b35d8126036a7cfa1d2ff7d8ad3c8",
    "newLength": 2935,
    "newHash": "4ece5abbd79321596b369c0cedbef68ce9b60a69080f6dd370b537c7adfe4f70",
    "edits": [
      [
        "- **默认值铁则**：修炼速度默认固定为 `{\"current\":100,\"max\":100}`，除非正文明确出现修炼效率变化，否则禁止写成 `1/1`、`0/0` 或任何小于100的值。气运、魅力默认同样按当前身份给出有效数值，不得留 0/0 敷衍。",
        "- **初始值铁则**：新建或真正缺失的修炼速度按统一灵根合同生成，可小于100或为0；混沌灵根为2000。已有合法白值不重置。气运/魅力按独立标尺与真实依据生成，零值不能自动视为缺失。"
      ]
    ]
  }
];

export function adaptCompressedNumericPreset(preset) {
  const groups=[...['sharedRules','entrySharedRules','itemSharedRules'].map(scope=>[scope,preset[scope]]),...Object.entries(preset.prompts||{}).map(([scope,g])=>[scope,g?.rules])];
  const contracts=groups.flatMap(([,rules])=>(rules||[]).filter(r=>r?.id==='fr-compressed-numeric-v1'));
  const contract=numericRulesText();
  const previous=[legacyMortalNumericRulesText(),legacyMortalNumericRulesText({includeTechniqueSpeed:'previous'}),legacyMortalNumericRulesText({includeTechniqueSpeed:false}),numericRulesText({includeTechniqueSpeed:'previous'}),numericRulesText({includeTechniqueSpeed:false})];
  const matches=(text,body)=>text===body||text?.startsWith(body+'\n');
  if(contracts.some(r=>r.enabled===false||!(matches(r.content,contract)||previous.some(body=>matches(r.content,body)))))return preset;
  for(const r of contracts)if(!matches(r.content,contract)){
    const body=previous.find(candidate=>matches(r.content,candidate));
    if(body)r.content=contract+r.content.slice(body.length);
  }
  let recognized=contracts.length>0;
  for(const[scope,rules]of groups){if(!Array.isArray(rules))continue;
    for(const rule of rules){if(!rule||typeof rule.content!=='string'||rules.filter(x=>x?.id===rule.id).length!==1)continue;
      const patch=COMPRESSED_NUMERIC_PATCHES.find(p=>p.scope===scope&&p.id===rule.id&&rule.content.length>=p.length&&numericRuleSha256(rule.content.slice(0,p.length))===p.hash);
      if(!patch)continue;recognized=true;
      const original=rule.content;let body=original.slice(0,patch.length);for(const[a,b]of patch.edits)body=body.split(a).join(b);rule.content=body+original.slice(patch.length);
    }
  }
  for(const[id,text]of Object.entries(preset.contentTemplates||{})) {
    if(typeof text!=='string')continue;
    const patch=COMPRESSED_NUMERIC_PATCHES.find(p=>p.scope==='contentTemplates'&&p.id===id&&text.length>=p.length&&numericRuleSha256(text.slice(0,p.length))===p.hash);
    if(!patch)continue;recognized=true;let body=text.slice(0,patch.length);for(const[a,b]of patch.edits)body=body.split(a).join(b);preset.contentTemplates[id]=body+text.slice(patch.length);
  }
  if(!recognized)return preset;
  for(const rules of [preset.sharedRules,preset.entrySharedRules,preset.prompts?.merged_variables?.rules]){
    if(!Array.isArray(rules)||rules.some(r=>r?.id==='fr-compressed-numeric-v1'))continue;
    rules.push({id:'fr-compressed-numeric-v1',name:'压缩白值与等效实力规则表',enabled:true,role:'system',content:contract});
  }
  return preset;
}

export function isCompressedNumericRule(scope,id,text) {
  return typeof text==='string'&&COMPRESSED_NUMERIC_PATCHES.some(p=>p.scope===scope&&p.id===id&&text.length>=p.newLength&&numericRuleSha256(text.slice(0,p.newLength))===p.newHash);
}
