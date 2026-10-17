// The tree view's radial layout (web/layout.js): the root at the centre, one ring per level,
// siblings a fixed arc apart, and a wide tree squeezed to the circle without its ends meeting.

import { describe, expect, test } from 'claude-code/testing'

import '../web/vendor/d3.v7.9.0.min.js'
import '../web/layout.js'

type Spec = { id: string; children?: Spec[] }
type Placed = { data: Spec; depth: number; parent: Placed | null; angle: number; radius: number; descendants: () => Placed[] }
type D3 = { hierarchy: (d: Spec) => Placed }
type Api = { radial: (d3: D3, root: Placed, breadth: number, depth: number) => Placed; normalAngle: (a: number) => number }

const g = globalThis as unknown as { d3: D3; RftLayout: Api }
const L = g.RftLayout
const BREADTH = 60
const DEPTH = 140

const leaf = (id: string): Spec => ({ id })
const chain = (ids: string[], end: Spec[]): Spec =>
  ids.reduceRight<Spec[]>((kids, id) => [{ id, children: kids }], end)[0]!

function layout(spec: Spec) {
  const root = L.radial(g.d3, g.d3.hierarchy(spec), BREADTH, DEPTH)
  return new Map(root.descendants().map(n => [n.data.id, n]))
}
const arc = (a: Placed, b: Placed) => Math.abs(a.angle - b.angle) * a.radius
const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(1e-9)

describe('radial layout', () => {
  // the demo's shape: a chain from the root, then a few small fans
  const demo = chain(['D00', 'E01', 'D01', 'E02'], [
    chain(['D02', 'E03'], [leaf('D03'), leaf('D04'), leaf('D08')]),
    leaf('D06'),
    leaf('D07'),
  ])

  test('the root sits at the centre and each level on its own ring', () => {
    const at = layout(demo)
    expect(at.get('D00')!.radius).toBe(0)
    for (const n of at.values()) expect(n.radius).toBe(n.depth * DEPTH)
  })

  test('a deep, thin tree keeps siblings a fixed arc apart instead of filling the circle', () => {
    const at = layout(demo)
    const [d02, d06, d07] = ['D02', 'D06', 'D07'].map(id => at.get(id)!)
    near(arc(d02!, d06!), BREADTH)
    near(arc(d06!, d07!), BREADTH)
    near(arc(at.get('D03')!, at.get('D04')!), BREADTH)
    const angles = [...at.values()].map(n => n.angle)
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(Math.PI / 2)
    // the chain runs straight out from the root, the way the tree grows
    for (const id of ['E01', 'D01', 'E02']) near(at.get(id)!.angle, 0)
  })

  test('a wide tree is squeezed to the full circle with a gap between its ends', () => {
    const at = layout({ id: 'R', children: Array.from({ length: 40 }, (_, i) => leaf(`L${i}`)) })
    const angles = Array.from({ length: 40 }, (_, i) => at.get(`L${i}`)!.angle)
    const step = angles[1]! - angles[0]!
    near(step, (2 * Math.PI) / 40)
    near(angles[39]! - angles[0]!, 2 * Math.PI - step)
  })

  test('a single note is just the centre', () => {
    const at = layout(leaf('D00'))
    expect(at.get('D00')!.radius).toBe(0)
    expect(at.get('D00')!.angle).toBe(0)
  })

  test('angles normalise into [0, 2π)', () => {
    near(L.normalAngle(-Math.PI / 2), (3 * Math.PI) / 2)
    near(L.normalAngle(2 * Math.PI), 0)
    expect(L.normalAngle(1)).toBe(1)
  })
})
