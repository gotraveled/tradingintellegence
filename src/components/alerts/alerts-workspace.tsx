"use client";

import { useState } from "react";
import { Notice } from "@/components/ui/notice";
import type { DataSource } from "@/lib/services/types";
import type { Alert, AlertEvent, AlertType } from "@/lib/types";
import { AlertActivity } from "./alert-activity";
import { AlertRuleForm } from "./alert-rule-form";
import { AlertRuleList } from "./alert-rule-list";
import { AlertTypeCatalog } from "./alert-type-catalog";

interface AlertsWorkspaceProps {
  initialAlerts: Alert[];
  events: AlertEvent[];
  source: DataSource;
}

/** In-memory alert management. Persistence and delivery are added in a later phase. */
export function AlertsWorkspace({ initialAlerts, events, source }: AlertsWorkspaceProps) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [type, setType] = useState<AlertType>("developing_setup");
  const [message, setMessage] = useState<string | null>(null);

  const selectType = (next: AlertType) => {
    setType(next);
    document
      .getElementById("new-alert-form")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-6">
      <AlertTypeCatalog selected={type} onSelect={selectType} />

      {message ? (
        <Notice tone="info" title={message}>
          Stored in this browser session only — it will reset on reload.
        </Notice>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <AlertRuleList
            alerts={alerts}
            onToggle={(id) =>
              setAlerts((prev) =>
                prev.map((alert) =>
                  alert.id === id
                    ? { ...alert, status: alert.status === "paused" ? "active" : "paused" }
                    : alert,
                ),
              )
            }
            onDelete={(id) => setAlerts((prev) => prev.filter((alert) => alert.id !== id))}
          />
          <AlertActivity events={events} demo={source === "demo"} />
        </div>
        <div id="new-alert-form" className="scroll-mt-20 xl:sticky xl:top-20 xl:self-start">
          <AlertRuleForm
            type={type}
            onTypeChange={setType}
            onCreate={(alert) => {
              setAlerts((prev) => [alert, ...prev]);
              setMessage(`Alert “${alert.name}” created`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
