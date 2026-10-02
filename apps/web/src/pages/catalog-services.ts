/** Display names for catalog service codes; unknown codes stay visible verbatim. */

const SERVICE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  wash: "水洗",
  water: "水洗",
  dry: "干洗",
  dryclean: "干洗",
  dry_clean: "干洗",
  hand: "手洗",
  handwash: "手洗",
  hand_wash: "手洗",
  iron: "熨烫",
  press: "熨烫",
  steam: "蒸汽护理",
  leather: "皮具护理",
  shoe: "洗鞋",
  shoes: "洗鞋",
  bag: "箱包护理",
  curtain: "窗帘",
  carpet: "地毯",
  repair: "织补",
  alteration: "改衣",
  dye: "染色",
  care: "精细护理",
  other: "其他",
});

export function serviceLabel(code: string): string {
  const key = code.trim().toLowerCase();
  return SERVICE_LABELS[key] ?? code.trim();
}

/** Pure: distinct services in first-seen order (tab order == F-key order). */
export function catalogServices(
  items: readonly Readonly<{ service_code: string }>[],
): readonly string[] {
  const seen: string[] = [];
  for (const item of items) {
    const code = item.service_code.trim();
    if (code.length > 0 && !seen.includes(code)) seen.push(code);
  }
  return Object.freeze(seen);
}

/** F1 = 全部, F2…F11 = services in tab order. Returns null for other keys. */
export function serviceForFunctionKey(
  key: string,
  services: readonly string[],
): string | "all" | null {
  const match = /^F([1-9]|1[01])$/u.exec(key);
  if (match?.[1] === undefined) return null;
  const index = Number(match[1]);
  if (index === 1) return "all";
  return services[index - 2] ?? null;
}

export function functionKeyForTab(index: number): string | undefined {
  return index >= 0 && index <= 10 ? `F${index + 1}` : undefined;
}
