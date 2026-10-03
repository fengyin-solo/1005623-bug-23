/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 室温监测点一次采集读数：一个监测点可多次采集，按采集时间取最新一条。 */
export type RoomReading = {
  value: number
  collectedAt: string
  collectedBy: string
}

/** 达标判定报送：只算一次，提交即落库冻结，重复报送以最先一份为准。 */
export type RoomJudgement = {
  conclusion: '达标' | '不达标'
  judgedAt: string
  handler: string
  basisValue: number
  basisCollectedAt: string
}

/** 室温监测点内部结构化数据，与列表展示字段同库存放，作为唯一口径来源。 */
export type RoomInternals = {
  code: string
  readings: RoomReading[]
  judgement: RoomJudgement | null
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  _rt?: RoomInternals
  [field: string]: string | number | boolean | RoomInternals | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number | null }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 室温监测口径统计：列表页、导出清单、首页达标率共用同一份结果。 */
export type RoomStatsResult = {
  pendingCount: number
  nonCompliantCount: number
  monthJudged: number
  monthQualified: number
  monthRate: number | null
}
