/**
 * Browser command bus envelope shapes (A2) for SPA clients.
 */

export type CommandErrorDetail = Readonly<{
  kind?: string;
  confirm_ref?: string;
  message?: string;
}>;

export type CommandFailure = Readonly<{
  code: string;
  detail?: CommandErrorDetail;
  message?: string;
}>;

export type CommandResult<T = unknown> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: CommandFailure }>;

export type CommandPort = Readonly<{
  execute: <T = unknown>(
    name: string,
    body?: unknown,
    options?: Readonly<{ confirmRef?: string }>,
  ) => Promise<CommandResult<T>>;
}>;

/** Read-only query bus port (POST /v1/queries/:name). Same result envelope as commands. */
export type QueryPort = Readonly<{
  execute: <T = unknown>(name: string, body?: unknown) => Promise<CommandResult<T>>;
}>;
