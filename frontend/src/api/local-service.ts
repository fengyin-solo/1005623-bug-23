import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  HOUSEHOLDSERVICE_KEY,
  ROOMTEMP_KEY,
  ROOM_DEFAULT_HANDLER,
  judgeRoom,
  presentRoomRows,
  roomStats,
  submitRoomReading,
} from '@/data/roomtemp'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export type RoomActionPayload = {
  value?: number
  collectedAt?: string
  operator?: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 室温监测的唯一口径入口：历史平铺数据首次读取时收拢落库，之后列表、导出、首页都读这一份。
function roomRows(): EntryRow[] {
  const rows = listRows(ROOMTEMP_KEY)
  if (!rows.every((row) => Boolean(row._rt))) {
    const normalized = presentRoomRows(rows)
    saveRows(ROOMTEMP_KEY, normalized)
    return normalized
  }
  return presentRoomRows(rows)
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === ROOMTEMP_KEY ? roomRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: RoomActionPayload = {},
): ActionResult {
  const meta = moduleMeta(key)

  // 室温监测走专属口径：达标判定只算一次、提交即落库、不达标驱动入户服务待上门清单。
  if (key === ROOMTEMP_KEY) {
    return runRoomAction(id, action, payload)
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runRoomAction(id: number, action: string, payload: RoomActionPayload): ActionResult {
  const rows = roomRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的室温监测点` }
  }

  const row = rows[index]
  const operator = payload.operator?.trim() || ROOM_DEFAULT_HANDLER

  if (action === '提交采集') {
    const value = typeof payload.value === 'number' ? payload.value : Number.NaN
    const collectedAt = payload.collectedAt?.trim() ?? ''
    if (!Number.isFinite(value)) {
      return { ok: false, message: '请补录有效的室温读数（℃）后再提交采集' }
    }
    if (value < 5 || value > 40) {
      return { ok: false, message: `室温读数 ${value}℃ 超出合理范围（5℃-40℃），请核对后补录` }
    }
    if (!collectedAt) {
      return { ok: false, message: '请补录采集时间后再提交采集' }
    }
    const outcome = submitRoomReading(row, { value, collectedAt, operator })
    if (!outcome.result.ok) {
      return outcome.result
    }
    const next = [...rows]
    next[index] = outcome.row
    saveRows(ROOMTEMP_KEY, next)
    return outcome.result
  }

  if (action === '判定达标' || action === '标记不达标') {
    const serviceRows = listRows(HOUSEHOLDSERVICE_KEY)
    const outcome = judgeRoom(row, serviceRows, {
      intended: action === '判定达标' ? '达标' : '不达标',
      operator,
    })
    if (!outcome.result.ok) {
      return outcome.result
    }
    const next = [...rows]
    next[index] = outcome.row
    saveRows(ROOMTEMP_KEY, next)
    if (outcome.serviceRows !== serviceRows) {
      saveRows(HOUSEHOLDSERVICE_KEY, outcome.serviceRows)
    }
    return outcome.result
  }

  return { ok: false, message: `室温监测点没有登记「${action}」这个动作` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const rows = key === ROOMTEMP_KEY ? roomRows() : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function roomMonthStats() {
  return roomStats(roomRows())
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = meta.key === ROOMTEMP_KEY ? roomRows() : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const stats = roomStats(roomRows())
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '室温本月达标率', value: stats.monthRate },
  ]
  return { cards, modules }
}
