import type {
  ActionResult,
  EntryRow,
  RoomInternals,
  RoomJudgement,
  RoomReading,
  RoomStatsResult,
} from './types'

// 室温监测口径：列表、导出、首页达标率全部走这一份，达标判定只算一次。
// 兼容供热监测既有做法：达标线 18℃，按采集时间里的最新一条有效读数判定。
export const ROOMTEMP_KEY = 'roomtemp'
export const HOUSEHOLDSERVICE_KEY = 'householdservice'
export const ROOMTEMP_THRESHOLD = 18
export const ROOMTEMP_WAIT_COLLECT = '待采集'
export const ROOMTEMP_COLLECTED = '已采集'
export const ROOMTEMP_QUALIFIED = '已达标'
export const ROOMTEMP_NON_COMPLIANT = '不达标'
export const ROOM_DEFAULT_HANDLER = '值班管理员'

const CODE_FIELD = '监测编号'
const ADDRESS_FIELD = '住户地址'
const VALUE_FIELD = '室温读数'
const COLLECTED_AT_FIELD = '采集时间'
const VERDICT_FIELD = '达标判定'
const HANDLER_FIELD = '处理人'
const MONITOR_STATUS_FIELD = '监测状态'

const SERVICE_NO_FIELD = '服务单号'
const SERVICE_USER_FIELD = '报修用户'
const SERVICE_CONTENT_FIELD = '服务内容'
const SERVICE_ACCEPTOR_FIELD = '受理人'
const SERVICE_VISIT_AT_FIELD = '上门时间'
const SERVICE_RESULT_FIELD = '处理结果'
const SERVICE_VISIT_DATE_FIELD = '回访日期'
const SERVICE_STATUS_FIELD = '服务状态'

function codeOf(row: EntryRow): string {
  return String(row[CODE_FIELD] ?? `ROOM-${String(row.id).padStart(4, '0')}`)
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function latestReading(internals: RoomInternals): RoomReading | null {
  if (internals.readings.length === 0) {
    return null
  }
  return [...internals.readings].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0]
}

function qualifies(value: number): boolean {
  return value >= ROOMTEMP_THRESHOLD
}

function nowStamp(): string {
  const now = new Date()
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
}

function monthOf(stamp: string): string {
  return stamp.slice(0, 7)
}

/**
 * 把历史平铺数据收拢成同一份内部口径：
 * - 当时已归档（已达标/不达标）的记录按当时结论保留，不随新读数翻案；
 * - 其余记录若带有有效读数，则按采集时间登记为可重算的采集记录。
 */
export function normalizeRoomRow(row: EntryRow): RoomInternals {
  const existing = row._rt
  if (existing && Array.isArray(existing.readings)) {
    return {
      code: existing.code || codeOf(row),
      readings: existing.readings.map((item) => ({ ...item })),
      judgement: existing.judgement ? { ...existing.judgement } : null,
    }
  }

  const status = String(row.status)
  const value = numberFrom(row[VALUE_FIELD])
  const collectedAt = String(row[COLLECTED_AT_FIELD] ?? '').trim()
  const readings: RoomReading[] =
    value !== null && collectedAt !== ''
      ? [{ value, collectedAt, collectedBy: ROOM_DEFAULT_HANDLER }]
      : []

  let judgement: RoomJudgement | null = null
  if (
    (status === ROOMTEMP_QUALIFIED || status === ROOMTEMP_NON_COMPLIANT) &&
    value !== null
  ) {
    judgement = {
      conclusion: status === ROOMTEMP_QUALIFIED ? '达标' : '不达标',
      judgedAt: collectedAt || nowStamp(),
      handler:
        typeof row[HANDLER_FIELD] === 'string' && row[HANDLER_FIELD].trim() !== ''
          ? String(row[HANDLER_FIELD])
          : ROOM_DEFAULT_HANDLER,
      basisValue: value,
      basisCollectedAt: collectedAt,
    }
  }

  return { code: codeOf(row), readings, judgement }
}

