/**
 * @file data.ts
 * @description F2 模块：Laundry-V2 官方种子数据定义
 * 包含：1 Org / 1 Store / 管理员+店员 / 顺科 11 服务大类 × 品类价目字典 / 虚构手机号 (13800000xxx)
 * 遵循 GEMINI.md 红线：金额均为 int 分，无浮点数，手机号段严格受控。
 */

export interface SeedOrg {
  id: string;
  name: string;
  code: string;
}

export interface SeedStore {
  id: string;
  orgId: string;
  name: string;
  code: string;
  address: string;
  phone: string;
}

export interface SeedStaff {
  id: string;
  orgId: string;
  storeId: string;
  username: string;
  displayName: string;
  phone: string;
  role: "admin" | "staff";
  passwordHash: string; // argon2id / mock hash for seed
}

export interface SeedCustomer {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  phone: string;
  vipLevel: number;
  balanceCents: number;
}

export interface SeedPriceItem {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  serviceType:
    | "wash"
    | "dry_clean"
    | "iron"
    | "leather"
    | "shoes"
    | "textile"
    | "luxury"
    | "dyeing"
    | "tailoring"
    | "home"
    | "car_interior";
  priceCents: number;
  unit: string;
}

export interface SeedSettings {
  orgId: string;
  storeId: string;
  fulfillmentEnabled: boolean;
  smsEnabled: boolean;
  autoPrintReceipt: boolean;
  storeName: string;
  storePhone: string;
  receiptFooterNotice: string;
}

export interface SeedDataPackage {
  org: SeedOrg;
  store: SeedStore;
  staffs: SeedStaff[];
  customers: SeedCustomer[];
  priceCategories: { id: string; name: string; icon: string }[];
  priceItems: SeedPriceItem[];
  settings: SeedSettings;
}

/**
 * 顺科洗衣 11 服务大类
 */
export const SHUNKE_PRICE_CATEGORIES = [
  { id: "cat_wash", name: "水洗", icon: "droplet" },
  { id: "cat_dry_clean", name: "干洗", icon: "sparkles" },
  { id: "cat_iron", name: "熨烫", icon: "shirt" },
  { id: "cat_leather", name: "皮革护理", icon: "shield" },
  { id: "cat_shoes", name: "鞋靴清洗", icon: "footprints" },
  { id: "cat_textile", name: "窗帘台布", icon: "blinds" },
  { id: "cat_luxury", name: "奢侈品洗护", icon: "crown" },
  { id: "cat_dyeing", name: "染色翻新", icon: "palette" },
  { id: "cat_tailoring", name: "织补修整", icon: "scissors" },
  { id: "cat_home", name: "居家软饰", icon: "home" },
  { id: "cat_car_interior", name: "汽车内饰", icon: "car" },
] as const;

