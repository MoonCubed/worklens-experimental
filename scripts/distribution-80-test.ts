// Dev-only: the spec's Task-A / Task-B example for "80% is the target ceiling".
//   Task A: 2h remaining, available now, deadline 2 weeks out (flexible).
//   Task B: 32h remaining, ON HOLD until the start of next week, same deadline.
// Task B alone fills next week to exactly 80%. The scheduler must pull Task A's 2h
// into THIS week rather than nudging next week over 80%.
//   node --import ./scripts/paths-hook.mjs scripts/distribution-80-test.ts
import type { Employee } from "@/data/types";
import type { AssignedTicket } from "@/store/tickets-store";
import type { WorkLogEntry } from "@/store/work-log-store";
import { computeEmployeeSchedule, computeEmployeeWeeklyCapacity } from "@/lib/capacityEngine";
import { todayStart, addDays, startOfWeek, formatDisplayDate, isWorkingDay, dateFromKey, dateKey } from "@/lib/date";

let today = todayStart();
while (!isWorkingDay(today)) today = addDays(today, 1);
const nextWeekStart = addDays(startOfWeek(today), 7);
const nextWeekThu = addDays(nextWeekStart, 4);
const deadline = addDays(startOfWeek(today), 13); // end of the week after next-ish (2 weeks)

const emp: Employee = {
  id: "e1", name: "Test", department: "IT Service Support", level: "Employee", supervisorId: null,
  employeeIdNumber: "T1", skills: [], knowledgeAreas: [],
  workingSchedule: "Full-time · Sun-Thu · 7:00 AM-4:00 PM", weeklyHours: 40,
  workload: { project: 0, operational: 0, adhoc: 0, other: 0 }, currentUtilization: 0,
  upcomingTickets: [], adhoc: [], leaveEvents: [],
};

const taskA: AssignedTicket = {
  id: "TASK-A", title: "Task A (flexible)", description: "", status: "In Progress", priority: "Medium",
  assignedUnit: "IT Service Support", raisedDate: formatDisplayDate(today), estimatedHours: 2, slaHours: 999,
  expectedResolutionDate: formatDisplayDate(deadline), resolvedDate: null, createdBy: "x", assignedBy: "x",
  assignedEmployeeIds: ["e1"],
};
const taskB: AssignedTicket = {
  id: "TASK-B", title: "Task B (on hold until next week)", description: "", status: "On Hold", priority: "Medium",
  assignedUnit: "IT Service Support", raisedDate: formatDisplayDate(addDays(today, -3)), estimatedHours: 32, slaHours: 999,
  expectedResolutionDate: formatDisplayDate(deadline), resolvedDate: null, createdBy: "x", assignedBy: "x",
  assignedEmployeeIds: ["e1"],
  holdStartDate: formatDisplayDate(today),
  holdEndDate: formatDisplayDate(addDays(nextWeekStart, -1)), // hold clears the day before next week
};

const wl = new Map<string, WorkLogEntry>();
const getEntry = (k: string): WorkLogEntry => wl.get(k) ?? { comments: [] };

const tickets = [taskA, taskB];
const sched = computeEmployeeSchedule(emp, tickets, getEntry, []);

const thisWeek = new Set<string>();
const nextWeek = new Set<string>();
for (let d = new Date(startOfWeek(today)); d <= addDays(startOfWeek(today), 4); d = addDays(d, 1)) thisWeek.add(dateKey(d));
for (let d = new Date(nextWeekStart); d <= nextWeekThu; d = addDays(d, 1)) nextWeek.add(dateKey(d));

function bucket(item: (typeof sched.items)[number]) {
  let tw = 0, nw = 0;
  for (const key of item.workingDayKeys) {
    const h = item.dayHours[key] ?? item.dailyHours;
    if (thisWeek.has(key)) tw += h;
    else if (nextWeek.has(key)) nw += h;
  }
  return { tw: Math.round(tw * 10) / 10, nw: Math.round(nw * 10) / 10 };
}

console.log(`today ${today.toDateString()}  ·  next week ${nextWeekStart.toDateString()}–${nextWeekThu.toDateString()}\n`);
for (const item of sched.items) {
  const b = bucket(item);
  console.log(`  ${item.title.padEnd(34)} this wk ${String(b.tw).padStart(5)}h   next wk ${String(b.nw).padStart(5)}h   days=[${item.workingDayKeys.map((k) => `${dateFromKey(k).getMonth() + 1}/${dateFromKey(k).getDate()}:${(item.dayHours[k] ?? 0).toFixed(2)}`).join(" ")}]`);
}

const wk = computeEmployeeWeeklyCapacity(emp, tickets, getEntry, 3);
console.log("\nWeekly utilization:");
wk.forEach((w) => console.log(`  ${w.label} (${w.rangeLabel}): ${w.utilization}%  (${w.scheduledHours}h / ${w.workingHours}h)`));

const a = sched.items.find((i) => i.ticketId === "TASK-A")!;
const b = sched.items.find((i) => i.ticketId === "TASK-B")!;
const ab = bucket(a);
const bb = bucket(b);
const nextWeekUtil = wk[1].utilization;

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "PASS" : "FAIL"}  ${n}`); if (!p) ok = false; };
console.log("");
check("Task A's 2h is entirely in THIS week", ab.tw >= 1.9 && ab.nw <= 0.05);
check("Task B stays entirely in next week (on hold)", bb.tw <= 0.05 && bb.nw >= 31.9);
check("Next week utilization stays at/below the 80% target", nextWeekUtil <= 80);
check("This week still absorbs Task A without overload", wk[0].utilization <= 100);
check("Task A is spread evenly across this week (not dumped on one day)",
  a.workingDayKeys.filter((k) => (a.dayHours[k] ?? 0) > 0.01).length >= 3);

// --- Default behaviour: a lone flexible task on a calm calendar spreads EVENLY
// across its whole window (no unnecessary front-loading). ---
const lone: AssignedTicket = {
  ...taskA, id: "LONE", title: "Lone task", estimatedHours: 20,
  expectedResolutionDate: formatDisplayDate(addDays(startOfWeek(today), 13)),
};
const s2 = computeEmployeeSchedule(emp, [lone], getEntry, []);
const li = s2.items.find((i) => i.ticketId === "LONE")!;
const perDay = li.workingDayKeys.map((k) => li.dayHours[k] ?? 0);
const spread = Math.max(...perDay) - Math.min(...perDay);
console.log(`\nLone 20h task over ${li.workingDayKeys.length} days: [${perDay.map((h) => h.toFixed(2)).join(" ")}]`);
check("Calm calendar → lone flexible task spreads evenly across its whole window", spread <= 0.2 && li.workingDayKeys.length >= 8);

// --- Dynamic recalc: resuming Task B from hold re-plans it across the full window. ---
const resumed: AssignedTicket = { ...taskB, status: "In Progress", holdStartDate: null, holdEndDate: null };
const s3 = computeEmployeeSchedule(emp, [taskA, resumed], getEntry, []);
const rb = s3.items.find((i) => i.ticketId === "TASK-B")!;
const rbb = bucket(rb);
console.log(`\nAfter resuming Task B: this wk ${rbb.tw}h  next wk ${rbb.nw}h  (was 0h / 32h on hold)`);
check("Resuming Task B re-spreads its work into this week too", rbb.tw > 0.5);

console.log(ok ? "\n✅ flexible work pulled earlier to keep the future week at/below 80%" : "\n❌ 80% distribution rule not met");
process.exitCode = ok ? 0 : 1;