/** 内部口径投影成台账平铺字段：室温台账与达标页看到的达标结论必然是同一份。 */
export function toFlatRoomRow(row: EntryRow): EntryRow {
  const internals = normalizeRoomRow(row)
  const latest = latestReading(internals)
  let verdict: string
  if (internals.judgement) {
    // 已归档的按当时结论保留；最新读数与当时结论相反时加标注，避免台账上看起来矛盾。
    const drifted = latest ? qualifies(latest.value) !== (internals.judgement.conclusion === '达标') : false
    verdict = drifted
      ? `${internals.judgement.conclusion}（已归档，当时结论保留）`
      : internals.judgement.conclusion
  } else {
    verdict = latest
      ? qualifies(latest.value)
        ? '待判定（最新读数达标）'
        : '待判定（最新读数不达标）'
      : '待判定'
  }

  const status = internals.judgement
    ? internals.judgement.conclusion === '达标'
      ? ROOMTEMP_QUALIFIED
      : ROOMTEMP_NON_COMPLIANT
    : latest
      ? ROOMTEMP_COLLECTED
      : ROOMTEMP_WAIT_COLLECT

  return {
    ...row,
    status,
    pending: status === ROOMTEMP_WAIT_COLLECT || status === ROOMTEMP_COLLECTED,
    abnormal: status === ROOMTEMP_NON_COMPLIANT,
    _rt: internals,
    [VALUE_FIELD]: latest ? String(latest.value) : '',
    [COLLECTED_AT_FIELD]: latest ? latest.collectedAt : '',
    [VERDICT_FIELD]: verdict,
    [HANDLER_FIELD]: internals.judgement ? internals.judgement.handler : '',
    [MONITOR_STATUS_FIELD]: status,
  }
}

export function presentRoomRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => toFlatRoomRow(row))
}

function freezeJudgement(
  internals: RoomInternals,
  conclusion: RoomJudgement['conclusion'],
  basis: RoomReading,
  handler: string,
): RoomInternals {
  return {
    ...internals,
    judgement: {
      conclusion,
      judgedAt: nowStamp(),
      handler,
      basisValue: basis.value,
      basisCollectedAt: basis.collectedAt,
    },
  }
}

/**
 * 提交采集：登记一条读数（同一采集时间只记最先一份），平铺字段同步到最新读数。
 * 已归档监测点允许继续采集做跟踪，但当时结论保留、不被新读数改写。
 */
export function submitRoomReading(
  row: EntryRow,
  input: { value: number; collectedAt: string; operator: string },
): { row: EntryRow; result: ActionResult } {
  const internals = normalizeRoomRow(row)
  if (
    internals.readings.some((item) => item.collectedAt === input.collectedAt)
  ) {
    return {
      row: toFlatRoomRow(row),
      result: {
        ok: false,
        message: `采集时间 ${input.collectedAt} 已报送过读数，重复报送只记最先一份`,
      },
    }
  }

  const nextInternals: RoomInternals = {
    ...internals,
    readings: [
      ...internals.readings,
      {
        value: input.value,
        collectedAt: input.collectedAt,
        collectedBy: input.operator,
      },
    ],
  }
  const latest = latestReading(nextInternals)
  const nextRow = toFlatRoomRow({ ...row, _rt: nextInternals })
  const hint = nextInternals.judgement
    ? `，监测点${nextInternals.judgement.conclusion === '达标' ? '已达标' : '已判定不达标'}，当时结论保留`
    : latest && !qualifies(latest.value)
      ? '，最新读数低于达标线，请尽快报送达标判定或安排入户'
      : ''
  return {
    row: nextRow,
    result: { ok: true, message: `采集读数 ${input.value}℃ 已落库${hint}` },
  }
}

/** 不达标结论驱动入户服务：同一监测点只生成一张待上门服务单。 */
function ensureHouseholdVisit(
  serviceRows: EntryRow[],
  row: EntryRow,
  internals: RoomInternals,
): EntryRow[] {
  const code = internals.code
  if (serviceRows.some((item) => String(item._roomCode ?? '') === code)) {
    return serviceRows
  }

  const address = String(row[ADDRESS_FIELD] ?? code)
  const nextId = serviceRows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1
  const visit: EntryRow = {
    id: nextId,
    status: '待受理',
    pending: true,
    abnormal: true,
    _roomCode: code,
    [SERVICE_NO_FIELD]: `HOUS-${String(nextId).padStart(4, '0')}`,
    [SERVICE_USER_FIELD]: address,
    [SERVICE_CONTENT_FIELD]: `室温不达标入户核查（监测点 ${code}，最新室温 ${internals.judgement?.basisValue ?? ''}℃）`,
    [SERVICE_ACCEPTOR_FIELD]: '',
    [SERVICE_VISIT_AT_FIELD]: '',
    [SERVICE_RESULT_FIELD]: '',
    [SERVICE_VISIT_DATE_FIELD]: '',
    [SERVICE_STATUS_FIELD]: '待受理',
  }
  return [...serviceRows, visit]
}

