import { describe, it, expect } from "vitest";
import {
  FULLWIDTH_YEN_SYMBOL,
  validateCents,
  formatFen,
  yuanToFen,
  addCents,
  subtractCents,
  multiplyCents,
  apportionDiscount,
} from "../money.js";

describe("B1 Money Utility (Cents Integer Math & Apportionment)", () => {
  describe("validateCents", () => {
    it("should accept valid integers", () => {
      expect(() => validateCents(0)).not.toThrow();
      expect(() => validateCents(2900)).not.toThrow();
      expect(() => validateCents(-100)).not.toThrow();
    });

    it("should reject floating-point numbers", () => {
      expect(() => validateCents(29.99)).toThrow(TypeError);
      expect(() => validateCents(0.1)).toThrow(TypeError);
      expect(() => validateCents(NaN)).toThrow(TypeError);
    });
  });

  describe("formatFen", () => {
    it("should format positive cents with fullwidth Yen symbol by default", () => {
      expect(formatFen(2900)).toBe(`${FULLWIDTH_YEN_SYMBOL}29.00`);
      expect(formatFen(5)).toBe(`${FULLWIDTH_YEN_SYMBOL}0.05`);
      expect(formatFen(0)).toBe(`${FULLWIDTH_YEN_SYMBOL}0.00`);
    });

    it("should format negative cents correctly", () => {
      expect(formatFen(-105)).toBe(`-${FULLWIDTH_YEN_SYMBOL}1.05`);
    });

    it("should support hide symbol option", () => {
      expect(formatFen(2900, { showSymbol: false })).toBe("29.00");
      expect(formatFen(-105, { showSymbol: false })).toBe("-1.05");
    });

    it("should reject floating-point inputs", () => {
      expect(() => formatFen(29.5)).toThrow(TypeError);
    });
  });

  describe("yuanToFen", () => {
    it("should convert valid yuan string to integer cents", () => {
      expect(yuanToFen("29.00")).toBe(2900);
      expect(yuanToFen("29.99")).toBe(2999);
      expect(yuanToFen("0.05")).toBe(5);
      expect(yuanToFen("5")).toBe(500);
      expect(yuanToFen("-10.5")).toBe(-1050);
    });

    it("should strip currency symbols like fullwidth ￥ or $", () => {
      expect(yuanToFen(`${FULLWIDTH_YEN_SYMBOL}29.00`)).toBe(2900);
      expect(yuanToFen("$15.50")).toBe(1550);
    });

    it("should handle number inputs", () => {
      expect(yuanToFen(29)).toBe(2900);
      expect(yuanToFen(29.99)).toBe(2999);
    });

    it("should throw error on invalid string format", () => {
      expect(() => yuanToFen("abc")).toThrow();
      expect(() => yuanToFen("")).toThrow();
      expect(() => yuanToFen("29.999")).toThrow();
    });
  });

  describe("addCents & subtractCents", () => {
    it("should correctly sum integer cents", () => {
      expect(addCents(1000, 2000, 500)).toBe(3500);
      expect(subtractCents(3500, 500)).toBe(3000);
    });

    it("should throw error if float is passed", () => {
      expect(() => addCents(10.5, 20)).toThrow(TypeError);
      expect(() => subtractCents(100, 0.5)).toThrow(TypeError);
    });
  });

  describe("multiplyCents", () => {
    it("should multiply and round according to specified mode", () => {
      expect(multiplyCents(1000, 0.85, "round")).toBe(850);
      expect(multiplyCents(1003, 0.85, "round")).toBe(853);
      expect(multiplyCents(1003, 0.85, "floor")).toBe(852);
      expect(multiplyCents(1003, 0.85, "ceil")).toBe(853);
    });

    it("should reject floating-point cents input", () => {
      expect(() => multiplyCents(10.5, 0.8)).toThrow(TypeError);
    });
  });

  describe("apportionDiscount (Largest Remainder Method)", () => {
    it("should evenly divide discount when possible", () => {
      const discount = 100;
      const items = [1000, 1000];
      const result = apportionDiscount(discount, items);
      expect(result).toEqual([50, 50]);
      expect(result.reduce((a: number, b: number) => a + b, 0)).toBe(discount);
    });

    it("should handle fractional cent residuals without losing 1 cent", () => {
      const discount = 100; // 1 元优惠
      const items = [1000, 1000, 1000]; // 3 件衣服平分 1 元
      const result = apportionDiscount(discount, items);

      expect(result.reduce((a: number, b: number) => a + b, 0)).toBe(100);
      expect(result).toEqual([34, 33, 33]);
    });

    it("should correctly apportion unequal items", () => {
      const discount = 1500; // 15 元优惠
      const items = [2000, 3000, 5000]; // 原价 20, 30, 50 元 (总共 100 元)
      const result = apportionDiscount(discount, items);
      expect(result).toEqual([300, 450, 750]);
      expect(result.reduce((a: number, b: number) => a + b, 0)).toBe(1500);
    });

    it("should return zeros for empty list or zero total discount", () => {
      expect(apportionDiscount(0, [1000, 2000])).toEqual([0, 0]);
      expect(apportionDiscount(500, [])).toEqual([]);
    });

    it("should reject floats in discount or items", () => {
      expect(() => apportionDiscount(100.5, [1000])).toThrow(TypeError);
      expect(() => apportionDiscount(100, [1000.5])).toThrow(TypeError);
    });
  });
});
