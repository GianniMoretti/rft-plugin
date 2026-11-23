// The tree view's inbox (web/inbox.js): what its button counts, and what an item is called and
// shown with in the list. The items are as the server gives them (tests/fixtures/inbox).

import { describe, expect, test } from 'claude-code/testing'

import '../web/inbox.js'

type Item = { key: string; url: string; title: string; why: string; priority: string; added: string; duplicate: boolean; brief: null | { date: string; lines: string[] } }
type Api = { count: (items: Item[] | null) => number; label: (item: Item) => string; sub: (item: Item) => string }

const I = (globalThis as unknown as { RftInbox: Api }).RftInbox

const item = (over: Partial<Item>): Item => ({ key: '', url: '', title: '', why: '', priority: '', added: '', duplicate: false, brief: null, ...over })

describe('the inbox in the tree view', () => {
  test('the button counts every item, one typed twice counted twice', () => {
    expect(I.count(null)).toBe(0)
    expect(I.count([])).toBe(0)
    expect(I.count([item({ key: 'arxiv:2406.01234' }), item({ key: 'arxiv:2406.01234', duplicate: true }), item({ key: 'https://e.org/x', brief: { date: '2026-11-20', lines: ['x'] } })])).toBe(3)
  })

  test('an item is called by its title, else by what its link says', () => {
    expect(I.label(item({ key: 'arxiv:2406.01234', url: 'https://arxiv.org/abs/2406.01234', title: 'Mixup at scale' }))).toBe('Mixup at scale')
    expect(I.label(item({ key: 'arxiv:2311.09876', url: 'https://arxiv.org/abs/2311.09876' }))).toBe('arXiv 2311.09876')
    expect(I.label(item({ key: 'arxiv:hep-th/9901001', url: 'https://arxiv.org/abs/hep-th/9901001' }))).toBe('arXiv hep-th/9901001')
    // a DOI as it was typed, not lowered as its identity is
    expect(I.label(item({ key: 'doi:10.1109/cvpr.2022.01553', url: 'https://doi.org/10.1109/CVPR.2022.01553' }))).toBe('doi 10.1109/CVPR.2022.01553')
    expect(I.label(item({ key: 'https://lilianweng.github.io/posts/2021-05-31-contrastive', url: 'https://lilianweng.github.io/posts/2021-05-31-contrastive/' }))).toBe('lilianweng.github.io/posts/2021-05-31-contrastive')
    expect(I.label(item({ key: 'https://openreview.net/forum?id=abc123', url: 'https://openreview.net/forum?id=abc123#discussion' }))).toBe('openreview.net/forum')
    expect(I.label(item({ key: 'https://example.org', url: 'https://example.org/' }))).toBe('example.org')
  })

  test('under it, why it was saved and the day it was added', () => {
    expect(I.sub(item({ why: 'maybe relevant to D04', added: '2026-11-16' }))).toBe('maybe relevant to D04 · added 2026-11-16')
    expect(I.sub(item({ why: 'IJCV survey, low' }))).toBe('IJCV survey, low')
    expect(I.sub(item({ added: '2026-11-02' }))).toBe('added 2026-11-02')
    expect(I.sub(item({}))).toBe('')
  })
})
