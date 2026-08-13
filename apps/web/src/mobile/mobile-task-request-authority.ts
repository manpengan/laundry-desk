import type { SessionView } from "../auth/types.js";

export type MobileTaskRequestChannel =
  "list" | "detail" | "mutation" | "evidence" | "media" | "evidenceMutation";

export type MobileTaskRequestToken = Readonly<{
  scope: string;
  channel: MobileTaskRequestChannel;
  generation: number;
  authorityKey: string;
  signal: AbortSignal;
}>;

export type MobileTaskRequestAuthority = Readonly<{
  scope: string;
  begin(channel: MobileTaskRequestChannel, authorityKey: string): MobileTaskRequestToken;
  invalidate(channel: MobileTaskRequestChannel): void;
  invalidateAll(): void;
  isCurrent(token: MobileTaskRequestToken): boolean;
}>;

type ChannelState = {
  generation: number;
  authorityKey: string | null;
  controller: AbortController | null;
};

function channelState(): ChannelState {
  return { generation: 0, authorityKey: null, controller: null };
}

/** Every server-authority dimension that must invalidate mobile PII and confirmations. */
export function mobileTaskSessionScope(session: SessionView): string {
  const value = session.session;
  return JSON.stringify([
    value.session_id,
    value.session_version,
    value.org_id,
    value.store_id,
    value.staff_id,
    value.device_id,
    value.permission_version,
  ]);
}

/** Generation checks cover non-abortable test ports; AbortSignal stops real HTTP work. */
export function createMobileTaskRequestAuthority(scope: string): MobileTaskRequestAuthority {
  const state: Record<MobileTaskRequestChannel, ChannelState> = {
    list: channelState(),
    detail: channelState(),
    mutation: channelState(),
    evidence: channelState(),
    media: channelState(),
    evidenceMutation: channelState(),
  };

  const invalidate = (channel: MobileTaskRequestChannel): void => {
    const current = state[channel];
    current.controller?.abort();
    current.generation += 1;
    current.authorityKey = null;
    current.controller = null;
  };

  return Object.freeze({
    scope,
    begin(channel, authorityKey) {
      invalidate(channel);
      const current = state[channel];
      const controller = new AbortController();
      current.authorityKey = authorityKey;
      current.controller = controller;
      return Object.freeze({
        scope,
        channel,
        generation: current.generation,
        authorityKey,
        signal: controller.signal,
      });
    },
    invalidate,
    invalidateAll() {
      invalidate("list");
      invalidate("detail");
      invalidate("mutation");
      invalidate("evidence");
      invalidate("media");
      invalidate("evidenceMutation");
    },
    isCurrent(token) {
      const current = state[token.channel];
      return (
        token.scope === scope &&
        !token.signal.aborted &&
        token.generation === current.generation &&
        token.authorityKey === current.authorityKey &&
        token.signal === current.controller?.signal
      );
    },
  });
}
