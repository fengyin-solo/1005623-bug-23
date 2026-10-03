import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

/**
 * 室温监测领域层：列表、导出、首页达标率、入户待上门清单都只认这一份数据。
 *
 * 口径约定：
 * - 一个监测点可以有多条采集读数；达标判定只做一次，以「采集时间最新一条」读数重算，
 *   判定提交后即归档落库（判定、处理人、采集时间随提交冻结），之后再来读数也不改写。
 * - 同一采集时间重复提交读数、归档后重复判定报送，都只保留最先那份。
 * - 最新读数缺失/不是有效温度时，判定退回补录，不生成结论。
 * - 不达标归档会在入户服务里幂等生成一张「待上门（已安排）」服务单。
 */

export const PASS_TEMP = 18 // 室温达标下限（含），单位 ℃
export const ROOMTEMP_KEY = 'roomtemp'
export const HOUSEHOLD_KEY = 'householdservice'
export const HOUSEHOLD_SOURCE_PREFIX = '室温不达标：'
const STORAGE_VERSION = 'v1'

export type Reading = {
  value: number | null // 读数缺失时为 null，需退回补录
  collectedAt: string // 采集时间
  submittedAt: string // 报送提交时间（重复提交时用来只留最先那份）
}

export type Judgement = {
  pass: boolean
  reading: number
  collectedAt: string
  decidedAt: string
  handler: string
}

export type RoomPoint = {
  id: number
  code: string
  address: string
  area: string
  readings: Reading[]
  judgement: Judgement | null // 不为 null 即已归档，结论按当时结论保留
}

export type SubmitOutcome =
  | { ok: true; message: string }
  | { ok: false; code: 'duplicate-reading' | 'missing-reading' | 'already-judged' | 'not-found'; message: string }

export type RoomStats = {
  pending: number
  failed: number
  monthPassRate: number | null // 本月已归档判定中的达标占比，本月无判定时为 null
  monthJudged: number
}

type Stored = { version: string; points: RoomPoint[] }

function nowText(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// 种子：覆盖待采集、未判定多读数、已达标归档、不达标归档（联动待上门）、读数缺失待补录。
function seedPoints(): RoomPoint[] {
  return [
    {
      id: 1,
      code: 'ROOM-0001',
      address: '阳光小区 1-1-101',
      area: '城东片区',
      readings: [],
      judgement: null,
    },
    {
      id: 2,
      code: 'ROOM-0002',
      address: '阳光小区 1-2-302',
      area: '城东片区',
      readings: [
        { value: 19.4, collectedAt: '2026-10-01 09:00', submittedAt: '2026-10-01 09:05' },
        { value: 19.1, collectedAt: '2026-10-02 09:00', submittedAt: '2026-10-02 09:06' },
      ],
      judgement: null,
    },
    {
      id: 3,
      code: 'ROOM-0003',
      address: '康乐里 3-3-501',
      area: '城西片区',
      readings: [
        { value: 17.8, collectedAt: '2026-09-28 09:00', submittedAt: '2026-09-28 09:04' },
        { value: 18.6, collectedAt: '2026-09-29 09:00', submittedAt: '2026-09-29 09:03' },
      ],
      judgement: {
        pass: true,
        reading: 18.6,
        collectedAt: '2026-09-29 09:00',
        decidedAt: '2026-09-29 10:00',
        handler: '值班管理员',
      },
    },
    {
      id: 4,
      code: 'ROOM-0004',
      address: '康乐里 5-1-202',
      area: '城西片区',
      readings: [
        { value: 16.9, collectedAt: '2026-10-01 14:00', submittedAt: '2026-10-01 14:10' },
        { value: 16.7, collectedAt: '2026-10-02 14:00', submittedAt: '2026-10-02 14:08' },
      ],
      judgement: {
        pass: false,
        reading: 16.7,
        collectedAt: '2026-10-02 14:00',
        decidedAt: '2026-10-02 15:00',
        handler: '值班管理员',
      },
    },
    {
      id: 5,
      code: 'ROOM-0005',
      address: '滨河家园 8-2-601',
      area: '城南片区',
      readings: [
        { value: null, collectedAt: '2026-10-02 18:00', submittedAt: '2026-10-02 18:12' },
      ],
      judgement: null,
    },
  ]
}

let cache: RoomPoint[] | null = null

function load(): RoomPoint[] {
  if (cache) {
    return cache
  }
  const raw = typeof window !== 'undefined' ? window.localStorage.getItem('district-heating:roomtemp') : null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Stored
      if (parsed && parsed.version === STORAGE_VERSION && Array.isArray(parsed.points)) {
        cache = parsed.points
        syncHousehold(cache)
        return cache
      }
    } catch {
      // 落到种子数据
    }
  }
  cache = seedPoints()
  persist(cache)
  syncHousehold(cache)
  return cache
}

