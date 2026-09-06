// Dev-only: verifies the What-If "Projected Utilization" is the MAX WEEKLY AVERAGE
// over the selected period (not a single-day peak), that it moves when the date
// range moves, and that the candidate table and allocation scenarios share one calc.
//   node --import ./scripts/paths-hook.mjs scripts/whatif-test.ts <live.json>
import { readFileSync } from "node:fs";
import type { Employee } from "@/data/types";
import type { AssignedTicket } from "@/store/tickets-store";
import type { WorkLogEntry } from "@/store/work-log-store";
import { runScenario, type ScenarioInput } from "@/lib/simulate";
import { computeEmployeeWeeklyCapacity, peakWeeklyUtilization } from "@/lib/capacityEngine";
import { startOfWeek, parseLooseDate, formatDisplayDate, addDays } from "@/lib/date";

const path = process.argv[2];
if (!path) {
  console.error("usage: node --import ./scripts/paths-hook.mjs scripts/whatif-test.ts <live.json>");
  process.exit(1);
}
const raw = JSON.parse(readFileSync(path, "utf8"));

const employees: Employee[] = raw.employees.map((e: Record<string, unknown>) => ({
  ...e,
  weeklyHours: Number(e.weeklyHours) || 40,
  currentUtilization: Number(e.currentUtilization) || 0,
  skills: e.skills ?? [],
  knowledgeAreas: e.knowledgeAreas ?? [],
  upcomingTickets: e.upcomingTickets ?? [],
  adhoc: e.adhoc ?? [],
  leaveEvents: e.leaveEvents ?? [],
})) as Employee[];
const tickets: AssignedTicket[] = raw.tickets.map((t: Record<string, unknown>) => ({
  ...t,
  estimatedHours: Number(t.estimatedHours) || 0,
  slaHours: Number(t.slaHours) || 0,
  assignedEmployeeIds: t.assignedEmployeeIds ?? [],
  relatedSkills: t.relatedSkills ?? undefined,
  coverage: t.coverage ?? null,
})) as AssignedTicket[];
const wl = new Map<string, WorkLogEntry>();
for (const r of raw.workLog as Record<string, unknown>[]) {
  wl.set(`${r.employeeId}:${r.itemId}`, {
    workflowStatus: (r.workflowStatus as WorkLogEntry["workflowStatus"]) ?? undefined,
    progress: r.progress == null ? undefined : Number(r.progress),
    completedAt: (r.completedAt as string) ?? null,
    holdStartDate: (r.holdStartDate as string) ?? null,
    holdEndDate: (r.holdEndDate as string) ?? null,
    actualHours: r.actualHours == null ? null : Number(r.actualHours),
    remainingHours: r.remainingHours == null ? null : Number(r.remainingHours),
    progressUpdatedAt: (r.progressUpdatedAt as string) ?? null,
    comments: (r.comments as WorkLogEntry["comments"]) ?? [],
  });
}
const getEntry = (k: string): WorkLogEntry => wl.get(k) ?? { comments: [] };
const events = (raw.calEvents as Record<string, unknown>[]).map((e) => ({ ...e })) as never[];
const team = employees.filter((e) => e.level !== "Supervisor");

let ok = true;
const check = (name: string, pass: boolean) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) ok = false;
};

// A scenario in the "Windows Server / AD" skill area — hits Njoud & Bader & Ali.
const base: ScenarioInput = {
  name: "Datacentre refresh programme",
  startDate: formatDisplayDate(addDays(startOfWeek(new Date(2026, 8, 6)), 7)), // next week
  durationWeeks: 3,
  estimatedHours: 90,
  priority: "High",
  requiredSkills: ["Windows Server", "Active Directory"],
};

function run(input: ScenarioInput) {
  return runScenario(team, input, tickets, getEntry, events);
}

