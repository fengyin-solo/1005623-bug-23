<template>
  <section class="page" data-module="roomtemp">
    <header class="page-head">
      <div>
        <h2>室温监测管理</h2>
        <p class="page-desc">维护室温监测点，围绕监测编号、住户地址、所属片区、室温读数做登记、采集报送与达标判定。达标结论统一按采集时间最新一条读数计算，报送一次即归档。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记室温监测点</button>
        <button class="btn" type="button" @click="exportRows">导出室温监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无室温监测数据，可先登记室温监测点</td>
        </tr>
      </tbody>
    </table>

    <div v-if="collectTarget" class="modal-mask" @click.self="closeCollect">
      <div class="modal-card">
        <h3 class="modal-title">提交采集 · {{ collectTarget['监测编号'] }}</h3>
        <p class="modal-hint">同一采集时间重复报送只记最先一份；已归档监测点可继续补采，当时结论保留。</p>
        <label class="modal-field">
          <span>室温读数（℃，达标线 18℃）</span>
          <input v-model.number="collectForm.value" type="number" step="0.1" min="5" max="40" placeholder="例如 20.3" />
        </label>
        <label class="modal-field">
          <span>采集时间</span>
          <input v-model="collectForm.collectedAt" type="datetime-local" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeCollect">取消</button>
          <button class="btn primary" type="button" @click="confirmCollect">提交采集</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条室温监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  roomMonthStats,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('roomtemp')
const columns = ["监测编号", "住户地址", "所属片区", "室温读数", "采集时间", "达标判定", "处理人", "监测状态"]
const actions = ["提交采集", "判定达标", "标记不达标"]
const statuses = ["待采集", "已采集", "已达标", "不达标"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const statCards = computed(() => {
  const stats = roomMonthStats()
  return [
    { label: '待采集点位', value: stats.pendingCount },
    { label: '不达标点位', value: stats.nonCompliantCount },
    {
      label: '本月达标率',
      value: stats.monthRate === null ? '本月暂无判定' : `${stats.monthRate.toFixed(1)}%`,
    },
  ]
})

const collectTarget = ref<EntryRow | null>(null)
const collectForm = ref<{ value: number | string | null; collectedAt: string }>({
  value: null,
  collectedAt: '',
})

function currentDateTimeLocal(): string {
  const now = new Date()
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '室温监测点登记入口尚未接入审批流'
}

function closeCollect() {
  collectTarget.value = null
  collectForm.value = { value: null, collectedAt: '' }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交采集') {
    collectTarget.value = row
    collectForm.value = { value: null, collectedAt: currentDateTimeLocal() }
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, { operator: store.operator })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function confirmCollect() {
  if (!collectTarget.value) {
    return
  }
  const rawValue = collectForm.value.value
  const numericValue =
    rawValue === null || rawValue === '' || Number.isNaN(Number(rawValue))
      ? undefined
      : Number(rawValue)
  const result = applyAction(meta.key, Number(collectTarget.value.id), '提交采集', {
    value: numericValue,
    collectedAt: collectForm.value.collectedAt.replace('T', ' '),
    operator: store.operator,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeCollect()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '室温监测列表读取失败'
  }
}

onMounted(reload)
</script>
