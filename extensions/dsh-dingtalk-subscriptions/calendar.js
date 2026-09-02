import { createHash } from 'node:crypto'

export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'
export const HOLIDAY_SOURCE_2026 = 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'

const HOLIDAY_2026_REST_DAYS = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

// These are the weekend days explicitly designated as working days by the
// State Council's 2026 holiday arrangement.  A weekend adjustment is a
// working day even though its ISO weekday is Saturday or Sunday.
const HOLIDAY_2026_WORK_DAYS = Object.freeze([
  '2026-01-04',
  '2026-02-14', '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
])

export const DEFAULT_HOLIDAY_CALENDARS = Object.freeze({
  2026: Object.freeze({
    year: 2026,
    timezone: SHANGHAI_TIME_ZONE,
    sourceUrl: HOLIDAY_SOURCE_2026,
    sourceTitle: '国务院办公厅关于2026年部分节假日安排的通知',
    restDays: HOLIDAY_2026_REST_DAYS,
    workingDays: HOLIDAY_2026_WORK_DAYS,
  }),
})

function assertDateKey(value) {
  const key = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError('日期必须是 YYYY-MM-DD')
  const date = new Date(`${key}T12:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) throw new TypeError('日期无效')
  return key
}

/** Convert a Date or ISO timestamp to a calendar date in Shanghai time. */
export function dateKey(value, timeZone = SHANGHAI_TIME_ZONE) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return assertDateKey(value)
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('日期无效')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return assertDateKey(`${map.year}-${map.month}-${map.day}`)
}

export function isoWeekday(key) {
  const value = assertDateKey(key)
  return new Date(`${value}T12:00:00Z`).getUTCDay() || 7
}

export function mondayOfWeek(value) {
  const key = dateKey(value)
  const date = new Date(`${key}T12:00:00Z`)
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() - weekday + 1)
  return date.toISOString().slice(0, 10)
}

export function addDays(value, amount) {
  const key = dateKey(value)
  const date = new Date(`${key}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + Number(amount || 0))
  return date.toISOString().slice(0, 10)
}

export function canonicalCalendarPayload(calendar) {
  const normalized = normalizeHolidayCalendar(calendar)
  return JSON.stringify({
    year: normalized.year,
    timezone: normalized.timezone,
    sourceUrl: normalized.sourceUrl,
    sourceTitle: normalized.sourceTitle,
    restDays: normalized.restDays,
    workingDays: normalized.workingDays,
  })
}

export function calendarChecksum(calendar) {
  return createHash('sha256').update(canonicalCalendarPayload(calendar), 'utf8').digest('hex')
}

export function normalizeHolidayCalendar(input) {
  const year = Number(input?.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new TypeError('节假日日历年份无效')
  const uniqueDates = (value) => [...new Set((Array.isArray(value) ? value : []).map(assertDateKey))].sort()
  const restDays = uniqueDates(input?.restDays ?? input?.rest_days)
  const workingDays = uniqueDates(input?.workingDays ?? input?.working_days)
  const restSet = new Set(restDays)
  const overlapping = workingDays.filter((day) => restSet.has(day))
  if (overlapping.length) throw new TypeError(`工作日与休息日冲突: ${overlapping.join(', ')}`)
  if (restDays.some((day) => !day.startsWith(`${year}-`)) || workingDays.some((day) => !day.startsWith(`${year}-`))) {
    throw new TypeError('节假日日历日期必须属于该年份')
  }
  const sourceUrl = String(input?.sourceUrl ?? input?.source_url ?? '').trim()
  const sourceTitle = String(input?.sourceTitle ?? input?.source_title ?? '').trim()
  return {
    year,
    timezone: String(input?.timezone || SHANGHAI_TIME_ZONE),
    sourceUrl: sourceUrl.slice(0, 2_000),
    sourceTitle: sourceTitle.slice(0, 500),
    restDays,
    workingDays,
  }
}

export function defaultCalendar(year) {
  const source = DEFAULT_HOLIDAY_CALENDARS[Number(year)]
  return source ? normalizeHolidayCalendar(source) : null
}

/** Return true only when a trusted calendar exists and the date is usable. */
export function isAllowedWorkdayFromCalendar(value, calendar) {
  if (!calendar) return false
  const key = dateKey(value, calendar.timezone || SHANGHAI_TIME_ZONE)
  const normalized = normalizeHolidayCalendar(calendar)
  if (normalized.year !== Number(key.slice(0, 4))) return false
  if (normalized.restDays.includes(key)) return false
  if (normalized.workingDays.includes(key)) return true
  return isoWeekday(key) <= 5
}

export function workdayInfo(value, calendar) {
  let key
  try { key = dateKey(value, calendar?.timezone || SHANGHAI_TIME_ZONE) } catch { return { known: false, allowed: false, date: null, reason: 'INVALID_DATE' } }
  if (!calendar) return { known: false, allowed: false, date: key, reason: 'HOLIDAY_CALENDAR_MISSING' }
  const normalized = normalizeHolidayCalendar(calendar)
  if (normalized.year !== Number(key.slice(0, 4))) return { known: false, allowed: false, date: key, reason: 'HOLIDAY_CALENDAR_MISSING' }
  if (normalized.restDays.includes(key)) return { known: true, allowed: false, date: key, reason: 'HOLIDAY_OR_REST_DAY' }
  if (normalized.workingDays.includes(key)) return { known: true, allowed: true, date: key, reason: 'ADJUSTED_WORKDAY' }
  if (isoWeekday(key) > 5) return { known: true, allowed: false, date: key, reason: 'WEEKEND' }
  return { known: true, allowed: true, date: key, reason: 'WEEKDAY' }
}

export function nextWeekStart(value) {
  return addDays(mondayOfWeek(value), 7)
}

export const HOLIDAY_2026 = Object.freeze({
  restDays: HOLIDAY_2026_REST_DAYS,
  workingDays: HOLIDAY_2026_WORK_DAYS,
})