function persist(points: RoomPoint[]): void {
  cache = points
  if (typeof window !== 'undefined' && window.localStorage) {
    const stored: Stored = { version: STORAGE_VERSION, points }
    window.localStorage.setItem('district-heating:roomtemp', JSON.stringify(stored))
  }
}

export function resetRoomtemp(): RoomPoint[] {
  const points = seedPoints()
  persist(points)
  syncHousehold(points)
  return points
}

/** 采集时间最新的一条；缺失读数（null）也是一条报送，但不能作为判定依据。 */
export function latestReading(point: RoomPoint): Reading | null {
  if (point.readings.length === 0) {
    return null
  }
  return [...point.readings].sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))[0]
}

function latestValidReading(point: RoomPoint): Reading | null {
  const valid = point.readings.filter((item) => isFiniteNumber(item.value))
  if (valid.length === 0) {
    return null
  }
  return [...valid].sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))[0]
}

/** 运行时状态：待采集 / 已采集 / 已达标 / 不达标；归档后以冻结结论为准。 */
export function pointStatus(point: RoomPoint): string {
  if (point.judgement) {
    return point.judgement.pass ? '已达标' : '不达标'
  }
  return point.readings.length > 0 ? '已采集' : '待采集'
}

/** 提交一条采集读数。同一采集时间重复提交只保留最先报送的那份。 */
export function submitReading(
  id: number,
  value: number | null,
  collectedAt: string,
  submittedAt: string = nowText(),
): SubmitOutcome {
  const points = load()
  const point = points.find((item) => item.id === id)
  if (!point) {
    return { ok: false, code: 'not-found', message: `没有找到编号为 ${id} 的室温监测点` }
  }
  if (point.readings.some((item) => item.collectedAt === collectedAt)) {
    return {
      ok: false,
      code: 'duplicate-reading',
      message: `采集时间 ${collectedAt} 的读数已报送，重复提交只记首次那份`,
    }
  }
  point.readings.push({ value, collectedAt, submittedAt })
  persist(points)
  if (value === null) {
    return { ok: true, message: '采集记录已提交，室温读数缺失，已退回补录后才能判定' }
  }
  return { ok: true, message: '采集读数已提交落库' }
}

/**
 * 判定报送：统一按采集时间最新一条读数算一次，提交完就归档落库。
 * 已归档的重复报送直接拒绝；最新读数缺失则退回补录。
 */
export function submitJudgement(id: number, handler: string, decidedAt: string = nowText()): SubmitOutcome {
  const points = load()
  const point = points.find((item) => item.id === id)
  if (!point) {
    return { ok: false, code: 'not-found', message: `没有找到编号为 ${id} 的室温监测点` }
  }
  if (point.judgement) {
    return {
      ok: false,
      code: 'already-judged',
      message: `该监测点已于 ${point.judgement.decidedAt} 判定为「${
        point.judgement.pass ? '已达标' : '不达标'
      }」，重复报送只记首次，结论不再改写`,
    }
  }
  const reading = latestValidReading(point)
  if (!reading || !isFiniteNumber(reading.value)) {
    return {
      ok: false,
      code: 'missing-reading',
      message: '最新一条采集缺少有效室温读数，先退回补录读数后再报送判定',
    }
  }
  const value: number = reading.value
  const judgement: Judgement = {
    pass: value >= PASS_TEMP,
    reading: value,
    collectedAt: reading.collectedAt,
    decidedAt,
    handler,
  }
  point.judgement = judgement
  persist(points)
  syncHousehold(points)
  return {
    ok: true,
    message: judgement.pass
      ? `判定已归档：${point.code} 最新读数 ${value}℃，已达标`
      : `判定已归档：${point.code} 最新读数 ${value}℃，不达标，已转入户待上门清单`,
  }
}

