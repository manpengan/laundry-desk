export type ByokKmsContext = Readonly<{
  orgId: string;
  providerCode: string;
  credentialId: string;
  envelopeSchemaVersion: 1;
}>;

export type WrappedDataKey = Readonly<{
  wrappedKey: Buffer;
  keyId: string;
  keyVersion: string;
}>;

/**
 * Port for a non-exportable production KMS/OS secret-store authority.
 * Implementations must never log or persist plaintextKey and must return a copy
 * because the caller zeroes the supplied buffer immediately after the call.
 */
export type ByokKmsPort = Readonly<{
  wrapDataKey(input: {
    readonly plaintextKey: Buffer;
    readonly context: ByokKmsContext;
  }): Promise<WrappedDataKey>;
  unwrapDataKey(input: {
    readonly wrappedKey: Buffer;
    readonly keyId: string;
    readonly keyVersion: string;
    readonly context: ByokKmsContext;
  }): Promise<Buffer>;
}>;
