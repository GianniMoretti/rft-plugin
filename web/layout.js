// The tree view's radial layout as a pure function over a d3 hierarchy, so the plugin's tests
// can check it. Loaded by the page before app.js; it sets `globalThis.RftLayout` and touches
// nothing else.
(function (root) {
  'use strict'

  const TAU = 2 * Math.PI

  /**
   * A radial tidy tree: the root at the centre, depth `depth` world units per level, and every
   * node given `angle` (radians, clockwise from up, as d3.linkRadial takes it) and `radius`.
   * Siblings sit `breadth` units apart along their arc and cousins twice that, whatever their
   * depth (the separation (a, b) => (a.parent == b.parent ? 1 : 2) / a.depth); a tree too wide
   * for that is squeezed to the full circle, with a gap left between its two ends.
   */
  function radial(d3, top, breadth, depth) {
    const sep = (a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth)
    d3.tree().nodeSize([1, depth]).separation(sep)(top)
    let left = top, right = top
    top.each(n => { if (n.x < left.x) left = n; if (n.x > right.x) right = n })
    const span = right.x - left.x
    // one unit of x is the angle between siblings at depth 1, `breadth` along the arc there
    let unit = breadth / depth
    if (span > 0) unit = Math.min(unit, TAU / (span + sep(left, right)))
    top.each(n => { n.angle = (n.x - top.x) * unit; n.radius = n.y })
    return top
  }

  /** An angle brought into [0, 2π). */
  const normalAngle = a => ((a % TAU) + TAU) % TAU

  root.RftLayout = { radial, normalAngle }
})(typeof globalThis !== 'undefined' ? globalThis : window)
