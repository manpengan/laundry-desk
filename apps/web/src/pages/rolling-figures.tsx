/** 数字滚动 for dashboard figures (ADR-99): roll up from zero when the board loads. */

import { MoneyText, useCountUp } from "@laundry/ui";

export function RollingCount({ value }: Readonly<{ value: number }>) {
  return <>{useCountUp(value, { fromZero: true })}</>;
}

export function RollingMoney({ fen }: Readonly<{ fen: number }>) {
  return <MoneyText fen={useCountUp(fen, { fromZero: true })} />;
}
