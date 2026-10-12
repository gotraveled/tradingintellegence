"use client";

import { BellPlus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import {
  ALERT_CHANNELS,
  ALERT_TYPES,
  FEATURED_INSTRUMENTS,
  MARKET_SEGMENTS,
  TIMEFRAMES,
} from "@/lib/constants";
import type {
  Alert,
  AlertChannel,
  AlertParams,
  AlertType,
  Direction,
  MarketSegmentId,
  Timeframe,
  ZoneType,
} from "@/lib/types";

const ANY = "any";

interface AlertRuleFormProps {
  type: AlertType;
  onTypeChange: (type: AlertType) => void;
  onCreate: (alert: Alert) => void;
}

function buildParams(
  type: AlertType,
  zoneType: ZoneType | typeof ANY,
  proximity: number,
  target: string,
): AlertParams {
  switch (type) {
    case "zone_approach":
      return { type, proximityPct: proximity, zoneType: zoneType === ANY ? undefined : zoneType };
    case "target_reached":
      return { type, targetLabel: target === ANY ? undefined : target };
    case "invalidation_reached":
      return { type };
    default:
      return { type };
  }
}

export function AlertRuleForm({ type, onTypeChange, onCreate }: AlertRuleFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState<string>(ANY);
  const [market, setMarket] = useState<MarketSegmentId | typeof ANY>(ANY);
  const [timeframe, setTimeframe] = useState<Timeframe | typeof ANY>(ANY);
  const [direction, setDirection] = useState<Direction | typeof ANY>(ANY);
  const [minScore, setMinScore] = useState<number>(60);
  const [zoneType, setZoneType] = useState<ZoneType | typeof ANY>(ANY);
  const [proximity, setProximity] = useState(0.5);
  const [target, setTarget] = useState<string>(ANY);
  const [channels, setChannels] = useState<AlertChannel[]>(["in_app"]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const toggleChannel = (channel: AlertChannel) =>
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((item) => item !== channel) : [...prev, channel],
    );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the alert a name.";
    if (channels.length === 0) next.channels = "Select at least one delivery channel.";
    if (type === "zone_approach" && !(proximity > 0 && proximity <= 5))
      next.proximity = "Enter a distance between 0.1% and 5%.";
    setErrors(next);
    if (Object.keys(next).length) return;

    onCreate({
      id: `local-${Date.now()}`,
      name: name.trim(),
      params: buildParams(type, zoneType, proximity, target),
      scope: {
        symbols: symbol === ANY ? undefined : [symbol],
        markets: market === ANY ? undefined : [market],
        timeframes: timeframe === ANY ? undefined : [timeframe],
        direction: direction === ANY ? undefined : direction,
        minScore,
      },
      channels,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    setName("");
  };

  const errorId = (key: string) => (errors[key] ? `${id(key)}-error` : undefined);

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-labelledby={id("title")}
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 id={id("title")} className="text-sm font-semibold">
          New alert rule
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Rules are kept in this session only.</p>
      </header>

      <div className="space-y-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={id("name")}>Name</Label>
          <Input
            id={id("name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. BTC developing reversals"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errorId("name")}
          />
          {errors.name ? (
            <p id={`${id("name")}-error`} className="text-[11px] text-bearish">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={id("type")}>Alert type</Label>
          <Select
            id={id("type")}
            value={type}
            onChange={(event) => onTypeChange(event.target.value as AlertType)}
          >
            {ALERT_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </div>

        {type === "zone_approach" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={id("zone")}>Zone</Label>
              <Select
                id={id("zone")}
                value={zoneType}
                onChange={(event) => setZoneType(event.target.value as ZoneType | typeof ANY)}
              >
                <option value={ANY}>Demand or supply</option>
                <option value="demand">Demand</option>
                <option value="supply">Supply</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("proximity")}>Within (%)</Label>
              <Input
                id={id("proximity")}
                type="number"
                min={0.1}
                max={5}
                step={0.1}
                value={proximity}
                onChange={(event) => setProximity(event.target.valueAsNumber)}
                aria-invalid={Boolean(errors.proximity)}
                aria-describedby={errorId("proximity")}
              />
            </div>
            {errors.proximity ? (
              <p id={`${id("proximity")}-error`} className="col-span-2 text-[11px] text-bearish">
                {errors.proximity}
              </p>
            ) : null}
          </div>
        ) : null}

        {type === "target_reached" ? (
          <div className="space-y-1.5">
            <Label htmlFor={id("target")}>Target</Label>
            <Select
              id={id("target")}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value={ANY}>Any target</option>
              <option value="T1">T1</option>
              <option value="T2">T2</option>
            </Select>
          </div>
        ) : null}

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Scope</legend>
          <div className="space-y-1.5">
            <Label htmlFor={id("symbol")}>Symbol</Label>
            <Select
              id={id("symbol")}
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            >
              <option value={ANY}>Any symbol</option>
              {FEATURED_INSTRUMENTS.map((asset) => (
                <option key={asset.id} value={asset.symbol}>
                  {asset.symbol}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("market")}>Market</Label>
            <Select
              id={id("market")}
              value={market}
              onChange={(event) => setMarket(event.target.value as MarketSegmentId | typeof ANY)}
            >
              <option value={ANY}>Any market</option>
              {MARKET_SEGMENTS.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("timeframe")}>Timeframe</Label>
            <Select
              id={id("timeframe")}
              value={timeframe}
              onChange={(event) => setTimeframe(event.target.value as Timeframe | typeof ANY)}
            >
              <option value={ANY}>Any timeframe</option>
              {TIMEFRAMES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("direction")}>Direction</Label>
            <Select
              id={id("direction")}
              value={direction}
              onChange={(event) => setDirection(event.target.value as Direction | typeof ANY)}
            >
              <option value={ANY}>Both</option>
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor={id("score")}>Minimum score</Label>
            <Input
              id={id("score")}
              type="number"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(event) => setMinScore(event.target.valueAsNumber)}
            />
          </div>
        </fieldset>

        <fieldset aria-describedby={errorId("channels")}>
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Deliver via</legend>
          <div className="flex flex-wrap gap-4">
            {ALERT_CHANNELS.map((channel) => (
              <label key={channel.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={channels.includes(channel.value)}
                  onChange={() => toggleChannel(channel.value)}
                  className="size-4 accent-[var(--primary)]"
                />
                {channel.label}
              </label>
            ))}
          </div>
          {errors.channels ? (
            <p id={`${id("channels")}-error`} className="mt-1.5 text-[11px] text-bearish">
              {errors.channels}
            </p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-subtle-foreground">
            Delivery channels are not connected yet; no notifications will be sent.
          </p>
        </fieldset>
      </div>

      <div className="border-t border-border p-4">
        <Button type="submit" className="w-full">
          <BellPlus aria-hidden="true" />
          Create alert
        </Button>
      </div>
    </form>
  );
}
