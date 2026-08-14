import { installLiquidGlass, ToastProvider } from "@laundry/ui";
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import type { LoginFormValues, SessionView } from "../auth/types.js";
import { LoginPage } from "../pages/LoginPage.js";
import type { AppPorts } from "./types.js";

export type StaffSurfaceState = Readonly<{
  session: SessionView;
  onSessionChange: Dispatch<SetStateAction<SessionView | null>>;
  setLoginInitialForm: Dispatch<SetStateAction<Partial<LoginFormValues> | undefined>>;
}>;

type StaffSurfaceRootProps = Readonly<{
  auth: AppPorts["auth"];
  enableLiquidGlass?: boolean;
  initialSession?: SessionView | null;
  loginInitialForm?: Partial<LoginFormValues>;
  loginTitle?: string;
  loginHint?: string;
  renderAuthenticated: (state: StaffSurfaceState) => ReactNode;
}>;

function loginPortFrom(auth: AppPorts["auth"]): Pick<AppPorts["auth"], "login"> {
  return Object.freeze({ login: (values: LoginFormValues) => auth.login(values) });
}

export function StaffSurfaceRoot({
  auth,
  enableLiquidGlass = true,
  initialSession = null,
  loginInitialForm,
  loginTitle,
  loginHint,
  renderAuthenticated,
}: StaffSurfaceRootProps) {
  const [session, onSessionChange] = useState<SessionView | null>(initialSession);
  const [activeLoginInitialForm, setLoginInitialForm] = useState<
    Partial<LoginFormValues> | undefined
  >(loginInitialForm);

  useEffect(() => {
    if (enableLiquidGlass && typeof document !== "undefined") installLiquidGlass();
  }, [enableLiquidGlass]);

  return (
    <ToastProvider>
      {session === null ? (
        <LoginPage
          authClient={loginPortFrom(auth)}
          onSuccess={onSessionChange}
          {...(loginTitle === undefined ? {} : { title: loginTitle })}
          {...(loginHint === undefined ? {} : { hint: loginHint })}
          {...(activeLoginInitialForm === undefined ? {} : { initialForm: activeLoginInitialForm })}
        />
      ) : (
        renderAuthenticated(Object.freeze({ session, onSessionChange, setLoginInitialForm }))
      )}
    </ToastProvider>
  );
}
