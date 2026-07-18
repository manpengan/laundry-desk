export interface PrinterDriver {
  print(data: any[], options: any): Promise<boolean>;
}

export class ElectronPosPrinterDriver implements PrinterDriver {
  async print(data: any[], options: any): Promise<boolean> {
    const { PosPrinter } = await import("electron-pos-printer");
    try {
      await PosPrinter.print(data, options);
      return true;
    } catch (err) {
      console.error("[ElectronPosPrinterDriver] print failed:", err);
      return false;
    }
  }
}

export class MockPrinterDriver implements PrinterDriver {
  async print(data: any[], options: any): Promise<boolean> {
    console.log("====== [MOCK PRINTER START] ======");
    console.log("OPTIONS:", JSON.stringify(options, null, 2));
    console.log("DATA:");
    data.forEach((item: any) => {
      if (item.type === "text") {
        console.log(`  [Text] ${item.value}`);
      } else if (item.type === "image") {
        console.log(`  [Image] (length: ${item.value?.length || 0})`);
      } else if (item.type === "barCode") {
        console.log(`  [BarCode] ${item.value}`);
      } else if (item.type === "qrCode") {
        console.log(`  [QrCode] ${item.value}`);
      }
    });
    console.log("====== [MOCK PRINTER END] ======");
    return true;
  }
}
