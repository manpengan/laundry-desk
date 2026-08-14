import { Button } from "@laundry/ui";
import { Component, type ErrorInfo, type ReactNode } from "react";

export type SurfaceFailureProps = Readonly<{
  title: string;
  description?: string;
}>;

/**
 * Terminal failure state for a surface whose code never arrived.
 *
 * Reload rather than a state reset: `React.lazy` caches the rejected import
 * promise, so re-rendering the same boundary replays the failure instead of
 * refetching the chunk.
 */
export function SurfaceFailure({ title, description }: SurfaceFailureProps) {
  return (
    <div className="ld-empty" role="alert">
      <h2 className="ld-empty__title">{title}</h2>
      {description === undefined ? null : <p className="ld-empty__desc">{description}</p>}
      <Button type="button" variant="primary" onClick={() => window.location.reload()}>
        重新加载
      </Button>
    </div>
  );
}

export type ErrorBoundaryProps = Readonly<{
  children: ReactNode;
  fallback: ReactNode;
  onError?: (error: unknown, info: ErrorInfo) => void;
}>;

type ErrorBoundaryState = Readonly<{ failed: boolean }>;

/**
 * Suspense resolves the pending state of a lazy import; it does not resolve a
 * rejection. Without this boundary a chunk that never arrives throws during
 * render and React unmounts the whole root, taking the shell and any in-flight
 * counter state with it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
