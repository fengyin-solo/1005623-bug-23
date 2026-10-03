<template>
  <section class="page" data-module="householdservice">
    <header class="page-head">
      <div>
        <h2>入户服务管理</h2>
        <p class="page-desc">
          维护入户服务单；室温监测判定不达标会自动转入待上门清单（状态：已安排），同一监测点重复报送只转一张单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入户服务单</button>
        <button class="btn" type="button" @click="exportRows">导出入户服务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
      <label class="filter-check">
        <input v-model="pendingVisitOnly" type="checkbox" @change="reload" />
        <span>只看待上门清单（室温不达标转办）</span>
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
          <td v-for="column in columns" :key="column">
            <template v-if="column === '服务内容' && row['来源监测点']">
              <span class="tag-warn">室温转办</span>{{ row[column] }}
            </template>
            <template v-else>{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</template>
          </td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无入户服务数据，室温不达标判定后会自动进入待上门清单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条入户服务记录；待上门 {{ pendingVisitCount }} 条由室温不达标结论驱动</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  filterRows,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { pendingVisitRows } from '@/data/roomtemp-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('householdservice')
const columns = ['服务单号', '报修用户', '服务内容', '受理人', '上门时间', '处理结果', '回访日期', '服务状态']
const actions = ['受理报修', '登记处理', '完成回访']
const statuses = ['待受理', '已安排', '已处理', '已回访']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const pendingVisitOnly = ref(false)
const filterFields = columns.slice(0, 3)

const pendingVisitCount = computed(() => pendingVisitRows().length)

const stats = computed(() => [
  { label: '待受理服务单', value: rows.value.filter((row) => String(row.status) === '待受理').length },
  { label: '待上门清单（室温转办）', value: pendingVisitCount.value },
  { label: '已处理服务单', value: rows.value.filter((row) => String(row.status) === '已处理').length },
  { label: '待回访服务单', value: rows.value.filter((row) => String(row.status) === '已回访').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  pendingVisitOnly.value = false
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '入户服务单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const all = listEntries(meta.key).items
    const scoped = pendingVisitOnly.value
      ? all.filter((row) => String(row['来源监测点'] ?? '') !== '' && String(row.status) === '已安排')
      : all
    const items = filterRows(scoped, filters.value)
    rows.value = items
    total.value = items.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入户服务列表读取失败'
  }
}

onMounted(reload)
</script>
