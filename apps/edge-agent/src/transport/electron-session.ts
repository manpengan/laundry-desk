export const DESKTOP_SESSION_PARTITION = "persist:laundry-v2-local";

export type DesktopProtocolHandler = (request: Request) => Response | Promise<Response>;

type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;

type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
  details: unknown,
) => void;

export type DesktopSessionSurface = Readonly<{
  protocol: Readonly<{
    handle: (scheme: string, handler: DesktopProtocolHandler) => void | Promise<void>;
  }>;
  setPermissionCheckHandler: (handler: PermissionCheckHandler | null) => void;
  setPermissionRequestHandler: (handler: PermissionRequestHandler | null) => void;
}>;

/** Configure the protocol and both permission gates on the same dedicated session. */
export async function configureDesktopSession(
  desktopSession: DesktopSessionSurface,
  scheme: string,
  handler: DesktopProtocolHandler,
): Promise<void> {
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  await desktopSession.protocol.handle(scheme, handler);
}
