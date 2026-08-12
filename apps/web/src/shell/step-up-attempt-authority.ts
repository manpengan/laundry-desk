export type StepUpAttemptToken = Readonly<{
  authorityKey: string;
  generation: number;
}>;

export type StepUpAttemptAuthority = Readonly<{
  begin(authorityKey: string): StepUpAttemptToken;
  current(): StepUpAttemptToken | null;
  invalidate(): void;
  isCurrent(token: StepUpAttemptToken, authorityKey: string): boolean;
}>;

export function createStepUpAttemptAuthority(): StepUpAttemptAuthority {
  let generation = 0;
  let authorityKey: string | null = null;
  let token: StepUpAttemptToken | null = null;
  return Object.freeze({
    begin(nextAuthorityKey) {
      generation += 1;
      authorityKey = nextAuthorityKey;
      token = Object.freeze({ authorityKey: nextAuthorityKey, generation });
      return token;
    },
    current() {
      return token;
    },
    invalidate() {
      generation += 1;
      authorityKey = null;
      token = null;
    },
    isCurrent(candidate, expectedAuthorityKey) {
      return (
        candidate.generation === generation &&
        candidate.authorityKey === authorityKey &&
        candidate.authorityKey === expectedAuthorityKey
      );
    },
  });
}
