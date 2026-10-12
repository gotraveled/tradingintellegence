"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import { MARKET_SEGMENTS, SETUP_TYPES, TIMEFRAMES } from "@/lib/constants";
import type { BacktestRequest, MarketSegmentId, SetupType, Strategy, Timeframe } from "@/lib/types";

interface BacktestFormProps {
  strategies: Strategy[];
  running: boolean;
  onSubmit: (request: BacktestRequest) => void;
}

const ALL = "all";

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[11px] text-bearish">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[11px] text-subtle-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function BacktestForm({ strategies, running, onSubmit }: BacktestFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? "");
  const [market, setMarket] = useState<MarketSegmentId | typeof ALL>(ALL);
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [from, setFrom] = useState("2025-10-01");
  const [to, setTo] = useState("2026-09-30");
  const [setupType, setSetupType] = useState<SetupType | typeof ALL>(
    strategies[0]?.setupType ?? ALL,
  );
  const [minScore, setMinScore] = useState(60);
  const [risk, setRisk] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const strategy = strategies.find((item) => item.id === strategyId);

  const handleStrategyChange = (next: string) => {
    setStrategyId(next);
    const nextStrategy = strategies.find((item) => item.id === next);
    if (nextStrategy?.setupType) setSetupType(nextStrategy.setupType);
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!strategyId) next.strategy = "Select a strategy.";
    if (!from || !to) next.period = "Select a start and end date.";
    else if (from >= to) next.period = "Start date must be before end date.";
    if (Number.isNaN(minScore) || minScore < 0 || minScore > 100)
      next.minScore = "Enter a score between 0 and 100.";
    if (Number.isNaN(risk) || risk <= 0 || risk > 5) next.risk = "Enter a value between 0.1 and 5.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    onSubmit({
      strategyId,
      market: market === ALL ? undefined : market,
      timeframe,
      period: { from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` },
      setupType: setupType === ALL ? undefined : setupType,
      minScore,
      riskPerTradePct: risk,
    });
  };

  const describedBy = (name: string, hasHint = false) =>
    errors[name] ? `${id(name)}-error` : hasHint ? `${id(name)}-hint` : undefined;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Backtest configuration"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Configuration</h2>
        {strategy ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{strategy.description}</p>
        ) : null}
      </header>

      <fieldset disabled={running} className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-1">
        <legend className="sr-only">Backtest parameters</legend>

        <Field id={id("strategy")} label="Strategy" error={errors.strategy}>
          <Select
            id={id("strategy")}
            value={strategyId}
            onChange={(event) => handleStrategyChange(event.target.value)}
            aria-invalid={Boolean(errors.strategy)}
            aria-describedby={describedBy("strategy")}
          >
            {strategies.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field id={id("market")} label="Market">
          <Select
            id={id("market")}
            value={market}
            onChange={(event) => setMarket(event.target.value as MarketSegmentId | typeof ALL)}
          >
            <option value={ALL}>All markets</option>
            {MARKET_SEGMENTS.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field id={id("timeframe")} label="Timeframe">
          <Select
            id={id("timeframe")}
            value={timeframe}
            onChange={(event) => setTimeframe(event.target.value as Timeframe)}
          >
            {TIMEFRAMES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field id={id("setup")} label="Setup type">
          <Select
            id={id("setup")}
            value={setupType}
            onChange={(event) => setSetupType(event.target.value as SetupType | typeof ALL)}
          >
            <option value={ALL}>All setup types</option>
            {SETUP_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="space-y-1.5 sm:col-span-2 xl:col-span-1">
          <legend className="text-xs font-medium text-muted-foreground">Date range</legend>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={id("from")} className="sr-only">
                Start date
              </label>
              <Input
                id={id("from")}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-invalid={Boolean(errors.period)}
                aria-describedby={describedBy("period")}
              />
            </div>
            <div>
              <label htmlFor={id("to")} className="sr-only">
                End date
              </label>
              <Input
                id={id("to")}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-invalid={Boolean(errors.period)}
                aria-describedby={describedBy("period")}
              />
            </div>
          </div>
          {errors.period ? (
            <p id={`${id("period")}-error`} className="text-[11px] text-bearish">
              {errors.period}
            </p>
          ) : null}
        </fieldset>

        <Field
          id={id("minScore")}
          label="Minimum score"
          error={errors.minScore}
          hint="Only setups at or above this quality score are included."
        >
          <Input
            id={id("minScore")}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={5}
            value={minScore}
            onChange={(event) => setMinScore(event.target.valueAsNumber)}
            aria-invalid={Boolean(errors.minScore)}
            aria-describedby={describedBy("minScore", true)}
          />
        </Field>

        <Field
          id={id("risk")}
          label="Risk per trade (%)"
          error={errors.risk}
          hint="Percentage of simulated equity risked on each trade."
        >
          <Input
            id={id("risk")}
            type="number"
            inputMode="decimal"
            min={0.1}
            max={5}
            step={0.1}
            value={risk}
            onChange={(event) => setRisk(event.target.valueAsNumber)}
            aria-invalid={Boolean(errors.risk)}
            aria-describedby={describedBy("risk", true)}
          />
        </Field>
      </fieldset>

      <div className="border-t border-border p-4">
        <Button type="submit" className="w-full" disabled={running} aria-busy={running}>
          {running ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          {running ? "Running backtest…" : "Run Backtest"}
        </Button>
      </div>
    </form>
  );
}
