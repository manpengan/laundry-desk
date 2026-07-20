/**
 * @file seed.ts
 * @description F2 模块：种子数据校验器与落库执行器
 * 确保种子数据 100% 具备完整性、零浮点数、受控手机号段。
 */

import { SEED_DATA, SeedDataPackage } from './data.js';

export class SeedValidationError extends Error {
  constructor(message: string) {
    super(`Seed Data Validation Failed: ${message}`);
    this.name = 'SeedValidationError';
  }
}

/**
 * 校验 F2 种子数据完整性与规则红线
 */
export function validateSeedData(seed: SeedDataPackage = SEED_DATA): void {
  // 1. 校验 Org 与 Store
  if (!seed.org || !seed.org.id || !seed.org.name) {
    throw new SeedValidationError('Org definition missing or invalid');
  }
  if (!seed.store || !seed.store.id || seed.store.orgId !== seed.org.id) {
    throw new SeedValidationError('Store definition missing or orgId mismatch');
  }

  // 2. 校验虚构手机号段 (必须全为 13800000xxx)
  const phoneRegex = /^13800000\d{3}$/;

  if (!phoneRegex.test(seed.store.phone)) {
    throw new SeedValidationError(
      `Store phone "${seed.store.phone}" does not match 13800000xxx segment`
    );
  }

  for (const staff of seed.staffs) {
    if (!phoneRegex.test(staff.phone)) {
      throw new SeedValidationError(
        `Staff "${staff.username}" phone "${staff.phone}" does not match 13800000xxx segment`
      );
    }
  }

  for (const customer of seed.customers) {
    if (!phoneRegex.test(customer.phone)) {
      throw new SeedValidationError(
        `Customer "${customer.name}" phone "${customer.phone}" does not match 13800000xxx segment`
      );
    }
    if (!Number.isInteger(customer.balanceCents) || customer.balanceCents < 0) {
      throw new SeedValidationError(
        `Customer balance cents must be non-negative integer, got: ${customer.balanceCents}`
      );
    }
  }

  // 3. 校验顺科 11 服务大类
  if (seed.priceCategories.length !== 11) {
    throw new SeedValidationError(
      `Expected exactly 11 price categories, got: ${seed.priceCategories.length}`
    );
  }

  // 4. 校验价目字典中的金额必须全为整数分 (零浮点数红线)
  for (const item of seed.priceItems) {
    if (!Number.isInteger(item.priceCents) || item.priceCents <= 0) {
      throw new SeedValidationError(
        `Price item "${item.name}" priceCents must be a positive integer, got: ${item.priceCents}`
      );
    }
  }
}

/**
 * 获取校验过的官方种子数据包
 */
export function getValidatedSeedData(): SeedDataPackage {
  validateSeedData(SEED_DATA);
  return SEED_DATA;
}
