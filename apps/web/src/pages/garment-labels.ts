import { serviceLabel } from "./catalog-services.js";

const CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  shirt: "衬衫",
  tshirt: "T恤",
  t_shirt: "T恤",
  trousers: "长裤",
  pants: "裤子",
  coat: "外套",
  jacket: "夹克",
  suit: "西装",
  dress: "连衣裙",
  skirt: "裙子",
  sweater: "毛衣",
  down: "羽绒服",
  down_jacket: "羽绒服",
  shoes: "鞋子",
  blanket: "毛毯",
  quilt: "被子",
  curtain: "窗帘",
  bedding: "床品",
});
/** Historical orders lack a catalog-name snapshot; never infer it from a current price list. */
export function garmentName(service: string, category: string): string {
  return `${serviceLabel(service)} · ${CATEGORIES[category.toLowerCase()] ?? `衣物（${category}）`}`;
}
