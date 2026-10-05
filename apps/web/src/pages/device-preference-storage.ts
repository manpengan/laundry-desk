/** Device UI preferences only: callers validate and store no customer or session data. */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export function preferenceStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
export function readPreference(
  key: string,
  storage = preferenceStorage(),
): Readonly<{ value: unknown; error: string | null }> {
  if (storage === null) return { value: null, error: "此设备无法读取偏好设置，本次选择仍可使用。" };
  try {
    const raw = storage.getItem(key);
    return { value: raw === null ? null : (JSON.parse(raw) as unknown), error: null };
  } catch {
    return { value: null, error: "偏好设置读取失败，本次使用默认设置。" };
  }
}
export function writePreference(
  key: string,
  value: unknown,
  storage = preferenceStorage(),
): string | null {
  if (storage === null) return "此设备无法保存偏好设置，下次打开需重新选择。";
  try {
    storage.setItem(key, JSON.stringify(value));
    return null;
  } catch {
    return "偏好设置保存失败，下次打开需重新选择。";
  }
}
