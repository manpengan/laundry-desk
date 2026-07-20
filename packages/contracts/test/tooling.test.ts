import { expect, it } from "vitest";
import { z } from "zod";

it("loads the package-local Vitest and Zod toolchain", () => {
  expect(z.string().parse("contracts-ready")).toBe("contracts-ready");
});
