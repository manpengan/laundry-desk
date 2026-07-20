import type { ReactNode, TableHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  width?: string | number;
};

export type TableProps<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  className?: string;
} & Omit<TableHTMLAttributes<HTMLTableElement>, "children">;

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = "暂无数据",
  className,
  ...rest
}: TableProps<T>) {
  if (rows.length === 0) {
    return (
      <div className={cn("ld-table-wrap", className)} style={{ padding: 24 }}>
        {empty}
      </div>
    );
  }

  return (
    <div className={cn("ld-table-wrap", className)}>
      <table className="ld-table" {...rest}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td key={col.key}>{col.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
