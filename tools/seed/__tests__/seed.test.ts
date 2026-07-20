import { describe, it, expect } from 'vitest';
import { SEED_DATA, SHUNKE_PRICE_CATEGORIES, SeedDataPackage } from '../data.js';
import { validateSeedData, getValidatedSeedData, SeedValidationError } from '../seed.js';

describe('F2 Seed Data Integrity & Business Rules', () => {
  it('should validate official SEED_DATA without error', () => {
    expect(() => validateSeedData(SEED_DATA)).not.toThrow();
    const validated = getValidatedSeedData();
    expect(validated.org.id).toBe('org_shunke_001');
    expect(validated.store.id).toBe('store_headquarter_001');
  });

  it('should enforce zero floating point rule across all price items and customer balances', () => {
    for (const item of SEED_DATA.priceItems) {
      expect(Number.isInteger(item.priceCents)).toBe(true);
      expect(item.priceCents).toBeGreaterThan(0);
    }

    for (const customer of SEED_DATA.customers) {
      expect(Number.isInteger(customer.balanceCents)).toBe(true);
      expect(customer.balanceCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('should enforce 13800000xxx fake phone number segment rule strictly', () => {
    const phoneRegex = /^13800000\d{3}$/;

    expect(phoneRegex.test(SEED_DATA.store.phone)).toBe(true);

    for (const staff of SEED_DATA.staffs) {
      expect(phoneRegex.test(staff.phone)).toBe(true);
    }

    for (const customer of SEED_DATA.customers) {
      expect(phoneRegex.test(customer.phone)).toBe(true);
    }
  });

  it('should cover exactly Shunke 11 service categories', () => {
    expect(SHUNKE_PRICE_CATEGORIES.length).toBe(11);
    expect(SEED_DATA.priceCategories.length).toBe(11);

    const categoryIdsInItems = new Set(SEED_DATA.priceItems.map((item) => item.categoryId));
    for (const cat of SHUNKE_PRICE_CATEGORIES) {
      expect(categoryIdsInItems.has(cat.id)).toBe(true);
    }
  });

  it('should contain admin and staff roles in staff list', () => {
    const roles = SEED_DATA.staffs.map((s) => s.role);
    expect(roles).toContain('admin');
    expect(roles).toContain('staff');
  });

  describe('Rule #3: Validation Failure Checks (Assertions must fail on bad data)', () => {
    it('should reject invalid phone number segments', () => {
      const badData: SeedDataPackage = JSON.parse(JSON.stringify(SEED_DATA));
      badData.staffs[0].phone = '13912345678'; // 违规使用真实手机号段

      expect(() => validateSeedData(badData)).toThrow(SeedValidationError);
    });

    it('should reject floating point prices', () => {
      const badData: SeedDataPackage = JSON.parse(JSON.stringify(SEED_DATA));
      badData.priceItems[0].priceCents = 15.5 as unknown as number; // 违规使用浮点数

      expect(() => validateSeedData(badData)).toThrow(SeedValidationError);
    });

    it('should reject non-11 category counts', () => {
      const badData: SeedDataPackage = JSON.parse(JSON.stringify(SEED_DATA));
      badData.priceCategories.pop(); // 只有 10 个分类

      expect(() => validateSeedData(badData)).toThrow(SeedValidationError);
    });
  });
});
