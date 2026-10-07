import { expect, type Page } from "@playwright/test";

/** Decode through the actual packaged app:// policy, without a server or customer data. */
export async function expectPackagedPhotoBlob(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const bytes = Uint8Array.from(
      atob(
        "/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCJAJuev//Z",
      ),
      (character) => character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const image = new Image();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const event = await new Promise<"load" | "error" | "timeout">((resolve) => {
        image.onload = () => resolve("load");
        image.onerror = () => resolve("error");
        timer = setTimeout(() => resolve("timeout"), 5_000);
        image.src = url;
      });
      return {
        event,
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    } finally {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  });
  expect(result).toEqual({ event: "load", complete: true, width: 2, height: 2 });
}
