import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

function loadArtifactFilters() {
  const start = clientSource.indexOf('      const artifactFileName =')
  const end = clientSource.indexOf('      const formatArtifactSize =', start)
  assert.ok(start >= 0 && end > start, 'artifact filter block must stay in client.js')
  const context = {
    unwrapItems: (value) => Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []),
  }
  vm.runInNewContext(`${clientSource.slice(start, end)}\nglobalThis.__filters = { filterCustomerArtifacts, filterArticleWorkspaceFiles }`, context)
  return context.__filters
}

test('文章虾详情只展示 html、pdf、png，扩展名大小写不影响过滤', () => {
  const { filterCustomerArtifacts } = loadArtifactFilters()
  const articleScope = { ref: 'shrimp-c433b57dac59419d', domain: 'article' }
  const artifacts = [
    { name: 'article.HTML' },
    { name: 'article.PdF' },
    { name: 'article.PnG' },
    { name: 'article.md' },
    { name: 'article.json' },
    { name: 'article.txt' },
    { name: 'article.docx' },
    { name: 'article.zip' },
  ]
  assert.deepEqual(filterCustomerArtifacts(artifacts, articleScope).map((item) => item.name), ['article.HTML', 'article.PdF', 'article.PnG'])
})

test('文章工作空间的本轮文件和目录树文件列表只保留三种交付扩展名', () => {
  const { filterArticleWorkspaceFiles } = loadArtifactFilters()
  const files = [
    { path: '/workspace/article.HTML' },
    { path: '/workspace/article.pdf' },
    { path: '/workspace/article.PNG' },
    { path: '/workspace/article.md' },
    { path: '/workspace/article.json' },
    { path: '/workspace/article.txt' },
    { path: '/workspace/article.docx' },
    { path: '/workspace/article.zip' },
  ]
  assert.deepEqual(filterArticleWorkspaceFiles(files, { shrimpRef: 'shrimp-c433b57dac59419d' }).map((item) => item.path), [
    '/workspace/article.HTML', '/workspace/article.pdf', '/workspace/article.PNG',
  ])
})

test('非文章虾继续使用既有通用产物过滤，不受文章专属过滤影响', () => {
  const { filterCustomerArtifacts, filterArticleWorkspaceFiles } = loadArtifactFilters()
  const artifacts = [{ name: 'report.docx' }, { name: 'report.zip' }, { name: 'report.md' }]
  assert.deepEqual(filterCustomerArtifacts(artifacts, { ref: 'other-shrimp', domain: 'ppt' }).map((item) => item.name), ['report.docx', 'report.zip', 'report.md'])
  const files = [{ path: '/workspace/report.docx' }, { path: '/workspace/report.zip' }, { path: '/workspace/report.md' }]
  assert.deepEqual(filterArticleWorkspaceFiles(files, { ref: 'other-shrimp', domain: 'ppt' }), files)
})

test('文章过滤只在显式文章 scope 下启用，避免误伤其他运行', () => {
  assert.match(clientSource, /const ARTICLE_SHRIMP_REF = 'shrimp-c433b57dac59419d'/)
  assert.match(clientSource, /const articleOnly = isArticleScope\(focusArtifact\)/)
  assert.match(clientSource, /filterCustomerArtifacts\(value, focusArtifact\)/)
  assert.match(clientSource, /filterArticleWorkspaceFiles\(\(data\.files \|\| \[\]\)/)
})
