import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  listRoomRows,
  resetRoomtemp,
  roomCsv,
  roomStats,
  submitJudgement,
  submitReading,
} from '@/data/roomtemp-domain'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 室温模块是单一数据源：列表/导出/首页的达标结论都走领域层，避免各处各算一遍。
const ROOMTEMP_KEY = 'roomtemp'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === ROOMTEMP_KEY ? listRoomRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 室温采集读数提交（缺失读数允许提交，领域层会标记退回补录）。 */
export function submitRoomReading(
  id: number,
  value: number | null,
  collectedAt: string,
): ActionResult {
  return submitReading(id, value, collectedAt)
}

/** 室温判定报送：按最新读数算一次、提交即归档；重复报送只保留最先那份。 */
export function submitRoomJudgement(id: number): ActionResult {
  const operator = useSessionStore().operator
  return submitJudgement(id, operator)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 室温模块不走通用状态翻转：结论只能由领域层按采集时间最新读数判定并冻结。
  if (key === ROOMTEMP_KEY) {
    if (action === '判定报送' || action === '判定达标' || action === '标记不达标') {
      return submitRoomJudgement(id)
    }
    if (action === '提交采集') {
      return { ok: false, message: '请先在采集表单中补录室温读数与采集时间后提交' }
    }
  }
  const meta = moduleMeta(key)
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

export function resetModule(key: string): PageResult {
  if (key === ROOMTEMP_KEY) {
    resetRoomtemp()
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  if (key === ROOMTEMP_KEY) {
    return roomCsv()
  }
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 室温模块的台账以领域层为唯一来源，避免读到旧种子里的另一份结论。
    const entries = meta.key === ROOMTEMP_KEY ? listRoomRows() : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const stats = roomStats()
  const rateText =
    stats.monthPassRate === null ? '—' : `${(stats.monthPassRate * 100).toFixed(1)}%（${stats.monthJudged}处已判定）`
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    // 与室温台账、导出清单同一口径：只统计已归档判定的本月达标率。
    { label: '待采集室温点位', value: stats.pending },
    { label: '室温不达标点位', value: stats.failed },
    { label: '本月室温达标率', value: rateText },
  ]
  return { cards, modules }
}
