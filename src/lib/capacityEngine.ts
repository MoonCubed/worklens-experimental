// The one shared source of truth for "how busy is this employee right now" and "is this
// work item done, blocked, or at risk" — used by the Supervisor Dashboard, Team Capacity,
// and the employee capacity pages alike, so they can never disagree with each other.
//
// Architecture note: rather than making every consumer (ticket-candidate ranking, the
// Handover/What-If simulators, Team Capacity's table/card views, StatusBadge colors, ...)
// recompute this independently, `CapacitySyncEngine` (mounted once at the app root) is the
// only thing that WRITES the result back onto `Employee.currentUtilization` — every other
// page keeps reading that same stored field exactly as before. That keeps this fix scoped
// to "make the number correct and keep it correct" rather than a rewrite of every page that
// happens to read utilization.

import type { AdhocItem, Employee, LeaveEvent, WorkflowStatus } from "@/data/types";
import type { AssignedTicket } from "@/store/tickets-store";
import type { TicketStatus } from "@/data/tickets";
import {
  todayStart,
  parseLooseDate,
  getDueStatus,
  startOfWeek,
  resolveDueDate,
  dateKey,
  dateFromKey,
  isWorkingDay,
  weekOfYear,
  weekLabel,
  weekRangeLabel,
  addDays,
  formatDisplayDate,
} from "@/lib/date";
import { ticketDueLabel, adhocDueLabel } from "@/lib/due";
import { availableCapacity } from "@/lib/capacity";
import type { CalendarEvent } from "@/store/calendar-events-store";
import { RECOMMENDED_CAPACITY } from "@/data/config";

export interface WorkLogLookup {
  (key: string): {
    workflowStatus?: WorkflowStatus;
    progress?: number;
    completedAt?: string | null;
    holdStartDate?: string | null;
    holdEndDate?: string | null;
    actualHours?: number | null;
    remainingHours?: number | null;
    progressUpdatedAt?: string | null;
  };
}

// ============================================================================
// Employee calendar events — a timed personal commitment ("Doctor Appointment ·
// 09:00–10:00") is time the employee is unavailable for task work, so it reduces
// their available working hours for that day. This is the ONE place that turns
// calendar events into an hours figure; every capacity function takes the event
// list and subtracts it the same way, so Employee/Team/Supervisor capacity, the
// Daily Tasks view, Plan My Day and the Workload View can never disagree. Untimed
// calendar entries are plain notes and never affect capacity, and no calendar
// event ever changes the employee's official working-hours profile.
// ============================================================================

/** Minutes past midnight for a 24h "HH:MM" string, or null. */
function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(mins) && mins >= 0 && mins <= 24 * 60 ? mins : null;
}

/** Duration in hours of a timed calendar event (0 when both times aren't set, or end
 * isn't after start — an untimed calendar note contributes nothing to capacity). */
export function calendarEventHours(ev: Pick<CalendarEvent, "startTime" | "endTime">): number {
  const s = timeToMinutes(ev.startTime);
  const e = timeToMinutes(ev.endTime);
  if (s == null || e == null || e <= s) return 0;
  return Math.round(((e - s) / 60) * 100) / 100;
}

/** Hours `employeeId` is committed to personal calendar events on `date` — 0 on a
 * non-working day (those hours weren't available anyway). */
export function calendarEventHoursOn(events: CalendarEvent[], employeeId: string, date: Date): number {
  if (!isWorkingDay(date)) return 0;
  const key = dateKey(date);
  let hours = 0;
  events.forEach((ev) => {
    if (ev.authorId !== employeeId) return;
    const d = parseLooseDate(ev.date);
    if (!d || dateKey(d) !== key) return;
    hours += calendarEventHours(ev);
  });
  return Math.round(hours * 100) / 100;
}

/** Personal calendar-event hours for `employeeId` across the working days in
 * `[start, end]` — the amount to subtract from a week's available working hours. */
export function calendarEventHoursBetween(events: CalendarEvent[], employeeId: string, start: Date, end: Date): number {
  if (start > end) return 0;
  let total = 0;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    total += calendarEventHoursOn(events, employeeId, cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
  return Math.round(total * 10) / 10;
}

export interface DayCalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  hours: number;
}

