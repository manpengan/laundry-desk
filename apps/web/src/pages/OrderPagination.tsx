import { Button } from "@laundry/ui";
export function OrderPagination({
  total,
  offset,
  limit,
  busy,
  onPage,
}: Readonly<{
  total: number;
  offset: number;
  limit: number;
  busy: boolean;
  onPage: (offset: number) => void;
}>) {
  const next = offset + limit;
  return (
    <nav className="ld-order-pagination" aria-label="订单分页">
      <span role="status">
        共 {total} 单 · 第 {Math.floor(offset / limit) + 1} 页
      </span>
      <Button
        type="button"
        variant="secondary"
        disabled={busy || offset === 0}
        onClick={() => onPage(Math.max(0, offset - limit))}
      >
        上一页
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={busy || next >= total || next > 1_000_000}
        onClick={() => onPage(next)}
      >
        下一页
      </Button>
      {next > 1_000_000 && next < total ? <span>请缩小日期范围继续查询较早订单。</span> : null}
    </nav>
  );
}
