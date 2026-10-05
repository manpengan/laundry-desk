import { EMPTY_CATALOG_FORM, type CatalogFormState } from "./catalog-form.js";

export const CATALOG_PRESETS = Object.freeze([
  { id: "wash_shirt", name: "水洗衬衫", service: "wash", category: "shirt" },
  { id: "dry_shirt", name: "干洗衬衫", service: "dry", category: "shirt" },
  { id: "dry_coat", name: "干洗外套", service: "dry", category: "coat" },
  { id: "dry_trousers", name: "干洗长裤", service: "dry", category: "trousers" },
  { id: "dry_down_jacket", name: "干洗羽绒服", service: "dry", category: "down_jacket" },
  { id: "wash_quilt", name: "水洗被子", service: "wash", category: "quilt" },
  { id: "shoe_shoes", name: "洗鞋", service: "shoe", category: "shoes" },
  { id: "iron_shirt", name: "衬衫熨烫", service: "iron", category: "shirt" },
]);
export function catalogPresetForm(id: string): CatalogFormState | null {
  const preset = CATALOG_PRESETS.find((item) => item.id === id);
  if (!preset) return null;
  return Object.freeze({
    ...EMPTY_CATALOG_FORM,
    code: preset.id,
    name: preset.name,
    service_code: preset.service,
    category_code: preset.category,
  });
}