/**
 * 报送达标判定：
 * - 已归档的只认最先一份，重复报送直接拒绝；
 * - 缺达标读数（无有效采集）先退回补录；
 * - 点击的结论与最新读数重算结果不一致时，以采集时间最新一条为准并提示；
 * - 提交完立即落库：处理人、采集依据、结论一并冻结，刷新不再跳回。
 */
export function judgeRoom(
  row: EntryRow,
  serviceRows: EntryRow[],
  input: { intended: '达标' | '不达标'; operator: string },
): { row: EntryRow; serviceRows: EntryRow[]; result: ActionResult } {
  const internals = normalizeRoomRow(row)
  if (internals.judgement) {
    return {
      row: toFlatRoomRow(row),
      serviceRows,
      result: {
        ok: false,
        message: `该监测点已按 ${internals.judgement.judgedAt} 的报送判定为「${internals.judgement.conclusion}」，重复报送只记最先一份`,
      },
    }
  }

  const latest = latestReading(internals)
  if (!latest) {
    return {
      row: toFlatRoomRow(row),
      serviceRows,
      result: {
        ok: false,
        message: '达标读数缺失，请先补录室温读数与采集时间后再报送判定',
      },
    }
  }

  const conclusion: RoomJudgement['conclusion'] = qualifies(latest.value)
    ? '达标'
    : '不达标'
  if (conclusion !== input.intended) {
    return {
      row: toFlatRoomRow(row),
      serviceRows,
      result: {
        ok: false,
        message: `采集时间最新一条读数为 ${latest.value}℃（${latest.collectedAt}），按口径应为「${conclusion}」，与本次「${input.intended}」不一致，请核对后再报送`,
      },
    }
  }

  const frozen = freezeJudgement(internals, conclusion, latest, input.operator)
  const nextRow = toFlatRoomRow({ ...row, _rt: frozen })
  const nextServiceRows =
    conclusion === '不达标'
      ? ensureHouseholdVisit(serviceRows, row, frozen)
      : serviceRows
  const driven =
    conclusion === '不达标' && nextServiceRows.length !== serviceRows.length
      ? '，已生成入户服务待上门清单'
      : ''
  return {
    row: nextRow,
    serviceRows: nextServiceRows,
    result: {
      ok: true,
      message: `达标判定已落库：依据 ${latest.collectedAt} 读数 ${latest.value}℃ 判定「${conclusion}」，处理人 ${input.operator}${driven}`,
    },
  }
}

/** 室温口径统计：本月达标率只统计本月已报送判定的监测点，全部页面共用。 */
export function roomStats(rows: EntryRow[], reference = new Date()): RoomStatsResult {
  const presented = rows.map((row) => toFlatRoomRow(row))
  const currentMonth = `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}`

  let pendingCount = 0
  let nonCompliantCount = 0
  let monthJudged = 0
  let monthQualified = 0

  for (const row of presented) {
    const internals = normalizeRoomRow(row)
    if (String(row.status) === ROOMTEMP_WAIT_COLLECT) {
      pendingCount += 1
    }
    if (String(row.status) === ROOMTEMP_NON_COMPLIANT) {
      nonCompliantCount += 1
    }
    if (internals.judgement && monthOf(internals.judgement.judgedAt) === currentMonth) {
      monthJudged += 1
      if (internals.judgement.conclusion === '达标') {
        monthQualified += 1
      }
    }
  }

  return {
    pendingCount,
    nonCompliantCount,
    monthJudged,
    monthQualified,
    monthRate: monthJudged === 0 ? null : (monthQualified / monthJudged) * 100,
  }
}