/** The timed calendar events `employeeId` has on `date`, for display in day views. */
export function calendarEventsOn(events: CalendarEvent[], employeeId: string, date: Date): DayCalendarEvent[] {
  const key = dateKey(date);
  return events
    .filter((ev) => {
      if (ev.authorId !== employeeId || calendarEventHours(ev) <= 0) return false;
      const d = parseLooseDate(ev.date);
      return !!d && dateKey(d) === key;
    })
    .map((ev) => ({
      id: ev.id,
      title: ev.title,
      startTime: ev.startTime as string,
      endTime: ev.endTime as string,
      hours: calendarEventHours(ev),
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** A task is done once it's Completed on the ticket itself (the supervisor's or
 * IT-Demand's call) OR the assignee has marked their personal tracking Completed —
 * either should free up their capacity. Ad-hoc items have no system-of-record status of
 * their own, so only the work-log's Completed applies. */
export function isItemComplete(workflowStatus: WorkflowStatus | undefined, ticketStatus?: TicketStatus): boolean {
  if (workflowStatus === "Completed") return true;
  if (ticketStatus === "Completed") return true;
  return false;
}

/**
 * Has an On Hold task's hold window elapsed?
 *
 * A hold with an end date pauses the task only until that date passes; the day after,
 * the task auto-resumes normal scheduling (its remaining effort re-spread across the
 * working days that are left before its deadline) even though its stored status is
 * still "On Hold". A hold with no end date is open-ended and never auto-resumes.
 */
export function holdEndPassed(holdEndDate: string | null | undefined): boolean {
  if (!holdEndDate) return false;
  const end = parseLooseDate(holdEndDate);
  return !!end && end.getTime() < todayStart().getTime();
}

/** The share of a ticket's estimated effort that falls on `employeeId`. A solo owner
 * carries the whole estimate; co-owners share it per the ticket's `effortSplit`, or
 * evenly when no split is set. Keeps both employees' capacity consistent with the
 * task's total effort. */
export function ticketEffortForEmployee(
  ticket: { estimatedHours: number; assignedEmployeeIds?: string[]; effortSplit?: Record<string, number> },
  employeeId: string
): number {
  const ids = ticket.assignedEmployeeIds ?? [];
  if (ids.length <= 1) return ticket.estimatedHours;
  const split = ticket.effortSplit;
  if (split && typeof split[employeeId] === "number") return split[employeeId];
  return Math.round((ticket.estimatedHours / ids.length) * 10) / 10;
}

/** Remaining effort for one work item — the full estimate once progress/completion is
 * factored in. Completed work is always 0h remaining regardless of a stale progress
 * value. When the employee has logged an explicit remaining-effort estimate
 * (`remainingOverride`), that wins over the progress-derived figure — a task that
 * turned out larger or smaller than its original estimate reschedules from the real
 * number rather than blindly trusting `estimate × (1 − progress)`. */
export function itemRemainingHours(
  estimatedHours: number,
  complete: boolean,
  progress: number | undefined,
  remainingOverride?: number | null
): number {
  if (complete) return 0;
  if (typeof remainingOverride === "number" && remainingOverride >= 0) {
    return Math.round(remainingOverride * 10) / 10;
  }
  const pct = Math.min(100, Math.max(0, progress ?? 0));
  return Math.round(estimatedHours * (1 - pct / 100) * 10) / 10;
}

/** When work on an item is assumed to start — the ticket's raised date if it's already
 * passed, otherwise today. Ad-hoc items have no raised date, so they start today. */
export function itemStartDate(raisedDate?: string | null): Date {
  const today = todayStart();
  const raised = raisedDate ? parseLooseDate(raisedDate) : null;
  return raised && raised < today ? raised : today;
}

/** True when an approved leave event covers `date`. */
export function isOnLeaveDate(employee: Employee, date: Date): boolean {
  return employee.leaveEvents.some((l) => {
    if (l.status === "Pending") return false;
    const s = parseLooseDate(l.start);
    const e = parseLooseDate(l.end);
    return !!s && !!e && date >= s && date <= e;
  });
}

/**
 * The working days across which an item's remaining effort is spread: every day from
 * `from` up to and including the `deadline` that is a working day (Sun–Thu) **and** not
 * an approved-leave day for this employee. Returns `YYYY-MM-DD` keys.
 *
 * Empty when the deadline has already passed relative to `from` — the caller collapses
 * that onto "due now" (see `DUE_NOW`).
 */
export function scheduledWorkingDayKeys(from: Date, deadline: Date, employee: Employee): string[] {
  const keys: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  let guard = 0;
  while (cursor <= last && guard < 1000) {
    guard += 1;
    if (isWorkingDay(cursor) && !isOnLeaveDate(employee, cursor)) keys.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** Approved-leave working days for `employee` that fall within `[start, end]`. */
export function leaveWorkingDaysBetween(employee: Employee, start: Date, end: Date): number {
  if (start > end) return 0;
  let days = 0;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    if (isWorkingDay(cursor) && isOnLeaveDate(employee, cursor)) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// ============================================================================
// Task schedule — the ONE model of "which hours of which task land on which day".
// Every deadline-driven number in WorkLens (employee capacity, team capacity,
// assignment projections, the Daily Tasks view, the calendar, Task Details) is
// derived from this so no screen can drift onto its own scheduling maths.
//
//   Remaining Task Hours ÷ Remaining Available Working Days Until Deadline = Daily Hours
//
// where "available working days" excludes weekends, approved leave, and days before
// the task can actually be worked. An explicit deadline always wins; with none, the
// priority's SLA window stands in (High 24h / Medium 1 week / Low 1 month).
//
// ON HOLD is purely date-driven — never `if status === "On Hold" → no schedule":
//
//   • work can't be scheduled before the day AFTER the hold end date
//   • so a held task's remaining hours land on [holdEnd + 1 … deadline], and are
//     therefore absent from every day up to and including the hold end date, and
//     present (normally) from the day after
//   • `heldNow` (today ≤ holdEnd) only decides whether to show "On Hold — resumes …"
//     context; the per-day hours are identical whether you look during or after the hold
// ============================================================================

export interface ScheduledWorkItem {
  key: string;
  title: string;
  type: "Ticket" | "Ad-hoc";
  ticketId?: string;
  priority: "High" | "Medium" | "Low";
  /** The stored status. Completed items are never scheduled. */
  status: "In Progress" | "On Hold";
  /** The hold end date (parsed), when the task is On Hold with a window. */
  heldUntil: Date | null;
  /** Today is on or before the hold end date — the task is paused *right now*
   * (its scheduled hours all fall after `heldUntil`). */
  heldNow: boolean;
  /** "16 Sep 2026" — the first day work resumes, while `heldNow`. Null otherwise. */
  resumesOn: string | null;
  /** Stored status is On Hold but the hold window has already passed — it's scheduled
   * normally again from its remaining hours over the working days left. */
  resumedFromHold: boolean;
  /** Its deadline is on/before the first day work can resume — it cannot be met. */
  deadlineUnreachable: boolean;
  /** Scheduled (not held) and past its deadline. */
  overdue: boolean;
  /** Has an incomplete prerequisite ticket, so its work is held back until the
   * prerequisite's due date. */
  blockedByDependency: boolean;
  /** The prerequisite's title, while `blockedByDependency`. */
  dependencyTitle: string | null;
  /** `remainingHours` came from an employee-logged remaining-effort figure rather
   * than `estimate × (1 − progress)`. */
  remainingOverridden: boolean;
  /** This item is on the schedule because the person is *covering* it for its owner
   * during a turnover — they carry only the frozen coverage days/hours, and ownership
   * has not transferred. */
  isCoverage: boolean;
  /** While `isCoverage`, the owner this person is covering for. */
  coverageOwnerName: string | null;
  /** For the OWNER of a covered ticket — the window their planned days were handed to
   * a cover, so those days no longer appear on their own schedule. Null otherwise. */
  coveredAway: { start: string; end: string; coveringName: string; hours: number } | null;
  remainingHours: number;
  totalHours: number;
  progress: number;
  startDate: Date;
  deadline: Date;
  /** `YYYY-MM-DD` keys the remaining effort is spread across — the real distribution
   * even while held (those days are simply all after `heldUntil`). Empty only when
   * there is genuinely nothing to schedule (no remaining hours). */
  workingDayKeys: string[];
  /** `remainingHours ÷ workingDayKeys.length` — the even per-day AVERAGE. Kept for
   * simple "≈Xh/day" displays; the real, possibly uneven, per-day amount is `dayHours`. */
  dailyHours: number;
  /** The real hours landing on each of `workingDayKeys`, keyed by date. Starts as the
   * even `dailyHours` split, then — for non-fixed items — is reshaped by
   * `applyRoomAwareDistribution` to favour days/weeks where the employee actually has
   * spare capacity over ones already full, without ever moving work past its deadline
   * or changing the total. Always sums to ~`remainingHours`. */
  dayHours: Record<string, number>;
}

export interface DayAllocation {
  item: ScheduledWorkItem;
  hours: number;
}

export interface EmployeeDayPlan {
  date: Date;
  key: string;
  /** e.g. "Monday". */
  weekdayLabel: string;
  isToday: boolean;
  /** A working day (Sun–Thu) that is not an approved-leave day. */
  isWorkingDay: boolean;
  onLeave: boolean;
  allocations: DayAllocation[];
  totalHours: number;
  /** Timed personal calendar events on this day. */
  calendarEvents: DayCalendarEvent[];
  /** Hours lost to those calendar events. */
  eventHours: number;
  /** Working hours actually available for task work this day — contracted hours per
   * day minus calendar-event hours, and 0 on leave. */
  availableHours: number;
}

export interface EmployeeSchedule {
  employeeId: string;
  /** Every non-completed item, each with its real day-by-day distribution (a held
   * task's days are all after its hold end date). */
  items: ScheduledWorkItem[];
  /** Items being worked right now — everything except those still inside a hold
   * window (`heldNow`). */
  activeItems: ScheduledWorkItem[];
  /** Allocations landing on one day. */
  allocationsForDay: (key: string) => DayAllocation[];
  /** That item's scheduled hours that fall in the current (Sunday-based) week. */
  currentWeekHoursByKey: Map<string, number>;
  /** The next `workingDays` working days from `from` (inclusive), each with its
   * planned tasks and total planned hours. Non-working days in between are skipped. */
  planForRange: (from: Date, workingDays: number) => EmployeeDayPlan[];
  /** Deadline-driven hours landing in the current (Sunday-based) week — the value
   * `computeEmployeeCapacity` turns into utilization. */
  weeklyScheduledHours: number;
}

function buildScheduledItem(params: {
  key: string;
  title: string;
  type: "Ticket" | "Ad-hoc";
  ticketId?: string;
  priority: "High" | "Medium" | "Low";
  status: "In Progress" | "On Hold";
  /** Parsed hold end date, if the task is On Hold with a window. */
  heldUntil: Date | null;
  remainingHours: number;
  totalHours: number;
  progress: number;
  startDate: Date;
  deadline: Date;
  employee: Employee;
  /** `remainingHours` was employee-logged rather than progress-derived. */
  remainingOverridden?: boolean;
  /** Earliest day work can start because of an incomplete prerequisite ticket. */
  dependencyStart?: Date | null;
  dependencyTitle?: string | null;
  /** This person is covering the item for its owner — set from a frozen coverage plan. */
  isCoverage?: boolean;
  coverageOwnerName?: string | null;
  coveredAway?: ScheduledWorkItem["coveredAway"];
  /** Day keys handed to a cover — removed from this (owner's) schedule while the
   * per-day rate stays constant. */
  excludeDayKeys?: Set<string> | null;
  /** Force the item onto exactly these day keys (a coverage item's frozen days),
   * bypassing normal deadline scheduling. */
  forceDayKeys?: string[] | null;
}): ScheduledWorkItem {
  const {
    employee,
    heldUntil,
    remainingOverridden = false,
    dependencyStart = null,
    dependencyTitle = null,
    isCoverage = false,
    coverageOwnerName = null,
    coveredAway = null,
    excludeDayKeys = null,
    forceDayKeys = null,
    ...rest
  } = params;
  const { remainingHours, startDate, deadline } = rest;
  const today = todayStart();

  // Date-driven hold: work can't be scheduled until the day AFTER the hold ends.
  const dayAfterHold = heldUntil ? addDays(heldUntil, 1) : null;
  const heldNow = !!heldUntil && heldUntil.getTime() >= today.getTime();
  const resumesOn = heldNow && dayAfterHold ? formatDisplayDate(dayAfterHold) : null;
  const resumedFromHold = !!heldUntil && !heldNow;

  // Earliest schedulable day: not before the task's start, not before today, not
  // before the day after any hold ends, and not before an unfinished prerequisite's
  // due date (basic dependencies — dependent work never lands ahead of what it needs).
  let from = startDate > today ? new Date(startDate) : new Date(today);
  if (dayAfterHold && dayAfterHold.getTime() > from.getTime()) from = dayAfterHold;
  const blockedByDependency = !isCoverage && !!dependencyStart && dependencyStart.getTime() > from.getTime();
  if (blockedByDependency && dependencyStart) from = new Date(dependencyStart);

  const extra = { blockedByDependency, dependencyTitle: blockedByDependency ? dependencyTitle : null, remainingOverridden, isCoverage, coverageOwnerName, coveredAway };

  if (remainingHours <= 0) {
    return { ...rest, ...extra, heldUntil, heldNow, resumesOn, resumedFromHold, deadlineUnreachable: false, overdue: false, workingDayKeys: [], dailyHours: 0, dayHours: {} };
  }

  // A coverage item runs on its frozen days at the owner's original rate — fixed, and
  // deliberately excluded from the room-aware reshaping pass below.
  if (forceDayKeys) {
    const keys = forceDayKeys.slice();
    const rate = keys.length ? Math.round((remainingHours / keys.length) * 100) / 100 : 0;
    return {
      ...rest,
      ...extra,
      heldUntil,
      heldNow,
      resumesOn,
      resumedFromHold,
      deadlineUnreachable: false,
      overdue: false,
      workingDayKeys: keys,
      dailyHours: rate,
      dayHours: Object.fromEntries(keys.map((k) => [k, rate])),
    };
  }

  let workingDayKeys = deadline.getTime() < from.getTime() ? [] : scheduledWorkingDayKeys(from, deadline, employee);
  // No room before the deadline (deadline already passed, or falls entirely on
  // weekends/leave, or is before the hold ends) → surface the risk on the first day
  // work can actually happen rather than hiding the task.
  const deadlineUnreachable = workingDayKeys.length === 0;
  if (deadlineUnreachable) workingDayKeys = [dateKey(from)];

  const overdue = !heldNow && deadline.getTime() < today.getTime();
  // The baseline even rate — `applyRoomAwareDistribution` (run once per employee, after
  // every item is built) reshapes `dayHours` from this to favour days/weeks with spare
  // capacity; this average is kept for simple "≈Xh/day" displays. Handing some days to
  // a cover removes them from this schedule without compressing what's left onto fewer days.
  const dailyHours = Math.round((remainingHours / workingDayKeys.length) * 100) / 100;
  if (excludeDayKeys && excludeDayKeys.size > 0) {
    workingDayKeys = workingDayKeys.filter((k) => !excludeDayKeys.has(k));
  }
  const dayHours = Object.fromEntries(workingDayKeys.map((k) => [k, dailyHours]));
  return { ...rest, ...extra, heldUntil, heldNow, resumesOn, resumedFromHold, deadlineUnreachable, overdue, workingDayKeys, dailyHours, dayHours };
}

/** Display progress for an item — the employee-logged remaining figure, expressed as a
 * percentage of the estimate when present, otherwise the logged progress value. */
function progressForItem(estimate: number, progress: number | undefined, remainingOverride: number | null | undefined): number {
  if (typeof remainingOverride === "number" && remainingOverride >= 0 && estimate > 0) {
    return Math.min(100, Math.max(0, Math.round((1 - remainingOverride / estimate) * 100)));
  }
  return Math.min(100, Math.max(0, progress ?? 0));
}

// ============================================================================
// Room-aware distribution — "even distribution within an 80% capacity envelope".
//
// Every item starts with the even `dailyHours` split (above). This pass then reshapes
// each FLEXIBLE item's `dayHours` — never its total, never past its deadline, never
// before its start/hold — so the work lands on days that still have headroom BELOW
// the 80% target, spread as evenly as possible across those days. Only when the work
// genuinely cannot fit under 80% before the deadline does it spill into the 80–100%
// band, and only when it cannot fit under 100% either does it fall back to the plain
// even split (so the overload / At-Risk signal is never hidden by the reshaping).
//
// Because the least-slack (most time-constrained) items are distributed FIRST — an
// On-Hold task that can only run next week, a task due in three days — they claim
// their room before a looser task can bleed flexible effort into it. So a small
// flexible task is pulled into earlier capacity rather than pushing a future week
// over 80% (the Task-A / Task-B example in the spec).
//
// Fixed items (turnover coverage, `isCoverage`) are a frozen commitment — they still
// occupy their days (reducing everyone else's room) but are never themselves reshaped.
// ============================================================================

const ITEM_PRIORITY_RANK: Record<ScheduledWorkItem["priority"], number> = { High: 0, Medium: 1, Low: 2 };

/** The target capacity ceiling for spreading work — the scheduler prefers schedules
 * where no day crosses this, and only goes above it when a deadline leaves no choice. */
const DISTRIBUTION_TARGET_RATIO = RECOMMENDED_CAPACITY / 100; // 0.80

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Spread `hours` across `days` as evenly as possible with no day exceeding its
 * `caps[i]` — classic water-filling: give every still-open day an equal share, pin
 * the ones that overflow at their cap, and repeat with the surplus over the rest.
 * The total placed always equals `hours` (any rounding residue lands on the day with
 * the most remaining room). */
function waterfill(days: string[], caps: number[], hours: number): Record<string, number> {
  const out = days.map(() => 0);
  let left = hours;
  let open = days.map((_, i) => i).filter((i) => caps[i] > 0.005);
  for (let guard = 0; guard <= days.length + 1 && left > 0.005 && open.length > 0; guard++) {
    const share = left / open.length;
    const next: number[] = [];
    for (const i of open) {
      const take = Math.min(caps[i] - out[i], share);
      out[i] += take;
      left -= take;
      if (caps[i] - out[i] > 0.005) next.push(i);
    }
    open = next;
  }
  const rounded = out.map(round2);
  let drift = round2(hours - rounded.reduce((s, v) => s + v, 0));
  if (Math.abs(drift) > 0.005 && days.length > 0) {
    let best = 0;
    let bestScore = -Infinity;
    days.forEach((_, i) => {
      const score = drift > 0 ? caps[i] - rounded[i] : rounded[i];
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    rounded[best] = Math.max(0, round2(rounded[best] + drift));
    drift = 0;
  }
  return Object.fromEntries(days.map((d, i) => [d, Math.max(0, rounded[i])]));
}

function applyRoomAwareDistribution(employee: Employee, items: ScheduledWorkItem[], events: CalendarEvent[]): void {
  const active = items.filter((i) => i.remainingHours > 0 && i.workingDayKeys.length > 0);
  if (active.length === 0) return;

  const perDay = (employee.weeklyHours || 40) / 5;
  const ceilingCache = new Map<string, number>();
  function ceiling(key: string): number {
    let val = ceilingCache.get(key);
    if (val === undefined) {
      const date = dateFromKey(key);
      val = isOnLeaveDate(employee, date) ? 0 : Math.max(0, round2(perDay - calendarEventHoursOn(events, employee.id, date)));
      ceilingCache.set(key, val);
    }
    return val;
  }

  // Hours already claimed on each day, across items processed so far.
  const used = new Map<string, number>();

  // Fixed commitments claim their days first but are never themselves redistributed.
  const fixed = active.filter((i) => i.isCoverage);
  const flexible = active.filter((i) => !i.isCoverage);
  fixed.forEach((item) => {
    item.workingDayKeys.forEach((key) => used.set(key, (used.get(key) ?? 0) + (item.dayHours[key] ?? item.dailyHours)));
  });

  // Slack = hours of headroom this task has inside its OWN available window, measured
  // against the 80% target. ~0 (or negative) → it has no room to move and must fill
  // its window now; large → it can go almost anywhere. Least-slack (most constrained)
  // work is distributed first, so it claims its room before looser work can spread
  // flexible effort into the same days. Ties fall back to earliest deadline / priority.
  const slackOf = (item: ScheduledWorkItem) =>
    item.workingDayKeys.reduce((s, k) => s + DISTRIBUTION_TARGET_RATIO * ceiling(k), 0) - item.remainingHours;
  const slackCache = new Map(flexible.map((i) => [i.key, slackOf(i)] as const));
  flexible.sort(
    (a, b) =>
      (slackCache.get(a.key)! - slackCache.get(b.key)!) ||
      a.deadline.getTime() - b.deadline.getTime() ||
      ITEM_PRIORITY_RANK[a.priority] - ITEM_PRIORITY_RANK[b.priority] ||
      a.key.localeCompare(b.key)
  );

  flexible.forEach((item) => {
    const keys = item.workingDayKeys;
    const total = item.remainingHours;
    // Per day: room left below the 80% target, and room left up to the full day.
    const softRoom = keys.map((k) => Math.max(0, round2(DISTRIBUTION_TARGET_RATIO * ceiling(k) - (used.get(k) ?? 0))));
    const hardRoom = keys.map((k) => Math.max(0, round2(ceiling(k) - (used.get(k) ?? 0))));

    const belowIdx = keys.map((_, i) => (softRoom[i] > 0.005 ? i : -1)).filter((i) => i >= 0);
    const belowTotal = round2(belowIdx.reduce((s, i) => s + softRoom[i], 0));
    const hardTotal = round2(hardRoom.reduce((s, r) => s + r, 0));

    let dayHours: Record<string, number>;
    if (belowIdx.length > 0 && belowTotal >= total - 0.05) {
      // Fits entirely under the 80% target on the days that still have headroom for it
      // — spread it evenly across ONLY those days, leaving days/weeks already at the
      // target untouched. (Default balanced distribution when the whole window is calm.)
      const days = belowIdx.map((i) => keys[i]);
      const filled = waterfill(days, belowIdx.map((i) => softRoom[i]), total);
      dayHours = Object.fromEntries(keys.map((k) => [k, filled[k] ?? 0]));
    } else if (hardTotal >= total - 0.05) {
      // Can't keep every day under 80% before the deadline — fill the sub-80% headroom
      // evenly first, then spill the remainder evenly into the 80–100% band. Not a true
      // overload; the At-Risk (>80%) indicator surfaces for the days that had to go over.
      const soft = waterfill(keys.slice(), softRoom.slice(), Math.min(total, belowTotal));
      const spill = round2(total - Object.values(soft).reduce((s, v) => s + v, 0));
      const bandRoom = keys.map((k, i) => Math.max(0, round2(hardRoom[i] - (soft[k] ?? 0))));
      const over = spill > 0.005 ? waterfill(keys.slice(), bandRoom, spill) : {};
      dayHours = Object.fromEntries(keys.map((k) => [k, round2((soft[k] ?? 0) + (over[k] ?? 0))]));
    } else {
      // Genuinely not enough capacity before the deadline even at 100% — keep the plain
      // even split so the overload warning stays visible (nothing hidden by reshaping).
      dayHours = { ...item.dayHours };
    }

    keys.forEach((key) => used.set(key, (used.get(key) ?? 0) + (dayHours[key] ?? 0)));
    // Drop any day the reshape left at zero — `workingDayKeys` means "days this item
    // actually has hours on" everywhere else in the app (week membership, turnover
    // day counts, calendar rows), so a day it no longer touches shouldn't linger in it.
    item.workingDayKeys = keys.filter((key) => (dayHours[key] ?? 0) > 0.01);
    item.dayHours = dayHours;
  });
}

/**
 * The hours one already-scheduled item (real ticket or ad-hoc work) contributes on
 * each working day within `[start, end]` — read straight from its actual, real
 * schedule (`item.dayHours`, after room-aware distribution), never recomputed
 * separately. Used to freeze a turnover coverage plan onto exactly the owner's real
 * planned days/hours for the leave window, and to show "planned effort during the
 * leave" for any affected item — so a cover always receives precisely what the owner
 * would actually have done those days, never a compressed or re-derived approximation.
 */
export function itemHoursInRange(
  item: ScheduledWorkItem,
  start: Date,
  end: Date
): { allocations: { dateKey: string; hours: number }[]; hours: number } {
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const allocations = item.workingDayKeys
    .filter((k) => {
      const d = dateFromKey(k);
      return d >= s && d <= e;
    })
    .sort()
    .map((k) => ({ dateKey: k, hours: item.dayHours[k] ?? item.dailyHours }));
  return { allocations, hours: Math.round(allocations.reduce((sum, a) => sum + a.hours, 0) * 10) / 10 };
}

/** The task schedule for one employee — see the block comment above. `events` (the
 * employee's own timed calendar commitments) only shape the per-day available-hours
 * figure in `planForRange`; they never change task workload. A ticket with an active
 * `coverage` plan has its covered days moved from the owner's schedule onto the
 * cover's — at the owner's original per-day rate — for the coverage window only. */
export function computeEmployeeSchedule(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  events: CalendarEvent[] = []
): EmployeeSchedule {
  const items: ScheduledWorkItem[] = [];
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  tickets
    .filter((t) => (t.assignedEmployeeIds ?? []).includes(employee.id))
    .forEach((t) => {
      const entry = getEntry(`${employee.id}:${t.id}`);
      // A ticket's own status is the single source of truth for a ticket.
      if (isItemComplete(undefined, t.status)) return;
      const onHold = t.status === "On Hold";
      // Hold is date-driven from the stored hold end date — the status string never
      // decides "not scheduled".
      const heldUntil = onHold && t.holdEndDate ? parseLooseDate(t.holdEndDate) : null;
      const effort = ticketEffortForEmployee(t, employee.id);
      const override = typeof entry.remainingHours === "number" ? entry.remainingHours : null;
      const remaining = itemRemainingHours(effort, false, entry.progress, override);
      // Basic dependency: an unfinished prerequisite holds this work back until its due date.
      const prereq = t.dependsOnTicketId ? ticketById.get(t.dependsOnTicketId) : undefined;
      const prereqBlocking = !!prereq && prereq.id !== t.id && prereq.status !== "Completed";
      // Time-boxed coverage: this employee OWNS the ticket but a cover carries the days
      // inside the coverage window — remove those from the owner's own schedule.
      const cov = t.coverage && t.coverage.ownerId === employee.id ? t.coverage : null;
      items.push(
        buildScheduledItem({
          key: `${employee.id}:${t.id}`,
          title: t.title,
          type: "Ticket",
          ticketId: t.id,
          priority: t.priority,
          status: onHold ? "On Hold" : "In Progress",
          heldUntil,
          remainingHours: remaining,
          totalHours: effort,
          progress: progressForItem(effort, entry.progress, override),
          remainingOverridden: override != null,
          startDate: itemStartDate(t.raisedDate),
          deadline: resolveDueDate(t.expectedResolutionDate, t.priority, t.raisedDate),
          dependencyStart: prereqBlocking
            ? resolveDueDate(prereq!.expectedResolutionDate, prereq!.priority, prereq!.raisedDate)
            : null,
          dependencyTitle: prereqBlocking ? `${prereq!.title} (${prereq!.id})` : null,
          excludeDayKeys: cov ? new Set(cov.allocations.map((a) => a.dateKey)) : null,
          coveredAway: cov
            ? { start: cov.startDate, end: cov.endDate, coveringName: cov.coveringName, hours: cov.hours }
            : null,
          employee,
        })
      );
    });

  employee.adhoc.forEach((a) => {
    const entry = getEntry(`${employee.id}:${a.id}`);
    if (isItemComplete(entry.workflowStatus)) return;
    const onHold = entry.workflowStatus === "On Hold";
    const heldUntil = onHold && entry.holdEndDate ? parseLooseDate(entry.holdEndDate) : null;
    const override = typeof entry.remainingHours === "number" ? entry.remainingHours : null;
    const remaining = itemRemainingHours(a.estimatedHours, false, entry.progress, override);
    // No explicit deadline → SLA window from today establishes the schedule.
    const deadline = resolveDueDate(a.deadline === "Ongoing" ? null : a.deadline, a.priority);
    items.push(
      buildScheduledItem({
        key: `${employee.id}:${a.id}`,
        title: a.name,
        type: "Ad-hoc",
        priority: a.priority,
        status: onHold ? "On Hold" : "In Progress",
        heldUntil,
        remainingHours: remaining,
        totalHours: a.estimatedHours,
        progress: progressForItem(a.estimatedHours, entry.progress, override),
        remainingOverridden: override != null,
        startDate: todayStart(),
        deadline,
        employee,
      })
    );
  });

  // Coverage this employee is providing for someone else's ticket during their leave —
  // exactly the frozen days/hours from the accepted turnover, at the owner's rate.
  tickets.forEach((t) => {
    const cov = t.coverage;
    if (!cov || cov.coveringEmployeeId !== employee.id) return;
    if (isItemComplete(undefined, t.status)) return;
    const keys = cov.allocations.map((a) => a.dateKey);
    if (keys.length === 0) return;
    items.push(
      buildScheduledItem({
        key: `${employee.id}:${t.id}:coverage`,
        title: t.title,
        type: "Ticket",
        ticketId: t.id,
        priority: t.priority,
        status: "In Progress",
        heldUntil: null,
        remainingHours: cov.hours,
        totalHours: cov.hours,
        progress: 0,
        startDate: todayStart(),
        deadline: resolveDueDate(t.expectedResolutionDate, t.priority, t.raisedDate),
        employee,
        isCoverage: true,
        coverageOwnerName: cov.ownerName,
        forceDayKeys: keys,
      })
    );
  });

  // Reshape each item's day-by-day hours to favour days/weeks where this employee
  // actually has spare capacity over ones already full from their other work — see
  // the block comment above `applyRoomAwareDistribution`. Totals, deadlines and the
  // held/coverage/dependency windows already computed above are never changed by this.
  applyRoomAwareDistribution(employee, items, events);

  // Everything not currently paused by an active hold window — used where "what's
  // being worked right now" matters (a held task's hours still appear on their
  // scheduled future days regardless).
  const activeItems = items.filter((i) => !i.heldNow);

  const byDay = new Map<string, DayAllocation[]>();
  items.forEach((item) => {
    item.workingDayKeys.forEach((k) => {
      const list = byDay.get(k) ?? [];
      list.push({ item, hours: item.dayHours[k] ?? item.dailyHours });
      byDay.set(k, list);
    });
  });

  const allocationsForDay = (key: string) => byDay.get(key) ?? [];

  const perDayContractedHours = (employee.weeklyHours || 40) / 5;

  const planForRange = (from: Date, workingDays: number): EmployeeDayPlan[] => {
    const plans: EmployeeDayPlan[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const today = todayStart();
    let guard = 0;
    while (plans.length < workingDays && guard < 400) {
      guard += 1;
      const working = isWorkingDay(cursor);
      const onLeave = isOnLeaveDate(employee, cursor);
      if (working) {
        const key = dateKey(cursor);
        const allocations = allocationsForDay(key);
        const calendarEvents = calendarEventsOn(events, employee.id, cursor);
        const eventHours = Math.round(calendarEvents.reduce((s, e) => s + e.hours, 0) * 10) / 10;
        plans.push({
          date: new Date(cursor),
          key,
          weekdayLabel: cursor.toLocaleDateString("en-US", { weekday: "long" }),
          isToday: cursor.getTime() === today.getTime(),
          isWorkingDay: working && !onLeave,
          onLeave,
          allocations,
          totalHours: Math.round(allocations.reduce((s, a) => s + a.hours, 0) * 10) / 10,
          calendarEvents,
          eventHours,
          availableHours: onLeave ? 0 : Math.max(0, Math.round((perDayContractedHours - eventHours) * 10) / 10),
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return plans;
  };

  // Hours landing in the current Sunday-based week — each item's daily distribution
  // summed over the days it's scheduled that fall in this week. A task still inside
  // its hold window contributes 0 here unless its post-hold days reach into this week.
  const { start: weekStart, end: weekEnd } = currentWeekBounds(todayStart());
  const currentWeekHoursByKey = new Map<string, number>();
  let weeklyScheduledHours = 0;
  items.forEach((item) => {
    const inWeekKeys = item.workingDayKeys.filter((k) => {
      const d = dateFromKey(k);
      return d >= weekStart && d <= weekEnd;
    });
    const hrs = Math.round(inWeekKeys.reduce((s, k) => s + (item.dayHours[k] ?? item.dailyHours), 0) * 100) / 100;
    currentWeekHoursByKey.set(item.key, hrs);
    weeklyScheduledHours += hrs;
  });
  weeklyScheduledHours = Math.round(weeklyScheduledHours * 10) / 10;

  return {
    employeeId: employee.id,
    items,
    activeItems,
    allocationsForDay,
    currentWeekHoursByKey,
    planForRange,
    weeklyScheduledHours,
  };
}

/**
 * The effort (hours) one work item places on an employee **in the current week**,
 * driven by its deadline — the same even day-by-day distribution the Daily Tasks view
 * shows, summed over this week's working days. Used for assignment projections where a
 * full `computeEmployeeSchedule` isn't to hand.
 */
export function weeklyRequiredHoursForItem(
  remainingHours: number,
  start: Date,
  due: Date,
  employee: Employee
): number {
  if (remainingHours <= 0) return 0;
  const today = todayStart();
  const from = start > today ? start : today;
  let keys = due < from ? [] : scheduledWorkingDayKeys(from, due, employee);
  if (keys.length === 0) keys = [dateKey(today)];
  const perDay = remainingHours / keys.length;
  const { start: weekStart, end: weekEnd } = currentWeekBounds(today);
  const inWeek = keys.filter((k) => {
    const d = dateFromKey(k);
    return d >= weekStart && d <= weekEnd;
  }).length;
  return Math.round(perDay * inWeek * 10) / 10;
}

/** The deadline-driven weekly load for one assigned ticket on `employee`. */
export function ticketWeeklyRequiredHours(ticket: AssignedTicket, employee: Employee, remainingHours: number): number {
  const due = resolveDueDate(ticket.expectedResolutionDate, ticket.priority, ticket.raisedDate);
  return weeklyRequiredHoursForItem(remainingHours, itemStartDate(ticket.raisedDate), due, employee);
}

/** The deadline-driven weekly load for one ad-hoc item — its SLA window stands in for
 * the missing deadline. */
export function adhocWeeklyRequiredHours(item: AdhocItem, employee: Employee, remainingHours: number): number {
  if (remainingHours <= 0) return 0;
  const due = resolveDueDate(item.deadline === "Ongoing" ? null : item.deadline, item.priority);
  return weeklyRequiredHoursForItem(remainingHours, todayStart(), due, employee);
}

export interface EmployeeCapacity {
  /** Contracted weekly hours from HR. */
  weeklyHours: number;
  /** Available working hours for the current week — `weeklyHours` reduced pro-rata
   * for any approved leave days that fall in the week, and forced to 0 while the
   * employee is currently on leave. This is the denominator for every
   * utilization/availability figure in the app. */
  workingHours: number;
  /** Deadline-driven workload hours for the **current week** — for each active item,
   * its remaining effort spread across the working days between its start date and its
   * deadline (an explicit deadline always wins; the SLA window only stands in when
   * there is none), scaled to a week. This is what utilization and capacity are built
   * on. On Hold and Completed work contribute 0 (see `unifiedItemStatus`). */
  activeHours: number;
  /** Total remaining effort across active assigned work, irrespective of deadline —
   * the raw "hours left to do" figure, for display where a plain total is wanted
   * (e.g. "Total Workload"). Not used for utilization. */
  totalRemainingHours: number;
  /** Spare capacity in hours — `workingHours − activeHours`, floored at 0, and
   * exactly 0 while the employee is currently on leave. */
  availableHours: number;
  /** `activeHours ÷ workingHours × 100`, rounded — the workload figure. Unaffected
   * by leave (someone on leave can still have work assigned that needs covering). */
  utilization: number;
  /** Availability as a percentage — `100 − utilization`, floored at 0, and exactly
   * 0 while the employee is currently on leave (they are unavailable for assignment,
   * not "100% free"). Use this, never `100 − utilization`, for any "available %". */
  availablePercent: number;
  /** True when an approved leave event covers today — the employee is unavailable. */
  onLeave: boolean;
}

/** Working days (Sun–Thu; Fri/Sat are the weekend) in the calendar week that
 * contains `ref` — Sunday-based, matching the app-wide week scheme (`startOfWeek`
 * in lib/date). */
function currentWeekBounds(ref: Date): { start: Date; end: Date } {
  const start = startOfWeek(ref);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start, end };
}

/** Available working hours for `employee` in the Sunday-based week containing
 * `weekRef` — contracted weekly hours minus the pro-rata hours lost to approved leave
 * that falls in the week, minus the hours committed to timed personal calendar events
 * that week. The single source of truth for the capacity denominator, for the current
 * week and any future week alike. Calendar events reduce *available* capacity only;
 * they never touch the contracted `weeklyHours` profile. */
export function weeklyWorkingHoursForWeek(employee: Employee, weekRef: Date, events: CalendarEvent[] = []): number {
  const weekly = employee.weeklyHours || 40;
  const perDay = weekly / 5;
  const { start, end } = currentWeekBounds(weekRef);
  const leaveDays = leaveWorkingDaysBetween(employee, start, end);
  const eventHours = calendarEventHoursBetween(events, employee.id, start, end);
  return Math.max(0, Math.round((weekly - leaveDays * perDay - eventHours) * 10) / 10);
}

/** Approved-leave working days in `employee`'s current week. */
export function leaveWorkingDaysThisWeek(employee: Employee): number {
  const { start, end } = currentWeekBounds(todayStart());
  return leaveWorkingDaysBetween(employee, start, end);
}

/** Available working hours for `employee` this week. */
export function weeklyWorkingHours(employee: Employee, events: CalendarEvent[] = []): number {
  return weeklyWorkingHoursForWeek(employee, todayStart(), events);
}

/** Every ticket assigned to `employee` (live tickets-store data) plus their seed ad-hoc
 * items, reduced by logged progress and zeroed out once complete. `upcomingTickets` (a
 * seed duplicate of the ticket concept, superseded by the live tickets store) is
 * deliberately excluded so real tickets aren't counted twice under two systems. */
export function computeEmployeeCapacity(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  events: CalendarEvent[] = []
): EmployeeCapacity {
  // One schedule, one set of numbers. `weeklyScheduledHours` is the deadline-driven
  // hours landing in the current week — a task inside its hold window contributes 0
  // unless its post-hold days reach into this week. `totalRemainingHours` is all the
  // non-completed effort left, held or not.
  const schedule = computeEmployeeSchedule(employee, tickets, getEntry, events);
  const activeHours = schedule.weeklyScheduledHours;
  const totalRemainingHours =
    Math.round(schedule.items.reduce((sum, i) => sum + i.remainingHours, 0) * 10) / 10;
  const weeklyHours = employee.weeklyHours || 40;
  const onLeave = isCurrentlyOnLeave(employee);
  // Currently on leave → no working hours and no availability, regardless of how the
  // rest of the week looks. Otherwise it's the leave-adjusted, calendar-adjusted figure.
  const workingHours = onLeave ? 0 : weeklyWorkingHours(employee, events);
  // Keep the ratio finite when there are no working hours (full-week leave or an
  // unusual schedule) by falling back to contracted hours for the denominator only.
  const denom = workingHours > 0 ? workingHours : weeklyHours;
  const utilization = Math.round((activeHours / denom) * 100);
  return {
    weeklyHours,
    workingHours,
    activeHours,
    totalRemainingHours,
    availableHours: onLeave ? 0 : Math.max(0, Math.round((workingHours - activeHours) * 10) / 10),
    utilization,
    availablePercent: onLeave ? 0 : availableCapacity(utilization),
    onLeave,
  };
}

/** The availability percentage to display for an employee wherever the app reads the
 * synced `currentUtilization` field directly (rather than a full `EmployeeCapacity`).
 * Zero while on leave; otherwise `100 − utilization`. */
export function employeeAvailablePercent(employee: Employee): number {
  return isCurrentlyOnLeave(employee) ? 0 : availableCapacity(employee.currentUtilization);
}

// ============================================================================
// Weekly capacity — the SAME evenly-distributed task schedule as the Daily view,
// rolled up per Sunday-based week. This is the supervisor's primary capacity view:
// "how is my team's workload changing week by week?" — not a forecast, just the
// planned distribution of today's tasks against their deadlines.
// ============================================================================

export interface WeeklyCapacityPoint {
  /** 1–52, Sunday-based (see `weekOfYear`). */
  weekNumber: number;
  weekStart: Date;
  /** Saturday. */
  weekEnd: Date;
  /** "W36". */
  label: string;
  /** "Aug 30 – Sep 5". */
  rangeLabel: string;
  /** Deadline-driven task hours landing in this week. */
  scheduledHours: number;
  /** Leave-adjusted available working hours for this week. */
  workingHours: number;
  /** `scheduledHours ÷ workingHours × 100`, rounded. */
  utilization: number;
  /** Spare hours — `workingHours − scheduledHours`, floored at 0. */
  availableHours: number;
  /** Active items with at least one scheduled hour in this week. */
  taskCount: number;
  isCurrent: boolean;
}

/** Planned task hours on `schedule` that fall on working days within `[start, end]`
 * (inclusive). The one shared way to ask "how loaded is this person over an arbitrary
 * date range" — used by turnover coverage to weigh candidates against the leave dates
 * rather than today. */
export function scheduledHoursBetween(schedule: EmployeeSchedule, start: Date, end: Date): number {
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let hours = 0;
  schedule.items.forEach((item) => {
    item.workingDayKeys.forEach((k) => {
      const d = dateFromKey(k);
      if (d >= s && d <= e) hours += item.dayHours[k] ?? item.dailyHours;
    });
  });
  return Math.round(hours * 10) / 10;
}

function scheduledHoursInWeek(schedule: EmployeeSchedule, weekStart: Date, weekEnd: Date): { hours: number; taskCount: number } {
  let hours = 0;
  let taskCount = 0;
  // All items, not just currently-active ones: a held task's post-hold days still
  // land in whatever week they fall in, so its hours show up from the resume week on
  // and are absent from the weeks it's held.
  schedule.items.forEach((item) => {
    const inWeekKeys = item.workingDayKeys.filter((k) => {
      const d = dateFromKey(k);
      return d >= weekStart && d <= weekEnd;
    });
    if (inWeekKeys.length > 0) {
      hours += inWeekKeys.reduce((s, k) => s + (item.dayHours[k] ?? item.dailyHours), 0);
      taskCount += 1;
    }
  });
  return { hours: Math.round(hours * 10) / 10, taskCount };
}

/** `weeks` consecutive weeks starting from the week containing `from` (default: this
 * week), each with the deadline-driven scheduled hours and resulting capacity %. */
export function computeEmployeeWeeklyCapacity(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  weeks = 8,
  from: Date = todayStart(),
  events: CalendarEvent[] = []
): WeeklyCapacityPoint[] {
  const schedule = computeEmployeeSchedule(employee, tickets, getEntry, events);
  const base = startOfWeek(from);
  const thisWeekStart = startOfWeek(todayStart()).getTime();

  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * 7);
    const { start, end } = currentWeekBounds(weekStart);
    const { hours, taskCount } = scheduledHoursInWeek(schedule, start, end);
    const workingHours = weeklyWorkingHoursForWeek(employee, weekStart, events);
    const denom = workingHours > 0 ? workingHours : employee.weeklyHours || 40;
    return {
      weekNumber: weekOfYear(weekStart),
      weekStart: start,
      weekEnd: end,
      label: weekLabel(weekStart),
      rangeLabel: weekRangeLabel(weekStart),
      scheduledHours: hours,
      workingHours,
      utilization: Math.round((hours / denom) * 100),
      availableHours: Math.max(0, Math.round((workingHours - hours) * 10) / 10),
      taskCount,
      isCurrent: start.getTime() === thisWeekStart,
    };
  });
}

/** Team weekly capacity — the mean of each team member's weekly utilization, week by
 * week. `employees` should already be the unit team (supervisor excluded). */
export function computeTeamWeeklyCapacity(
  employees: Employee[],
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  weeks = 8,
  from: Date = todayStart(),
  events: CalendarEvent[] = []
): (WeeklyCapacityPoint & { memberCount: number })[] {
  const perEmployee = employees.map((e) => computeEmployeeWeeklyCapacity(e, tickets, getEntry, weeks, from, events));
  const base = startOfWeek(from);
  const thisWeekStart = startOfWeek(todayStart()).getTime();

  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * 7);
    const { start, end } = currentWeekBounds(weekStart);
    const rows = perEmployee.map((series) => series[i]).filter(Boolean);
    const scheduledHours = Math.round(rows.reduce((s, r) => s + r.scheduledHours, 0) * 10) / 10;
    const workingHours = Math.round(rows.reduce((s, r) => s + r.workingHours, 0) * 10) / 10;
    const utilization = rows.length ? Math.round(rows.reduce((s, r) => s + r.utilization, 0) / rows.length) : 0;
    return {
      weekNumber: weekOfYear(weekStart),
      weekStart: start,
      weekEnd: end,
      label: weekLabel(weekStart),
      rangeLabel: weekRangeLabel(weekStart),
      scheduledHours,
      workingHours,
      utilization,
      availableHours: Math.max(0, Math.round((workingHours - scheduledHours) * 10) / 10),
      taskCount: rows.reduce((s, r) => s + r.taskCount, 0),
      memberCount: rows.length,
      isCurrent: start.getTime() === thisWeekStart,
    };
  });
}

/** Resulting utilization if `extraWeeklyHours` of new weekly load were added to
 * `employee` — uses the exact same formula as `computeEmployeeCapacity` so the
 * assignment warning and the dashboards can never disagree. `extraWeeklyHours` is a
 * per-week figure (the deadline-driven weekly load of the new work), not a raw estimate. */
export function projectedUtilization(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  extraWeeklyHours: number,
  events: CalendarEvent[] = []
): number {
  const { activeHours, workingHours, weeklyHours } = computeEmployeeCapacity(employee, tickets, getEntry, events);
  const denom = workingHours > 0 ? workingHours : weeklyHours;
  return Math.round(((activeHours + Math.max(0, extraWeeklyHours)) / denom) * 100);
}

/**
 * The full weekly-utilization trajectory for `employee` if they took on `ticket` —
 * built by cloning the ticket with the hypothetical assignment and running it through
 * the EXACT SAME schedule/weekly-capacity engine as every other capacity figure (with
 * the same room-aware distribution), so a candidate ranking or "before/after" warning
 * can never disagree with what actually happens once the assignment is made. This is
 * what lets an employee at capacity *this* week still be a good candidate when they
 * have room before the ticket's deadline: the extra hours land wherever the engine
 * would actually schedule them, not blindly onto the current week.
 */
export function projectedWeeklyTrajectoryForTicket(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  ticket: AssignedTicket,
  events: CalendarEvent[] = [],
  weeks = 8
): { before: WeeklyCapacityPoint[]; after: WeeklyCapacityPoint[] } {
  const before = computeEmployeeWeeklyCapacity(employee, tickets, getEntry, weeks, todayStart(), events);
  const currentIds = ticket.assignedEmployeeIds ?? [];
  const alreadyOwns = currentIds.includes(employee.id);

  let hypothetical = tickets;
  if (!alreadyOwns) {
    const nextIds = Array.from(new Set([...currentIds, employee.id])).slice(0, 2);
    const patched: AssignedTicket = { ...ticket, assignedEmployeeIds: nextIds };
    if (nextIds.length === 2 && !ticket.effortSplit) {
      const half = Math.round((ticket.estimatedHours / 2) * 10) / 10;
      patched.effortSplit = Object.fromEntries(nextIds.map((id) => [id, half]));
    }
    hypothetical = tickets.some((t) => t.id === ticket.id)
      ? tickets.map((t) => (t.id === ticket.id ? patched : t))
      : [...tickets, patched];
  }
  const after = computeEmployeeWeeklyCapacity(employee, hypothetical, getEntry, weeks, todayStart(), events);
  return { before, after };
}

/** The single-number "after this week" figure — the trajectory's first week, so it can
 * never disagree with the fuller breakdown. The one calculation behind every "After
 * Assignment: N%" figure in the app. */
export function projectedUtilizationForTicket(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  ticket: AssignedTicket,
  events: CalendarEvent[] = []
): number {
  const { after } = projectedWeeklyTrajectoryForTicket(employee, tickets, getEntry, ticket, events, 1);
  return after[0]?.utilization ?? employee.currentUtilization;
}

/**
 * The **maximum weekly-average utilization** for `employee` across the `weeks` weeks
 * starting from the Sunday-week containing `from`, with `extra` (a hypothetical
 * assignment) folded into their real schedule. i.e. "how loaded is their busiest week
 * *on average* over the selected window" — never a single-day peak.
 *
 * Built from `computeEmployeeWeeklyCapacity` — the exact same weekly-average engine
 * (room-aware distribution, leave, calendar events, existing deadlines) as every other
 * capacity figure — so the What-If candidate table and its allocation scenarios can
 * never be computed two different ways.
 */
export function peakWeeklyUtilization(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  extra: AssignedTicket | null,
  from: Date,
  weeks: number,
  events: CalendarEvent[] = []
): { peakUtilization: number; weekly: WeeklyCapacityPoint[] } {
  const load = extra ? [...tickets.filter((t) => t.id !== extra.id), extra] : tickets;
  const weekly = computeEmployeeWeeklyCapacity(employee, load, getEntry, Math.max(1, Math.round(weeks)), from, events);
  const peakUtilization = weekly.length
    ? Math.max(...weekly.map((w) => w.utilization))
    : employee.currentUtilization;
  return { peakUtilization, weekly };
}

export interface EmployeeWorkItem {
  key: string;
  title: string;
  type: "Ticket" | "Ad-hoc";
  priority: "High" | "Medium" | "Low";
  dueDate: string | null;
  status: DisplayStatus;
  progress: number;
  remainingHours: number;
  /** Deadline-driven effort this item places on the current week (0 unless In Progress). */
  weeklyRequiredHours: number;
  ticketId?: string;
  /** Set once the item is Completed — its completion date. Null otherwise. */
  completedDate: string | null;
  /** The hold window, while the item is still On Hold (cleared once the hold ends). */
  holdStart: string | null;
  holdEnd: string | null;
  /** Stored status is On Hold but the hold window has elapsed — it's scheduled as
   * active again (`status` reads "In Progress"/"Overdue"). */
  resumedFromHold: boolean;
  /** Time actually worked so far (employee-logged), if any. */
  actualHours: number | null;
  /** `remainingHours` came from an employee-logged figure rather than progress. */
  remainingOverridden: boolean;
  /** "26 Aug 2026"-style date progress / effort was last touched, for the freshness
   * indicator. Null when nothing has been logged. */
  progressUpdatedAt: string | null;
  /** This row is coverage the employee is providing for another person's ticket. */
  isCoverage: boolean;
  /** While `isCoverage`, who owns the ticket. */
  coverageOwnerName: string | null;
  /** For an owned ticket handed to a cover during the employee's leave. */
  coveredAway: { start: string; end: string; coveringName: string; hours: number } | null;
}

/** Every active-or-completed work item on `employee`'s plate, in the same shape
 * whether it's a live ticket or a seed ad-hoc item — built directly on
 * `computeEmployeeSchedule` so the "my work" lists and KPI counts can never disagree
 * with the calendar, capacity, or the Daily Tasks view. `weeklyRequiredHours` is that
 * item's exact scheduled hours for the current week (0 while held out of this week). */
export function computeEmployeeWorkItems(
  employee: Employee,
  tickets: AssignedTicket[],
  getEntry: WorkLogLookup,
  events: CalendarEvent[] = []
): EmployeeWorkItem[] {
  const schedule = computeEmployeeSchedule(employee, tickets, getEntry, events);
  const scheduled = new Map(schedule.items.map((i) => [i.key, i]));
  const items: EmployeeWorkItem[] = [];

  tickets
    .filter((t) => (t.assignedEmployeeIds ?? []).includes(employee.id))
    .forEach((t) => {
      const key = `${employee.id}:${t.id}`;
      const entry = getEntry(key);
      const s = scheduled.get(key); // absent only for Completed items
      const complete = isItemComplete(undefined, t.status);
      const status: DisplayStatus = complete ? "Completed" : s?.heldNow ? "On Hold" : "In Progress";
      const override = typeof entry.remainingHours === "number" ? entry.remainingHours : null;
      const remaining = itemRemainingHours(ticketEffortForEmployee(t, employee.id), complete, entry.progress, override);
      items.push({
        key,
        title: t.title,
        type: "Ticket",
        priority: t.priority,
        dueDate: ticketDueLabel(t),
        status,
        progress: complete ? 100 : s?.progress ?? Math.min(100, Math.max(0, entry.progress ?? 0)),
        remainingHours: remaining,
        weeklyRequiredHours: s ? schedule.currentWeekHoursByKey.get(key) ?? 0 : 0,
        ticketId: t.id,
        completedDate: complete ? (t.resolvedDate ?? entry.completedAt ?? null) : null,
        holdStart: s?.heldNow ? (t.holdStartDate ?? null) : null,
        holdEnd: s?.heldNow ? (t.holdEndDate ?? null) : null,
        resumedFromHold: s?.resumedFromHold ?? false,
        actualHours: entry.actualHours ?? null,
        remainingOverridden: override != null && !complete,
        progressUpdatedAt: entry.progressUpdatedAt ?? null,
        isCoverage: false,
        coverageOwnerName: null,
        coveredAway: s?.coveredAway ?? null,
      });
    });

  // Coverage this employee is providing during someone else's leave — a distinct row
  // so "My Work" shows it without pretending ownership moved.
  schedule.items
    .filter((s) => s.isCoverage)
    .forEach((s) => {
      const lastCoveredKey = [...s.workingDayKeys].sort().pop();
      items.push({
        key: s.key,
        title: s.title,
        type: "Ticket",
        priority: s.priority,
        // For coverage, "due" reads as the last day of the coverage window.
        dueDate: lastCoveredKey ? formatDisplayDate(dateFromKey(lastCoveredKey)) : formatDisplayDate(s.deadline),
        status: "In Progress",
        progress: 0,
        remainingHours: s.remainingHours,
        weeklyRequiredHours: schedule.currentWeekHoursByKey.get(s.key) ?? 0,
        ticketId: s.ticketId,
        completedDate: null,
        holdStart: null,
        holdEnd: null,
        resumedFromHold: false,
        actualHours: null,
        remainingOverridden: false,
        progressUpdatedAt: null,
        isCoverage: true,
        coverageOwnerName: s.coverageOwnerName,
        coveredAway: null,
      });
    });

  employee.adhoc.forEach((a) => {
    const key = `${employee.id}:${a.id}`;
    const entry = getEntry(key);
    const s = scheduled.get(key);
    const complete = isItemComplete(entry.workflowStatus);
    const status: DisplayStatus = complete ? "Completed" : s?.heldNow ? "On Hold" : "In Progress";
    const override = typeof entry.remainingHours === "number" ? entry.remainingHours : null;
    const remaining = itemRemainingHours(a.estimatedHours, complete, entry.progress, override);
    items.push({
      key,
      title: a.name,
      type: "Ad-hoc",
      priority: a.priority,
      dueDate: adhocDueLabel(a),
      status,
      progress: complete ? 100 : s?.progress ?? Math.min(100, Math.max(0, entry.progress ?? 0)),
      remainingHours: remaining,
      weeklyRequiredHours: s ? schedule.currentWeekHoursByKey.get(key) ?? 0 : 0,
      completedDate: complete ? (entry.completedAt ?? null) : null,
      holdStart: s?.heldNow ? (entry.holdStartDate ?? null) : null,
      holdEnd: s?.heldNow ? (entry.holdEndDate ?? null) : null,
      resumedFromHold: s?.resumedFromHold ?? false,
      actualHours: entry.actualHours ?? null,
      remainingOverridden: override != null && !complete,
      progressUpdatedAt: entry.progressUpdatedAt ?? null,
      isCoverage: false,
      coverageOwnerName: null,
      coveredAway: null,
    });
  });

  return items;
}

export type DisplayStatus = "In Progress" | "On Hold" | "Completed";

/** A single, unified status for any work item — ticket or ad-hoc — used everywhere
 * (My Dashboard, Calendar, Daily Tasks, capacity, Work Delivery) so status can never
 * differ between views. Only the three app-wide states; work with no status counts as
 * In Progress.
 *
 * For a ticket, its own `ticketStatus` is the single source of truth (callers pass
 * `undefined` for `workflowStatus`); the personal work-log `workflowStatus` only
 * applies to ad-hoc items that have no ticket.
 *
 * `holdEndDate` (when known) makes this hold-window-aware: an On Hold task whose hold
 * period has already elapsed resolves back to "In Progress" — it resumes normal
 * scheduling automatically without its stored status being changed. */
export function unifiedItemStatus(
  workflowStatus: WorkflowStatus | undefined,
  ticketStatus?: TicketStatus,
  holdEndDate?: string | null
): DisplayStatus {
  if (isItemComplete(workflowStatus, ticketStatus)) return "Completed";
  if (workflowStatus === "On Hold" || ticketStatus === "On Hold") {
    return holdEndPassed(holdEndDate) ? "In Progress" : "On Hold";
  }
  return "In Progress";
}

export type DeliveryBucket = "Completed" | "Overdue" | "In Progress";

/** Where a work item lands on the "are we actually delivering" view — a passed due
 * date is the one signal that overrides everything else, since it's true regardless
 * of whether the item is also logged as blocked. Blocked status has its own visibility
 * in Team Progress, so it isn't split out again here. */
export function deliveryBucket(status: DisplayStatus, dueDate: string | null | undefined): DeliveryBucket {
  if (status === "Completed") return "Completed";
  if (dueDate && getDueStatus(dueDate) === "Overdue") return "Overdue";
  return "In Progress";
}

/** A rough, per-item "how done is it" fraction used for the team's overall progress
 * average — real logged progress when we have it, otherwise a status-based estimate. */
export function progressFraction(status: DisplayStatus, progress: number | undefined): number {
  if (status === "Completed") return 100;
  if (typeof progress === "number") return Math.min(100, Math.max(0, progress));
  if (status === "On Hold") return 25;
  return 50;
}

function rangesOverlapToday(start: string, end: string): boolean {
  const s = parseLooseDate(start);
  const e = parseLooseDate(end);
  if (!s || !e) return false;
  const today = todayStart();
  return today >= s && today <= e;
}

export function isCurrentlyOnLeave(employee: Employee): boolean {
  return employee.leaveEvents.some((l) => l.status !== "Pending" && rangesOverlapToday(l.start, l.end));
}

/** The approved leave event covering today, if any — used to show *why* someone counts
 * as on leave (type and dates) in the dashboard drill-down. */
export function currentLeaveEvent(employee: Employee): LeaveEvent | null {
  return employee.leaveEvents.find((l) => l.status !== "Pending" && rangesOverlapToday(l.start, l.end)) ?? null;
}

/** Leave starting soon enough to matter for near-term planning — a supervisor deciding
 * who to assign new work to this week needs to know about next week's leave too. */
export function isOnUpcomingLeave(employee: Employee, withinDays = 7): boolean {
  return employee.leaveEvents.some((l) => {
    if (l.status === "Pending") return false;
    const start = parseLooseDate(l.start);
    if (!start) return false;
    const msPerDay = 24 * 60 * 60 * 1000;
    const days = Math.round((start.getTime() - todayStart().getTime()) / msPerDay);
    return days >= 0 && days <= withinDays;
  });
}

export function isOnOrUpcomingLeave(employee: Employee, withinDays = 7): boolean {
  return isCurrentlyOnLeave(employee) || isOnUpcomingLeave(employee, withinDays);
}