export const SEED_DATA: SeedDataPackage = {
  org: {
    id: "org_shunke_001",
    name: "顺科洗衣连锁",
    code: "SHUNKE",
  },
  store: {
    id: "store_headquarter_001",
    orgId: "org_shunke_001",
    name: "顺科洗衣旗舰总店",
    code: "HQ01",
    address: "北京市朝阳区顺科路 88 号大厦 1 层",
    phone: "13800000000",
  },
  staffs: [
    {
      id: "staff_admin_001",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      username: "admin",
      displayName: "店长管理员",
      phone: "13800000001",
      role: "admin",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$mock_salt_admin$mock_hash_admin",
    },
    {
      id: "staff_operator_002",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      username: "xiaoli",
      displayName: "李店员（收件柜台）",
      phone: "13800000002",
      role: "staff",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$mock_salt_xiaoli$mock_hash_xiaoli",
    },
    {
      id: "staff_operator_003",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      username: "xiaozhang",
      displayName: "张洗涤工（洗涤车间）",
      phone: "13800000003",
      role: "staff",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$mock_salt_xiaozhang$mock_hash_xiaozhang",
    },
  ],
  customers: [
    {
      id: "cust_001",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      name: "王金卡（VIP顾客）",
      phone: "13800000101",
      vipLevel: 2,
      balanceCents: 50000, // ￥500.00 预存款
    },
    {
      id: "cust_002",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      name: "赵普通（常客）",
      phone: "13800000102",
      vipLevel: 0,
      balanceCents: 0,
    },
    {
      id: "cust_003",
      orgId: "org_shunke_001",
      storeId: "store_headquarter_001",
      name: "钱银卡（社区居民）",
      phone: "13800000103",
      vipLevel: 1,
      balanceCents: 15000, // ￥150.00
    },
  ],
  priceCategories: [...SHUNKE_PRICE_CATEGORIES],
  priceItems: [
    // 1. 水洗
    {
      id: "item_w01",
      categoryId: "cat_wash",
      categoryName: "水洗",
      name: "男/女衬衫",
      serviceType: "wash",
      priceCents: 1500,
      unit: "件",
    },
    {
      id: "item_w02",
      categoryId: "cat_wash",
      categoryName: "水洗",
      name: "休闲 T 恤",
      serviceType: "wash",
      priceCents: 1200,
      unit: "件",
    },
    {
      id: "item_w03",
      categoryId: "cat_wash",
      categoryName: "水洗",
      name: "短款羽绒服",
      serviceType: "wash",
      priceCents: 4500,
      unit: "件",
    },
    {
      id: "item_w04",
      categoryId: "cat_wash",
      categoryName: "水洗",
      name: "长款羽绒服",
      serviceType: "wash",
      priceCents: 5800,
      unit: "件",
    },
    {
      id: "item_w05",
      categoryId: "cat_wash",
      categoryName: "水洗",
      name: "牛仔裤",
      serviceType: "wash",
      priceCents: 1800,
      unit: "条",
    },

    // 2. 干洗
    {
      id: "item_d01",
      categoryId: "cat_dry_clean",
      categoryName: "干洗",
      name: "西装上衣",
      serviceType: "dry_clean",
      priceCents: 3500,
      unit: "件",
    },
    {
      id: "item_d02",
      categoryId: "cat_dry_clean",
      categoryName: "干洗",
      name: "西裤",
      serviceType: "dry_clean",
      priceCents: 2500,
      unit: "条",
    },
    {
      id: "item_d03",
      categoryId: "cat_dry_clean",
      categoryName: "干洗",
      name: "羊毛大衣",
      serviceType: "dry_clean",
      priceCents: 5800,
      unit: "件",
    },
    {
      id: "item_d04",
      categoryId: "cat_dry_clean",
      categoryName: "干洗",
      name: "派克服/风衣",
      serviceType: "dry_clean",
      priceCents: 6800,
      unit: "件",
    },
    {
      id: "item_d05",
      categoryId: "cat_dry_clean",
      categoryName: "干洗",
      name: "丝绸连衣裙",
      serviceType: "dry_clean",
      priceCents: 4800,
      unit: "件",
    },

    // 3. 熨烫
    {
      id: "item_i01",
      categoryId: "cat_iron",
      categoryName: "熨烫",
      name: "衬衫单熨",
      serviceType: "iron",
      priceCents: 800,
      unit: "件",
    },
    {
      id: "item_i02",
      categoryId: "cat_iron",
      categoryName: "熨烫",
      name: "西裤单熨",
      serviceType: "iron",
      priceCents: 1200,
      unit: "条",
    },
    {
      id: "item_i03",
      categoryId: "cat_iron",
      categoryName: "熨烫",
      name: "西服套装精烫",
      serviceType: "iron",
      priceCents: 2000,
      unit: "套",
    },

    // 4. 皮革护理
    {
      id: "item_l01",
      categoryId: "cat_leather",
      categoryName: "皮革护理",
      name: "光面皮衣保养",
      serviceType: "leather",
      priceCents: 12800,
      unit: "件",
    },
    {
      id: "item_l02",
      categoryId: "cat_leather",
      categoryName: "皮革护理",
      name: "磨砂/翻毛皮衣护理",
      serviceType: "leather",
      priceCents: 15800,
      unit: "件",
    },
    {
      id: "item_l03",
      categoryId: "cat_leather",
      categoryName: "皮革护理",
      name: "真皮女包上光护理",
      serviceType: "leather",
      priceCents: 16800,
      unit: "个",
    },

    // 5. 鞋靴清洗
    {
      id: "item_s01",
      categoryId: "cat_shoes",
      categoryName: "鞋靴清洗",
      name: "运动鞋/网面鞋",
      serviceType: "shoes",
      priceCents: 2800,
      unit: "双",
    },
    {
      id: "item_s02",
      categoryId: "cat_shoes",
      categoryName: "鞋靴清洗",
      name: "休闲皮鞋清洗",
      serviceType: "shoes",
      priceCents: 3500,
      unit: "双",
    },
    {
      id: "item_s03",
      categoryId: "cat_shoes",
      categoryName: "鞋靴清洗",
      name: "雪地靴/长筒靴",
      serviceType: "shoes",
      priceCents: 4800,
      unit: "双",
    },

    // 6. 窗帘台布
    {
      id: "item_t01",
      categoryId: "cat_textile",
      categoryName: "窗帘台布",
      name: "普通布艺窗帘",
      serviceType: "textile",
      priceCents: 1800,
      unit: "㎡",
    },
    {
      id: "item_t02",
      categoryId: "cat_textile",
      categoryName: "窗帘台布",
      name: "双层遮光窗帘",
      serviceType: "textile",
      priceCents: 2200,
      unit: "㎡",
    },
    {
      id: "item_t03",
      categoryId: "cat_textile",
      categoryName: "窗帘台布",
      name: "餐厅提花台布",
      serviceType: "textile",
      priceCents: 2500,
      unit: "张",
    },

    // 7. 奢侈品洗护
    {
      id: "item_x01",
      categoryId: "cat_luxury",
      categoryName: "奢侈品洗护",
      name: "名牌包深度清洗保养",
      serviceType: "luxury",
      priceCents: 29800,
      unit: "个",
    },
    {
      id: "item_x02",
      categoryId: "cat_luxury",
      categoryName: "奢侈品洗护",
      name: "高定重工礼服洗护",
      serviceType: "luxury",
      priceCents: 38800,
      unit: "件",
    },

    // 8. 染色翻新
    {
      id: "item_y01",
      categoryId: "cat_dyeing",
      categoryName: "染色翻新",
      name: "纯棉黑色衣服翻新补色",
      serviceType: "dyeing",
      priceCents: 8800,
      unit: "件",
    },
    {
      id: "item_y02",
      categoryId: "cat_dyeing",
      categoryName: "染色翻新",
      name: "麂皮绒包局部褪色补色",
      serviceType: "dyeing",
      priceCents: 11800,
      unit: "个",
    },

    // 9. 织补修整
    {
      id: "item_r01",
      categoryId: "cat_tailoring",
      categoryName: "织补修整",
      name: "西裤裤脚修改/打边",
      serviceType: "tailoring",
      priceCents: 1500,
      unit: "条",
    },
    {
      id: "item_r02",
      categoryId: "cat_tailoring",
      categoryName: "织补修整",
      name: "衣服无痕精细织补",
      serviceType: "tailoring",
      priceCents: 3000,
      unit: "处",
    },
    {
      id: "item_r03",
      categoryId: "cat_tailoring",
      categoryName: "织补修整",
      name: "外套优质拉链更换",
      serviceType: "tailoring",
      priceCents: 2000,
      unit: "条",
    },

    // 10. 居家软饰
    {
      id: "item_h01",
      categoryId: "cat_home",
      categoryName: "居家软饰",
      name: "布艺沙发套",
      serviceType: "home",
      priceCents: 6800,
      unit: "套",
    },
    {
      id: "item_h02",
      categoryId: "cat_home",
      categoryName: "居家软饰",
      name: "纯棉床单/被套四件套",
      serviceType: "home",
      priceCents: 3800,
      unit: "套",
    },
    {
      id: "item_h03",
      categoryId: "cat_home",
      categoryName: "居家软饰",
      name: "蚕丝被/羊毛被芯清洗",
      serviceType: "home",
      priceCents: 5800,
      unit: "床",
    },

    // 11. 汽车内饰
    {
      id: "item_c01",
      categoryId: "cat_car_interior",
      categoryName: "汽车内饰",
      name: "汽车五座全套座套清洗",
      serviceType: "car_interior",
      priceCents: 15800,
      unit: "套",
    },
    {
      id: "item_c02",
      categoryId: "cat_car_interior",
      categoryName: "汽车内饰",
      name: "全车皮革/大丝圈脚垫冲洗",
      serviceType: "car_interior",
      priceCents: 4800,
      unit: "套",
    },
  ],
  settings: {
    orgId: "org_shunke_001",
    storeId: "store_headquarter_001",
    fulfillmentEnabled: true,
    smsEnabled: false,
    autoPrintReceipt: true,
    storeName: "顺科洗衣旗舰总店",
    storePhone: "13800000000",
    receiptFooterNotice: "凭此单取衣，请于 30 日内凭单取件。逾期不领按规定处理。",
  },
};
