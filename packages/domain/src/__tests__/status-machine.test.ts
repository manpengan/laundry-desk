import { describe, it, expect } from 'vitest';
import {
  GarmentStatus,
  ALL_GARMENT_STATUSES,
  InvalidStateTransitionError,
  canTransition,
  transition,
  getValidTransitions,
} from '../status-machine.js';

describe('B3 Status Machine (Exhaustive State Transition & Fulfillment Collapse)', () => {
  describe('Full Fulfillment Mode (fulfillmentEnabled = true)', () => {
    const options = { fulfillmentEnabled: true };

    it('should allow valid transitions from received', () => {
      expect(canTransition('received', 'washing', options)).toBe(true);
      expect(canTransition('received', 'picked_up', options)).toBe(true);
      expect(canTransition('received', 'delivered', options)).toBe(true);
      expect(canTransition('received', 'lost', options)).toBe(true);

      expect(transition('received', 'washing', options)).toBe('washing');
    });

    it('should allow valid transitions from washing', () => {
      expect(canTransition('washing', 'ready', options)).toBe(true);
      expect(canTransition('washing', 'reworked', options)).toBe(true);
      expect(canTransition('washing', 'lost', options)).toBe(true);

      expect(transition('washing', 'ready', options)).toBe('ready');
    });

    it('should allow valid transitions from ready', () => {
      expect(canTransition('ready', 'racked', options)).toBe(true);
      expect(canTransition('ready', 'picked_up', options)).toBe(true);
      expect(canTransition('ready', 'delivered', options)).toBe(true);
      expect(canTransition('ready', 'reworked', options)).toBe(true);
      expect(canTransition('ready', 'lost', options)).toBe(true);
    });

    it('should allow valid transitions from racked', () => {
      expect(canTransition('racked', 'picked_up', options)).toBe(true);
      expect(canTransition('racked', 'delivered', options)).toBe(true);
      expect(canTransition('racked', 'reworked', options)).toBe(true);
      expect(canTransition('racked', 'lost', options)).toBe(true);
    });

    it('should allow valid transitions from reworked', () => {
      expect(canTransition('reworked', 'washing', options)).toBe(true);
      expect(canTransition('reworked', 'ready', options)).toBe(true);
      expect(canTransition('reworked', 'lost', options)).toBe(true);
    });

    it('should enforce terminal state "lost" (high-risk terminal state cannot transition out)', () => {
      for (const target of ALL_GARMENT_STATUSES) {
        expect(canTransition('lost', target, options)).toBe(false);
        expect(() => transition('lost', target, options)).toThrow(
          InvalidStateTransitionError
        );
      }
    });

    it('should enforce terminal states "picked_up" and "delivered"', () => {
      for (const target of ALL_GARMENT_STATUSES) {
        expect(canTransition('picked_up', target, options)).toBe(false);
        expect(canTransition('delivered', target, options)).toBe(false);
      }
    });

    it('exhaustive check: reject all invalid transitions under full fulfillment mode', () => {
      const allowedPairs: Record<GarmentStatus, GarmentStatus[]> = {
        received: ['washing', 'picked_up', 'delivered', 'lost'],
        washing: ['ready', 'reworked', 'lost'],
        ready: ['racked', 'picked_up', 'delivered', 'reworked', 'lost'],
        racked: ['picked_up', 'delivered', 'reworked', 'lost'],
        reworked: ['washing', 'ready', 'lost'],
        picked_up: [],
        delivered: [],
        lost: [],
      };

      for (const from of ALL_GARMENT_STATUSES) {
        for (const to of ALL_GARMENT_STATUSES) {
          const targets = allowedPairs[from] || [];
          const isAllowed = targets.includes(to);
          expect(canTransition(from, to, options)).toBe(isAllowed);

          if (!isAllowed) {
            expect(() => transition(from, to, options)).toThrow(
              InvalidStateTransitionError
            );
          }
        }
      }
    });
  });

  describe('Collapsed Fulfillment Mode (fulfillmentEnabled = false)', () => {
    const options = { fulfillmentEnabled: false };

    it('should allow direct transition from received to picked_up, delivered or lost', () => {
      expect(canTransition('received', 'picked_up', options)).toBe(true);
      expect(canTransition('received', 'delivered', options)).toBe(true);
      expect(canTransition('received', 'lost', options)).toBe(true);

      expect(transition('received', 'picked_up', options)).toBe('picked_up');
    });

    it('should block intermediate washing/ready/racked/reworked transitions when collapsed', () => {
      expect(canTransition('received', 'washing', options)).toBe(false);
      expect(canTransition('received', 'ready', options)).toBe(false);
      expect(canTransition('received', 'racked', options)).toBe(false);

      expect(() => transition('received', 'washing', options)).toThrow(
        InvalidStateTransitionError
      );
    });

    it('exhaustive check: reject all invalid transitions under collapsed mode', () => {
      const allowedPairs: Record<GarmentStatus, GarmentStatus[]> = {
        received: ['picked_up', 'delivered', 'lost'],
        washing: [],
        ready: [],
        racked: [],
        reworked: [],
        picked_up: [],
        delivered: [],
        lost: [],
      };

      for (const from of ALL_GARMENT_STATUSES) {
        for (const to of ALL_GARMENT_STATUSES) {
          const targets = allowedPairs[from] || [];
          const isAllowed = targets.includes(to);
          expect(canTransition(from, to, options)).toBe(isAllowed);

          if (!isAllowed) {
            expect(() => transition(from, to, options)).toThrow(
              InvalidStateTransitionError
            );
          }
        }
      }
    });
  });

  describe('getValidTransitions utility', () => {
    it('should return correct valid transitions array for full and collapsed modes', () => {
      expect(getValidTransitions('received', { fulfillmentEnabled: true })).toEqual([
        'washing',
        'picked_up',
        'delivered',
        'lost',
      ]);
      expect(getValidTransitions('received', { fulfillmentEnabled: false })).toEqual([
        'picked_up',
        'delivered',
        'lost',
      ]);
      expect(getValidTransitions('lost', { fulfillmentEnabled: true })).toEqual([]);
    });
  });
});
