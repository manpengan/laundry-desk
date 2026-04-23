import { SetSettingSchema, SettingKeySchema } from "../../shared/schemas";
import { SettingsService } from "../services/settingsService";
import { registerIpcHandler } from "./helpers";

export function registerSettingsIpc(): void {
  registerIpcHandler("settings:get", SettingKeySchema, (key) =>
    SettingsService.get(key),
  );
  registerIpcHandler("settings:set", SetSettingSchema, (input) =>
    SettingsService.set(input.key, input.value),
  );
}
