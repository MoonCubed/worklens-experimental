import type { Employee } from "@/data/types";
import type { AssignedTicket } from "@/store/tickets-store";
import type { CalendarEvent } from "@/store/calendar-events-store";
import { getCapacityStatus } from "@/lib/capacity";
import { isCurrentlyOnLeave, peakWeeklyUtilization, type WorkLogLookup } from "@/lib/capacityEngine";
import { parseLooseDate, startOfWeek, addDays, todayStart, formatDisplayDate, SLA_HOURS } from "@/lib/date";

export interface ScenarioInput {
  name: string;
  startDate: string;
  durationWeeks: number;
  estimatedHours: number;
  priority: "High" | "Medium" | "Low";
  requiredSkills: string[];
}

export interface ScenarioCandidate {
  employee: Employee;
  skillMatch: number;
  currentUtilization: number;
  /** Maximum weekly-average utilization across the selected What-If period if this
   * one person took on the whole scenario — the busiest week on average, not a day. */
  projectedUtilization: number;
  /** Which week that peak falls in ("W38"), for the UI caption. */
  peakWeekLabel: string;
}

export interface AllocationAssignee {
  employee: Employee;
  /** Same calculation as `ScenarioCandidate.projectedUtilization` — max weekly average
   * over the selected period, for this assignee's share of the scenario. */
  projected: number;
  peakWeekLabel: string;
}

export interface AllocationScenario {
  id: string;
  label: string;
  description: string;
  assignees: AllocationAssignee[];
  overallProjected: number;
  recommended: boolean;
}

export function computeSkillMatch(employee: Employee, requiredSkills: string[]): number {
  if (requiredSkills.length === 0) return 0;
  const owned = new Set(employee.skills.map((s) => s.name.toLowerCase()));
  const matched = requiredSkills.filter((s) => owned.has(s.toLowerCase()));
  return Math.round((matched.length / requiredSkills.length) * 100);
}

