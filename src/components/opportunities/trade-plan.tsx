import { CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { Opportunity } from "@/lib/types";
import { cn, formatPrice } from "@/lib/utils";

type TradePlanSource = Pick<
  Opportunity,
  "entry" | "stopLoss" | "targets" | "riskReward" | "pricePrecision" | "status"
>;

interface TradePlanProps {
  plan: TradePlanSource;
  layout?: "grid" | "stack";
  className?: string;
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[11px] text-subtle-foreground">{label}</dt>
      <dd className={cn("numeric text-[13px] text-foreground", className)}>{children}</dd>
    </div>
  );
}

const PENDING = <span className="font-sans text-subtle-foreground">Pending</span>;

/**
 * Entry / invalidation / targets / risk-reward block. Missing values render as "Pending"
 * because the engine may not have produced them yet.
 */
export function TradePlan({ plan, layout = "grid", className }: TradePlanProps) {
  const precision = plan.pricePrecision ?? 2;
  const price = (value?: number) => (value === undefined ? PENDING : formatPrice(value, precision));

  return (
    <div className={cn("space-y-2", className)}>
      {plan.status === "developing" && plan.entry !== undefined ? (
        <p className="text-[11px] text-warning">Provisional levels — not active until confirmed</p>
      ) : null}
      <dl
        className={cn(
          "grid gap-x-4 gap-y-3",
          layout === "grid" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2",
        )}
      >
        <Field label="Entry">{price(plan.entry)}</Field>
        <Field label="Stop loss / invalidation" className="text-bearish">
          {price(plan.stopLoss)}
        </Field>
        <Field label="Targets" className="text-bullish">
          {plan.targets?.length ? (
            <ul className="space-y-0.5">
              {plan.targets.map((target) => (
                <li key={target.label} className="flex items-center gap-1">
                  <span className="text-subtle-foreground">{target.label}</span>{" "}
                  {formatPrice(target.price, precision)}
                  {target.reached ? (
                    <>
                      <CircleCheck className="size-3 text-bullish" aria-hidden="true" />
                      <span className="sr-only">(reached)</span>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            PENDING
          )}
        </Field>
        <Field label="Risk / Reward">
          {plan.riskReward === undefined ? PENDING : `${plan.riskReward.toFixed(1)}R`}
        </Field>
      </dl>
    </div>
  );
}
