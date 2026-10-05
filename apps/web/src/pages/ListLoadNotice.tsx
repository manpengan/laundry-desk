import { Button } from "@laundry/ui";

type Props = Readonly<{
  error: string | null;
  loaded: boolean;
  busy: boolean;
  onRetry: () => void;
  testId: string;
}>;

export function ListLoadNotice({ error, loaded, busy, onRetry, testId }: Props) {
  if (error === null) return null;
  return (
    <div role="alert" className="ld-form-error" data-testid={testId}>
      <p>{error}</p>
      {loaded ? <p>当前保留上次成功读取的结果，尚未更新。</p> : null}
      <Button type="button" variant="secondary" disabled={busy} onClick={onRetry}>
        {busy ? "重试中…" : "重试"}
      </Button>
    </div>
  );
}
