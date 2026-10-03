import { createMiniappClient } from "./client.js";
import { loadPublicConfig } from "./config.js";
import { createPortalController, type PortalController } from "./controller.js";
import { initialState, portalView } from "./portal-state.js";
import type { WxPort } from "./wx-port.js";

type NativeEvent = Readonly<{
  currentTarget: Readonly<{ dataset: Readonly<Record<string, string>> }>;
  detail: Readonly<{ value?: string; code?: string }>;
}>;
type PageInstance = Readonly<{ setData(value: unknown): void }>;
declare const wx: WxPort;
declare function Page(definition: Readonly<Record<string, unknown>>): void;
let controller: PortalController | null = null;
Page({
  data: portalView(initialState(false)),
  onLoad(this: PageInstance) {
    const config = loadPublicConfig();
    if (!config) {
      this.setData(portalView(initialState(false)));
      return;
    }
    controller = createPortalController(createMiniappClient(wx, config), wx, (value) =>
      this.setData(value),
    );
    void controller.start();
  },
  onUnload() {
    controller?.dispose();
    controller = null;
  },
  login() {
    void controller?.login();
  },
  phone(event: NativeEvent) {
    if (event.detail.code) void controller?.login(event.detail.code);
  },
  logout() {
    void controller?.logout();
  },
  refresh() {
    void controller?.refresh();
  },
  retry() {
    void controller?.start();
  },
  tab(event: NativeEvent) {
    controller?.selectTab(event.currentTarget.dataset.tab ?? "");
  },
  input(event: NativeEvent) {
    controller?.input(event.currentTarget.dataset.field ?? "", event.detail.value ?? "");
  },
  selectOrder(event: NativeEvent) {
    controller?.selectOrder(event.detail.value ?? "");
  },
  detail(event: NativeEvent) {
    void controller?.detail(event.currentTarget.dataset.id ?? "");
  },
  pay(event: NativeEvent) {
    void controller?.pay(event.currentTarget.dataset.id ?? "");
  },
  balance(event: NativeEvent) {
    void controller?.balance(event.currentTarget.dataset.id ?? "");
  },
  topup() {
    void controller?.topup();
  },
  paymentStatus() {
    void controller?.paymentStatus();
  },
  selectPayment(event: NativeEvent) {
    controller?.selectPayment(event.currentTarget.dataset.id ?? "");
  },
  book() {
    void controller?.book();
  },
  cancel(event: NativeEvent) {
    void controller?.cancel(event.currentTarget.dataset.id ?? "");
  },
  saveAddress() {
    void controller?.saveAddress();
  },
  benefit(event: NativeEvent) {
    void controller?.benefit(
      event.currentTarget.dataset.kind ?? "",
      event.currentTarget.dataset.id ?? "",
    );
  },
  subscribe() {
    void controller?.subscribe();
  },
});
