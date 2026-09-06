"use client";

import { useMemo, useState } from "react";
import { FlaskConical, Loader2, CheckCircle2, Info } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { AiTag } from "@/components/ui/AiTag";
import { CapacityBar } from "@/components/ui/ProgressBar";
import { KpiInfo } from "@/components/ui/KpiInfo";
import { getCapacityStatus } from "@/lib/capacity";
import { runScenario, type ScenarioInput } from "@/lib/simulate";
import { DEFAULT_SCENARIO_PROJECT, RECOMMENDATION_REASONS } from "@/data/scenarios";
import { formatDisplayDate, toInputDateValue } from "@/lib/date";
import { useSkills } from "@/store/skills-store";
import { useTickets } from "@/store/tickets-store";
import { useWorkLog } from "@/store/work-log-store";
import { useCalendarEvents } from "@/store/calendar-events-store";
import type { Employee } from "@/data/types";

const PRIORITIES: ScenarioInput["priority"][] = ["High", "Medium", "Low"];

export function WhatIfSimulator({ employees }: { employees: Employee[] }) {
  const { skillNames } = useSkills();
  const { tickets } = useTickets();
  const { getEntry } = useWorkLog();
  const { events } = useCalendarEvents();
  // The central catalogue is the source of truth for the options; anything already
  // on the default scenario is kept even if it's not in the catalogue.
  const allSkillOptions = useMemo(
    () => Array.from(new Set([...skillNames, ...DEFAULT_SCENARIO_PROJECT.requiredSkills])).sort((a, b) => a.localeCompare(b)),
    [skillNames]
  );
  const [form, setForm] = useState<ScenarioInput>({
    name: DEFAULT_SCENARIO_PROJECT.name,
    startDate: DEFAULT_SCENARIO_PROJECT.startDate,
    durationWeeks: DEFAULT_SCENARIO_PROJECT.durationWeeks,
    estimatedHours: DEFAULT_SCENARIO_PROJECT.estimatedHours,
    priority: DEFAULT_SCENARIO_PROJECT.priority,
    requiredSkills: DEFAULT_SCENARIO_PROJECT.requiredSkills,
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof runScenario> | null>(null);

  function toggleSkill(skill: string) {
    setForm((f) => ({
      ...f,
      requiredSkills: f.requiredSkills.includes(skill)
        ? f.requiredSkills.filter((s) => s !== skill)
        : [...f.requiredSkills, skill],
    }));
  }

  function handleSimulate() {
    setLoading(true);
    setResult(null);
    window.setTimeout(() => {
      setResult(runScenario(employees, form, tickets, getEntry, events));
      setLoading(false);
    }, 700);
  }

  const recommended = useMemo(() => result?.allocationScenarios.find((s) => s.recommended), [result]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="New Hypothetical Project"
          subtitle="Define the work you're considering assigning, then simulate its impact on the team."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Project Name">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="input"
            />
          </Field>
          <Field label="Start Date">
            <input
              type="date"
              value={toInputDateValue(form.startDate)}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  startDate: e.target.value ? formatDisplayDate(new Date(`${e.target.value}T00:00:00`)) : f.startDate,
                }))
              }
              className="input"
            />
          </Field>
          <Field label="Duration (weeks)">
            <input
              type="number"
              min={1}
              value={form.durationWeeks}
              onChange={(e) => setForm((f) => ({ ...f, durationWeeks: Number(e.target.value) || 1 }))}
              className="input"
            />
          </Field>
          <Field label="Estimated Effort (hours)">
            <input
              type="number"
              min={1}
              value={form.estimatedHours}
              onChange={(e) => setForm((f) => ({ ...f, estimatedHours: Number(e.target.value) || 1 }))}
              className="input"
            />
          </Field>
          <Field label="Priority">
            <select
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as ScenarioInput["priority"] }))}
              className="input"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <div />
          <div className="sm:col-span-2">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-ink-secondary">
              Required Skills
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) toggleSkill(e.target.value);
                }}
                className="input max-w-[240px]"
                aria-label="Add a required skill"
              >
                <option value="">Add a required skill…</option>
                {allSkillOptions
                  .filter((s) => !form.requiredSkills.includes(s))
                  .map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
              </select>
              {form.requiredSkills.map((skill) => (
                <button
                  key={skill}
                  type="button"
                  onClick={() => toggleSkill(skill)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-brand-700 bg-brand-800 px-3 py-1.5 text-xs font-medium text-white"
                >
                  {skill}
                  <span aria-hidden>×</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Skills come from the central catalogue — a supervisor manages it under Skills.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={handleSimulate}
            disabled={loading || form.requiredSkills.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {loading ? "Simulating…" : "Simulate Impact"}
          </button>
        </div>
      </Card>

      {loading && (
        <Card className="flex items-center gap-3 text-sm text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
          Analyzing skills, availability and current workload across the team…
        </Card>
      )}

      {result && !loading && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold text-ink tracking-tight">Scenario Analysis</h2>
              <span className="inline-flex items-center rounded-full border border-accent-green/30 bg-accent-green-bg px-2.5 py-1 text-xs font-medium text-accent-green">
                Simulated Scenario
              </span>
            </div>
            <AiTag label="AI-assisted recommendation" />
          </div>

          <Card>
            <CardHeader title="Candidates" subtitle="Ranked by skill match against the required skill set" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-ink-secondary">
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Skill Match</th>
                    <th className="px-3 py-2.5">Current Utilization</th>
                    <th className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        Projected Utilization
                        <KpiInfo topic="whatIfProjected" />
                      </span>
                    </th>
                    <th className="px-3 py-2.5">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map((c) => {
                    const risk = getCapacityStatus(c.projectedUtilization);
                    return (
                      <tr key={c.employee.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-3">
                          <p className="font-medium text-ink">{c.employee.name}</p>
                          <p className="text-xs text-ink-muted">{c.employee.department}</p>
                        </td>
                        <td className="px-3 py-3 tabular">{c.skillMatch}%</td>
                        <td className="px-3 py-3 w-36">
                          <CapacityBar value={c.currentUtilization} />
                        </td>
                        <td className="px-3 py-3 w-36">
                          <CapacityBar value={c.projectedUtilization} />
                          {c.peakWeekLabel && (
                            <p className="mt-1 text-[11px] text-ink-muted">busiest week: {c.peakWeekLabel}</p>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${risk.bg} ${risk.border} ${risk.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${risk.dot}`} />
                            {risk.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div>
            <h3 className="text-sm font-semibold text-ink mb-3">Allocation Scenarios</h3>
            <div className="grid gap-4 md:grid-cols-3">
              {result.allocationScenarios.map((s) => {
                const risk = getCapacityStatus(Math.max(...s.assignees.map((a) => a.projected)));
                return (
                  <Card
                    key={s.id}
                    className={s.recommended ? "border-2 border-brand-600 shadow-md relative" : "relative"}
                  >
                    {s.recommended && (
                      <span className="absolute -top-3 left-4 rounded-full bg-brand-800 px-3 py-1 text-[11px] font-semibold text-white shadow-sm">
                        Recommended Allocation
                      </span>
                    )}
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{s.label}</p>
                    <p className="mt-1 text-sm font-semibold text-ink">{s.description}</p>

                    <div className="mt-4 space-y-3">
                      {s.assignees.map((a) => (
                        <div key={a.employee.id}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-ink-secondary">
                              {a.employee.name.split(" ")[0]}
                              {a.peakWeekLabel && <span className="text-ink-muted"> · peak {a.peakWeekLabel}</span>}
                            </span>
                            <span className="tabular font-medium text-ink">{a.projected}%</span>
                          </div>
                          <CapacityBar value={a.projected} showLabel={false} />
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-ink-muted">
                      Max weekly average utilization over the {form.durationWeeks}-week window, incl. this allocation.
                    </p>

                    <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
                      <span className="text-xs text-ink-secondary">Overall Risk</span>
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${risk.bg} ${risk.border} ${risk.text}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${risk.dot}`} />
                        {risk.label}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          {recommended && (
            <Card className="border-brand-100 bg-brand-50/50">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-ink">
                    Recommended Allocation — {recommended.assignees.map((a) => a.employee.name.split(" ")[0]).join(" + ")}
                  </h3>
                  <p className="mt-0.5 text-xs text-ink-muted">Why?</p>
                </div>
                <AiTag />
              </div>
              <ul className="grid gap-2.5 sm:grid-cols-2">
                {RECOMMENDATION_REASONS.map((reason) => (
                  <li key={reason} className="flex items-center gap-2 text-sm text-ink">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--status-good)]" />
                    {reason}
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex items-start gap-2 rounded-lg border border-border bg-surface px-3.5 py-3">
                <Info className="h-4 w-4 mt-0.5 shrink-0 text-brand-600" />
                <p className="text-xs leading-relaxed text-ink-secondary">
                  This recommendation is generated by WorkLens&rsquo;s capacity intelligence layer from current
                  workload, skills and availability data. <span className="font-medium text-ink">Recommendation
                  supports the supervisor; final allocation remains a human decision.</span>
                </p>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={() => setResult(null)}
                  className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-5 py-2.5 text-sm font-medium text-ink hover:bg-brand-50"
                >
                  Modify Scenario
                </button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

