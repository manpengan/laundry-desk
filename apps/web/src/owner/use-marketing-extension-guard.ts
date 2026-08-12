import { useCallback, useEffect, useRef, useState } from "react";

import {
  bindMarketingExtensionAuthority,
  createMarketingExtensionAttempt,
  marketingExtensionAttemptMatches,
  marketingExtensionEpochMatches,
  type MarketingExtensionAction,
  type MarketingExtensionAttempt,
  type MarketingExtensionEpoch,
} from "./marketing-extension-command.js";

export function useMarketingExtensionGuard(scopeKey: string) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const scope = useRef(scopeKey);
  const action = useRef<MarketingExtensionAction | null>(null);
  const authorityKey = useRef<string | null>(null);
  scope.current = scopeKey;

  const invalidate = useCallback(() => {
    generation.current += 1;
    action.current = null;
    authorityKey.current = null;
    if (mounted.current) setBusy(false);
  }, []);

  useEffect(() => {
    invalidate();
  }, [invalidate, scopeKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      action.current = null;
      authorityKey.current = null;
    };
  }, []);

  const begin = useCallback((nextAction: MarketingExtensionAction): MarketingExtensionAttempt => {
    const next = generation.current + 1;
    generation.current = next;
    action.current = nextAction;
    authorityKey.current = null;
    setBusy(true);
    return createMarketingExtensionAttempt(next, scope.current, nextAction);
  }, []);

  const attemptCurrent = useCallback((attempt: MarketingExtensionAttempt): boolean => {
    return (
      mounted.current &&
      marketingExtensionAttemptMatches(attempt, generation.current, scope.current, action.current)
    );
  }, []);

  const bind = useCallback(
    (
      attempt: MarketingExtensionAttempt,
      nextAuthorityKey: string,
    ): MarketingExtensionEpoch | null => {
      if (!attemptCurrent(attempt)) return null;
      authorityKey.current = nextAuthorityKey;
      return bindMarketingExtensionAuthority(attempt, nextAuthorityKey);
    },
    [attemptCurrent],
  );

  const current = useCallback((epoch: MarketingExtensionEpoch): boolean => {
    return (
      mounted.current &&
      marketingExtensionEpochMatches(
        epoch,
        generation.current,
        scope.current,
        action.current,
        authorityKey.current,
      )
    );
  }, []);

  const activate = useCallback(
    (epoch: MarketingExtensionEpoch): boolean => {
      if (!current(epoch)) return false;
      setBusy(true);
      return true;
    },
    [current],
  );

  const finishAttempt = useCallback(
    (attempt: MarketingExtensionAttempt) => {
      if (attemptCurrent(attempt)) setBusy(false);
    },
    [attemptCurrent],
  );

  const finish = useCallback(
    (epoch: MarketingExtensionEpoch) => {
      if (current(epoch)) setBusy(false);
    },
    [current],
  );

  return Object.freeze({
    busy,
    scopeKey,
    begin,
    bind,
    activate,
    current,
    attemptCurrent,
    finish,
    finishAttempt,
    invalidate,
  });
}