const r1 = run(base);
console.log(`\nScenario: ${base.name} · ${base.startDate} · ${base.durationWeeks} wk · ${base.estimatedHours}h`);
const MS_WK = 7 * 864e5;
function windowFor(input: ScenarioInput) {
  const start = parseLooseDate(input.startDate)!;
  const endEx = addDays(start, input.durationWeeks * 7);
  const fromWeek = startOfWeek(start);
  const weeks = Math.max(1, Math.ceil((endEx.getTime() - fromWeek.getTime()) / MS_WK));
  return { fromWeek, weeks, deadline: formatDisplayDate(endEx) };
}

for (const c of r1.candidates) {
  // Recompute the weekly series ourselves — SAME window logic as runScenario.
  const { fromWeek, weeks, deadline } = windowFor(base);
  const synthetic: AssignedTicket = {
    id: "whatif-scenario", title: base.name, description: "", status: "In Progress", priority: base.priority,
    assignedUnit: c.employee.department, raisedDate: base.startDate, estimatedHours: base.estimatedHours,
    slaHours: 24, expectedResolutionDate: deadline,
    resolvedDate: null, createdBy: "x", assignedBy: "x", assignedEmployeeIds: [c.employee.id], relatedSkills: base.requiredSkills,
  };
  const wk = computeEmployeeWeeklyCapacity(c.employee, [...tickets, synthetic], getEntry, weeks, fromWeek, events);
  const maxWeekly = Math.max(...wk.map((w) => w.utilization));
  const viaHelper = peakWeeklyUtilization(c.employee, tickets, getEntry, synthetic, fromWeek, weeks, events).peakUtilization;
  console.log(`  ${c.employee.name.padEnd(20)} skill ${c.skillMatch}%  current ${c.currentUtilization}%  projected ${c.projectedUtilization}%  (peak ${c.peakWeekLabel})  weekly=[${wk.map((w) => w.utilization + "%").join(" ")}]`);
  check(`${c.employee.name}: projected == max weekly average`, c.projectedUtilization === maxWeekly && viaHelper === maxWeekly);
}

// Candidate projected == Scenario A / B for the same person.
const sA = r1.allocationScenarios.find((s) => s.id === "A");
const sB = r1.allocationScenarios.find((s) => s.id === "B");
if (sA) check("Scenario A number == candidate[0] Projected Utilization", sA.assignees[0].projected === r1.candidates[0].projectedUtilization);
if (sB && r1.candidates[1]) check("Scenario B number == candidate[1] Projected Utilization", sB.assignees[0].projected === r1.candidates[1].projectedUtilization);

// Dates must affect the result: shift the window forward 1 week.
const shifted: ScenarioInput = { ...base, startDate: formatDisplayDate(addDays(parseLooseDate(base.startDate)!, 7)) };
const r2 = run(shifted);
console.log(`\nShifted +1 week → ${shifted.startDate}`);
for (const c of r2.candidates) {
  console.log(`  ${c.employee.name.padEnd(20)} projected ${c.projectedUtilization}%  (peak ${c.peakWeekLabel})`);
}
const c0Before = r1.candidates[0];
const c0After = r2.candidates.find((c) => c.employee.id === c0Before.employee.id)!;
check(
  "Changing the date range changes at least one candidate's Projected Utilization or peak week",
  r1.candidates.some((c) => {
    const cc = r2.candidates.find((x) => x.employee.id === c.employee.id);
    return cc && (cc.projectedUtilization !== c.projectedUtilization || cc.peakWeekLabel !== c.peakWeekLabel);
  })
);
void c0After;

// It's a weekly average, never a single-day peak: projected should be <= 100 + slack
// for a believable load, and should equal one of the weekly-average points.
check("Projected is a weekly-average value, not a day spike (<= 250%)", r1.candidates.every((c) => c.projectedUtilization <= 250));

console.log(ok ? "\n✅ What-If projected utilization = max weekly average, date-sensitive, single calculation" : "\n❌ What-If calculation regressed");
process.exitCode = ok ? 0 : 1;
