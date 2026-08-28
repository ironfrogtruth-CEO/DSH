import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCatchDraftFacts,
  buildRunBody,
  draftCardTitle,
  runCardTitle,
} from './work-contract.js'

const contract = {
  schema_version: 'cybermarcus_work_contract.v1',
  goal_contract: { problem: '为平安员工交付企业健康报告，供 HR 汇报使用' },
  qa_contract: { final_acceptance: ['报告须含全部 15 Gate', '结论须有官方来源引用'] },
  gates: ['goal', 'acceptance', 'knowledge_strategy'],
}

test('facts 构造：不含合同时与现实现一致，且不出现 work_contract 键', () => {
  const facts = buildCatchDraftFacts({
    product: '企业健康报告',
    institution: '平安',
    goal: '为 HR 汇报使用',
    acceptance: '至少一条验收',
  })
  assert.deepEqual(facts, {
    product_name: '企业健康报告',
    institution_name: '平安',
    goal_text: '为 HR 汇报使用',
    acceptance_text: '至少一条验收',
    goal_complete: true,
    acceptance_complete: true,
    current_step_key: 'knowledge_strategy',
  })
  assert.equal('work_contract' in facts, false)
})

test('facts 构造：含合同时附 facts.work_contract 原样引用', () => {
  const facts = buildCatchDraftFacts({
    product: '企业健康报告',
    institution: '平安',
    goal: '交付报告',
    acceptance: '',
    workContract: contract,
  })
  assert.equal(facts.work_contract, contract)
  assert.equal(facts.acceptance_text, '报告须含全部 15 Gate\n结论须有官方来源引用')
  assert.equal(facts.acceptance_complete, true)
  assert.equal(facts.current_step_key, 'knowledge_strategy')
})

test('投影不覆盖用户已填值：用户 goal/acceptance 优先于工作合同内容', () => {
  const facts = buildCatchDraftFacts({
    product: '报告',
    institution: '平安',
    goal: '用户手写目标',
    acceptance: '用户手写验收',
    workContract: {
      goal_contract: { problem: '合同里的问题' },
      qa_contract: { final_acceptance: ['合同里的验收'] },
    },
  })
  assert.equal(facts.goal_text, '用户手写目标')
  assert.equal(facts.acceptance_text, '用户手写验收')
})

test('数组型 final_acceptance join：仅字符串项以 \\n 连接，跳过非字符串', () => {
  const facts = buildCatchDraftFacts({
    product: '报告',
    institution: '平安',
    goal: '目标',
    acceptance: '',
    workContract: {
      qa_contract: { final_acceptance: [' 验收A ', 42, '验收B', '', null] },
    },
  })
  assert.equal(facts.acceptance_text, '验收A\n验收B')
  assert.equal(facts.acceptance_complete, true)
  assert.equal(facts.current_step_key, 'knowledge_strategy')
})

test('run body：仅在传参时附顶层键，空参零变化', () => {
  const base = { inputs: { topic: '企业健康' }, mode: 'full' }
  const withKeys = buildRunBody(base, {
    workContractChecksum: 'sha256:abc123def456',
    pipelineVersionId: 'v2026.08.28-01',
  })
  assert.equal(withKeys.work_contract_checksum, 'sha256:abc123def456')
  assert.equal(withKeys.pipeline_version_id, 'v2026.08.28-01')
  assert.equal(withKeys.inputs, base.inputs)
  assert.equal(withKeys.mode, 'full')

  const empty = buildRunBody(base, {})
  assert.deepEqual(empty, base)
  assert.deepEqual(Object.keys(empty), Object.keys(base))

  const half = buildRunBody(base, { workContractChecksum: '' })
  assert.equal('work_contract_checksum' in half, false)
  assert.equal('pipeline_version_id' in half, false)
})

test('checksum 透传不变形：含特殊字符的字符串原样携带', () => {
  const checksum = 'sha256:AbCd-0123_xyz+/=='
  const body = buildRunBody({}, { workContractChecksum: checksum })
  assert.equal(body.work_contract_checksum, checksum)
  assert.equal(body.work_contract_checksum.length, checksum.length)
})

test('卡片标题：draftCardTitle 仅在 hasContract 时追加，runCardTitle 固定追加', () => {
  const base = '创建草稿：企业健康报告@平安'
  assert.equal(draftCardTitle(base, {}), base)
  assert.equal(draftCardTitle(base, { hasContract: false }), base)
  assert.equal(draftCardTitle(base, { hasContract: true }), '创建草稿：企业健康报告@平安（含工作合同）')
  assert.equal(runCardTitle('运行虾：enterprise-health'), '运行虾：enterprise-health锁定运行合同')
})
