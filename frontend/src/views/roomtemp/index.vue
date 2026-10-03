<template>
  <section class="page" data-module="roomtemp">
    <header class="page-head">
      <div>
        <h2>室温监测管理</h2>
        <p class="page-desc">
          维护室温监测点与采集读数；达标判定统一按采集时间最新一条读数只算一次，提交即归档落库，列表、导出清单、首页达标率同为一份口径。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出室温监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
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
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openReading(row)">提交采集/补录</button>
            <button class="link" type="button" @click="reportJudgement(row)">判定报送</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无室温监测数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="formOpen" class="modal-mask" @click.self="closeReading">
      <form class="modal-card" @submit.prevent="confirmReading">
        <h3 class="modal-title">提交采集读数 · {{ form.code }}</h3>
        <p class="page-desc">{{ form.address }}（{{ form.area }}）</p>
        <label class="filter-item">
          <span>采集时间</span>
          <input v-model="form.collectedAt" placeholder="如 2026-10-03 09:00" required />
        </label>
        <label class="filter-item">
          <span>室温读数（℃）；现场缺失可留空，提交后按缺失退回补录</span>
          <input v-model.number="form.tempInput" type="number" step="0.1" min="0" max="40" placeholder="如 19.6，缺失请留空" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeReading">取消</button>
          <button class="btn primary" type="submit">提交采集</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条室温监测记录；已归档点位按当时判定结论保留，不随后续读数改写</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  submitRoomJudgement,
  submitRoomReading,
} from '@/api/local-service'
import { roomStats } from '@/data/roomtemp-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('roomtemp')
const columns = ['监测编号', '住户地址', '所属片区', '室温读数', '采集时间', '达标判定', '处理人', '监测状态']
const statuses = ['待采集', '已采集', '已达标', '不达标']
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})

const statsCards = computed(() => {
  const stats = roomStats()
  return [
    { label: '待采集点位', value: stats.pending },
    { label: '不达标点位', value: stats.failed },
    {
      label: '本月达标率',
      value: stats.monthPassRate === null ? '—' : `${(stats.monthPassRate * 100).toFixed(1)}%（${stats.monthJudged}处已判定）`,
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const formOpen = ref(false)
const formError = ref('')
const form = reactive({ id: 0, code: '', address: '', area: '', collectedAt: '', tempInput: '' as '' | number })

function flash(message: string, ok: boolean) {
  if (ok) {
    successMessage.value = message
    errorMessage.value = ''
  } else {
    errorMessage.value = message
    successMessage.value = ''
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openReading(row: EntryRow) {
  form.id = Number(row.id)
  form.code = String(row['监测编号'])
  form.address = String(row['住户地址'])
  form.area = String(row['所属片区'])
  form.collectedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
  form.tempInput = ''
  formError.value = ''
  formOpen.value = true
}

function closeReading() {
  formOpen.value = false
  formError.value = ''
}

function confirmReading() {
  if (!form.collectedAt.trim()) {
    formError.value = '请填写采集时间'
    return
  }
  const missing = form.tempInput === '' || form.tempInput === null
  const value = missing ? null : Number(form.tempInput)
  if (!missing && !Number.isFinite(value)) {
    formError.value = '室温读数必须是数字；若现场缺失请留空走补录'
    return
  }
  const result = submitRoomReading(form.id, value, form.collectedAt.trim())
  if (!result.ok) {
    formError.value = result.message
    return
  }
  formOpen.value = false
  reload()
  flash(result.message, true)
}

function reportJudgement(row: EntryRow) {
  const result = submitRoomJudgement(Number(row.id))
  reload()
  flash(result.message, result.ok)
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
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