export function rankCandidates(
  employees: Employee[],
  requiredSkills: string[],
  limit = 3
): { employee: Employee; skillMatch: number }[] {
  return employees
    // Someone currently on leave has 0 available capacity — never a candidate for new work.
    .filter((employee) => !isCurrentlyOnLeave(employee))
    .map((employee) => ({ employee, skillMatch: computeSkillMatch(employee, requiredSkills) }))
    .filter((c) => c.skillMatch > 0)
    .sort((a, b) => b.skillMatch - a.skillMatch || a.employee.currentUtilization - b.employee.currentUtilization)
    .slice(0, limit);
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** The weeks the What-If period actually touches: `durationWeeks` weeks from the
 * scenario start (clamped to no earlier than this week — work never schedules in the
 * past), counted through to the scenario's end. */
function scenarioWindow(input: ScenarioInput): { fromWeek: Date; weeks: number; deadline: string } {
  const start = parseLooseDate(input.startDate) ?? todayStart();
  const durWeeks = Math.max(1, Math.round(input.durationWeeks));
  const endExclusive = addDays(start, durWeeks * 7);
  const fromWeek = startOfWeek(start.getTime() < todayStart().getTime() ? todayStart() : start);
  const weeks = Math.max(1, Math.ceil((endExclusive.getTime() - fromWeek.getTime()) / MS_PER_WEEK));
  return { fromWeek, weeks, deadline: formatDisplayDate(endExclusive) };
}

/** A hypothetical ticket standing in for the scenario's work, so it runs through the
 * real schedule/weekly-capacity engine exactly like any assigned ticket. */
function syntheticTicket(input: ScenarioInput, employee: Employee, hours: number, deadline: string): AssignedTicket {
  return {
    id: "whatif-scenario",
    title: input.name || "What-If project",
    description: "Hypothetical work — What-If scenario.",
    status: "In Progress",
    priority: input.priority,
    assignedUnit: employee.department,
    raisedDate: input.startDate,
    estimatedHours: Math.max(1, Math.round(hours * 10) / 10),
    slaHours: SLA_HOURS[input.priority],
    expectedResolutionDate: deadline,
    resolvedDate: null,
    createdBy: "What-If",
    assignedBy: "What-If",
    assignedEmployeeIds: [employee.id],
    relatedSkills: input.requiredSkills,
  };
}

export function runScenario(
  employees: Employee[],
  input: ScenarioInput,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  events: CalendarEvent[] = []
): {
  candidates: ScenarioCandidate[];
  allocationScenarios: AllocationScenario[];
} {
  const { fromWeek, weeks, deadline } = scenarioWindow(input);

  /** THE calculation — max weekly-average utilization over the selected period if
   * `employee` took on `hours` of the scenario. Both the candidate table and every
   * allocation scenario go through here, so their numbers can never disagree. */
  function projectedPeak(employee: Employee, hours: number): { util: number; weekLabel: string } {
    const { peakUtilization, weekly } = peakWeeklyUtilization(
      employee,
      tickets,
      getEntry,
      syntheticTicket(input, employee, hours, deadline),
      fromWeek,
      weeks,
      events
    );
    const peakWeek = weekly.reduce((a, b) => (b.utilization > a.utilization ? b : a), weekly[0]);
    return { util: peakUtilization, weekLabel: peakWeek?.label ?? "" };
  }

  /** Baseline peak over the same window WITHOUT the scenario — used only to split the
   * effort between two people by how much room each actually has in the period. */
  function baselinePeak(employee: Employee): number {
    return peakWeeklyUtilization(employee, tickets, getEntry, null, fromWeek, weeks, events).peakUtilization;
  }

  const ranked = rankCandidates(employees, input.requiredSkills, 3);

  const candidates: ScenarioCandidate[] = ranked.map(({ employee, skillMatch }) => {
    const p = projectedPeak(employee, input.estimatedHours);
    return {
      employee,
      skillMatch,
      currentUtilization: employee.currentUtilization,
      projectedUtilization: p.util,
      peakWeekLabel: p.weekLabel,
    };
  });

  const solo = (id: string, employee: Employee): AllocationScenario => {
    const p = projectedPeak(employee, input.estimatedHours);
    return {
      id,
      label: `Scenario ${id}`,
      description: `Assign to ${employee.name.split(" ")[0]}`,
      assignees: [{ employee, projected: p.util, peakWeekLabel: p.weekLabel }],
      overallProjected: p.util,
      recommended: false,
    };
  };

  const allocationScenarios: AllocationScenario[] = [];
  if (candidates[0]) allocationScenarios.push(solo("A", candidates[0].employee));
  if (candidates[1]) allocationScenarios.push(solo("B", candidates[1].employee));

  if (candidates[0] && candidates[1]) {
    const [c1, c2] = candidates;
    const roomA = Math.max(5, 100 - baselinePeak(c1.employee));
    const roomB = Math.max(5, 100 - baselinePeak(c2.employee));
    const total = roomA + roomB;
    const pA = projectedPeak(c1.employee, input.estimatedHours * (roomA / total));
    const pB = projectedPeak(c2.employee, input.estimatedHours * (roomB / total));
    allocationScenarios.push({
      id: "C",
      label: "Scenario C",
      description: `Split between ${c1.employee.name.split(" ")[0]} + ${c2.employee.name.split(" ")[0]}`,
      assignees: [
        { employee: c1.employee, projected: pA.util, peakWeekLabel: pA.weekLabel },
        { employee: c2.employee, projected: pB.util, peakWeekLabel: pB.weekLabel },
      ],
      overallProjected: Math.round((pA.util + pB.util) / 2),
      recommended: true,
    });
  }

  // Recommend the scenario with the lowest max individual projected utilization,
  // sustainable status preferred.
  let bestIdx = 0;
  let bestScore = Infinity;
  allocationScenarios.forEach((s, idx) => {
    const maxProjected = Math.max(...s.assignees.map((a) => a.projected));
    const statusPenalty = getCapacityStatus(maxProjected).key === "critical" ? 1000 : 0;
    const score = maxProjected + statusPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });
  allocationScenarios.forEach((s, idx) => (s.recommended = idx === bestIdx));

  return { candidates, allocationScenarios };
}
