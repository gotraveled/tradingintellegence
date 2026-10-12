export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, ...options }).format(value);
}

export function formatPercent(value: number, fractionDigits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)}%`;
}

export function formatPrice(value: number, precision = 2) {
  return formatNumber(value, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}