// ---- 入户服务联动：不达标结论驱动待上门清单，幂等只生成一张 ----

function householdContent(code: string): string {
  return `${HOUSEHOLD_SOURCE_PREFIX}${code} 室温不达标，请上门测温排查`
}

/** 服务单号用固定规则生成，保证重复同步幂等。 */
export function householdServiceCode(code: string): string {
  return `HOUS-RT-${code.replace(/^ROOM-/, '')}`
}

function syncHousehold(points: RoomPoint[]): void {
  const rows = listRows(HOUSEHOLD_KEY).map((row) => ({ ...row }))
  const failed = points.filter((point) => point.judgement && !point.judgement.pass)

  for (const point of failed) {
    const code = householdServiceCode(point.code)
    const exists = rows.some((row) => String(row['服务单号']) === code || String(row['来源监测点'] ?? '') === point.code)
    if (exists) {
      continue
    }
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const judgement = point.judgement as Judgement
    const row: EntryRow = {
      id,
      status: '已安排', // 即待上门
      pending: true,
      abnormal: false,
      服务单号: code,
      报修用户: point.address,
      服务内容: householdContent(point.code),
      受理人: '值班管理员',
      上门时间: '',
      处理结果: '',
      回访日期: '',
      服务状态: '已安排',
      来源监测点: point.code,
      来源判定时间: judgement.decidedAt,
    }
    rows.push(row)
  }
  saveRows(HOUSEHOLD_KEY, rows)
}

export function pendingVisitRows(): EntryRow[] {
  return listRows(HOUSEHOLD_KEY).filter(
    (row) => String(row['来源监测点'] ?? '') !== '' && String(row.status) === '已安排',
  )
}

// ---- 统一出口：列表、导出、首页都从这里取，保证多处结论对得上 ----

function formatReading(reading: Reading | null): string {
  if (!reading) {
    return ''
  }
  return isFiniteNumber(reading.value) ? `${reading.value}℃` : '读数缺失待补录'
}

export function toEntryRow(point: RoomPoint): EntryRow {
  const status = pointStatus(point)
  const reading = latestReading(point)
  const frozen = point.judgement
  return {
    id: point.id,
    status,
    pending: status === '待采集' || status === '已采集',
    abnormal: false,
    监测编号: point.code,
    住户地址: point.address,
    所属片区: point.area,
    室温读数: frozen ? `${frozen.reading}℃` : formatReading(reading),
    采集时间: frozen ? frozen.collectedAt : reading?.collectedAt ?? '',
    达标判定: frozen ? (frozen.pass ? '已达标（已归档）' : '不达标（已归档）') : '待判定',
    处理人: frozen ? frozen.handler : '',
    监测状态: status,
  }
}

export function listRoomRows(): EntryRow[] {
  return load().map(toEntryRow)
}

export function roomStats(now: Date = new Date()): RoomStats {
  const points = load()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const judged = points.filter((point) => point.judgement !== null)
  const monthJudged = judged.filter((point) => (point.judgement as Judgement).collectedAt.startsWith(month))
  const passCount = monthJudged.filter((point) => (point.judgement as Judgement).pass).length
  return {
    pending: points.filter((point) => pointStatus(point) === '待采集').length,
    failed: points.filter((point) => pointStatus(point) === '不达标').length,
    monthPassRate: monthJudged.length === 0 ? null : passCount / monthJudged.length,
    monthJudged: monthJudged.length,
  }
}

/** 导出清单：与列表、首页同一来源、同一口径。 */
export function roomCsv(): { filename: string; content: string } {
  const header = ['编号', '监测编号', '住户地址', '所属片区', '室温读数', '采集时间', '达标判定', '处理人', '监测状态']
  const lines = [header.join(',')]
  for (const row of listRoomRows()) {
    lines.push(
      [
        row.id,
        row['监测编号'],
        row['住户地址'],
        row['所属片区'],
        row['室温读数'],
        row['采集时间'],
        row['达标判定'],
        row['处理人'],
        row.status,
      ].join(','),
    )
  }
  return { filename: '室温监测-清单.csv', content: `﻿${lines.join('\n')}` }
}
