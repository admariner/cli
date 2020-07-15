'use strict'

// BREAKING CHANGES:
//
// - extraneous deps depth will be flattened to current location
// - will mark deps as extraneous when missing a top-level package.json file
// - will not mark deps as extraneous if they're deps of invalid deps
// - peer deps are now listed as regular deps, removed peerinvalid label and not mark peer deps as extraneous anymore
// - added error codes: ELSPROBLEMS, EJSONPARSE
// - might default to diff protocol when printing git repos resolved values
// - possible order of printed elements change in --parseable output
// - fixed consistency on --parseable output in which it would print root folder name if using a filter argument that could not match agains existing deps
// - fixed printing non-existing paths for missing dependencies when using --parseable
// - fixed undefined symlink output when using --parseble --long
//
const { resolve } = require('path')
const { EOL } = require('os')

const archy = require('archy')
const chalk = require('chalk')
const Arborist = require('@npmcli/arborist')
const { breadth } = require('treeverse')
const npa = require('npm-package-arg')

const npm = require('./npm.js')
const usageUtil = require('./utils/usage.js')
const completion = require('./utils/completion/installed-deep.js')
const output = require('./utils/output.js')

const _depth = Symbol('depth')
const _dedupe = Symbol('dedupe')
const _include = Symbol('include')
const _invalid = Symbol('invalid')
const _missing = Symbol('missing')
const _parent = Symbol('parent')
const _type = Symbol('type')

const usage = usageUtil(
  'ls',
  'npm ls [[<@scope>/]<pkg> ...]'
)

const cmd = (args, cb) => ls(args).then(() => cb()).catch(cb)

const isGitNode = (node) => {
  if (!node.resolved) return

  const { type } = npa(node.resolved)
  return type === 'git' || type === 'hosted'
}

const getHumanOutputItem = (node, { color, long }) => {
  const { extraneous, pkgid, path } = node
  let printable = pkgid

  // special formatting for top-level package name
  if (node.isRoot) {
    const hasNoPackageJson = !Object.keys(node.package).length
    if (hasNoPackageJson) {
      printable = path
    } else {
      printable += `${long ? EOL : ' '}${path}`
    }
  }

  const missingMsg = `UNMET ${node[_type] === 'optional' ? 'OPTIONAL ' : ''}DEPENDENCY `
  const label =
    (node[_missing] ? (color ? chalk.yellow.bgBlack(missingMsg) : missingMsg) : '') +
    `${printable}` +
    (node[_dedupe] ? ' deduped' : '') +
    (node[_invalid] ? (color ? chalk.red.bgBlack(' invalid') : ' invalid') : '') +
    (extraneous ? (color ? chalk.green.bgBlack(' extraneous') : ' extraneous') : '') +
    (isGitNode(node) ? ` (${node.resolved})` : '') +
    (node.isLink ? ` -> ${node.realpath}` : '') +
    (long ? `${EOL}${node.package.description || ''}` : '')
  const problem =
    node[_missing]
      ? `missing: ${pkgid}, required by ${node[_missing]}`
      : node[_invalid]
        ? `invalid: ${pkgid} ${path}`
        : extraneous
          ? `extraneous: ${pkgid} ${path}`
          : ''

  return {
    label,
    problem
  }
}

const edgesToNodes = (edge) => {
  const { name, spec } = edge
  const pkgid = `${name}@${spec}`
  let node = edge.to

  if (edge.missing || (edge.optional && !edge.to)) {
    node = { name, pkgid, [_missing]: edge.from.pkgid }
  }

  node[_type] = edge.type
  node[_invalid] = edge.invalid

  return node
}

const shouldInclude = (node, { parseable }) => (spec) => {
  if (node.satisfies(spec)) {
    // includes parents of included node if not in parseable mode
    if (!parseable) {
      let p = node[_parent]
      while (p) {
        p[_include] = true
        p = p[_parent]
      }
    }
    return true
  }
}

const filterByPositionalArgs = (args, node, opt) =>
  args.length > 0 ? args.some(shouldInclude(node, opt)) : true

const ls = async (args) => {
  const path = npm.prefix
  const arb = new Arborist({
    ...npm.flatOptions,
    legacyPeerDeps: false,
    path
  })
  let tree = await arb.loadActual()
  tree[_include] = args.length === 0

  const {
    color,
    depth,
    long,
    parseable,
    unicode
  } = npm.flatOptions
  const dev = npm.config.get('dev')
  const development = npm.config.get('development')
  const link = npm.config.get('link')
  const only = npm.config.get('only')
  const prod = npm.config.get('prod')
  const production = npm.config.get('production')
  const seen = new Set()
  const problems = new Set()

  const result = breadth({
    tree,
    visit (node) {
      seen.add(node)

      const { label, problem } = getHumanOutputItem(node, { color, long })
      const item = { label, nodes: [] }

      if (problem) {
        problems.add(problem)
      }

      // append current item to its parent.nodes which is the
      // structure expected by archy in order to print tree
      if (node[_include] && node[_parent]) {
        node[_parent].nodes.push(item)
      }

      // set initial _depth value in root nodeResult
      if (!node[_parent]) {
        node[_depth] = 0
      }

      return item
    },
    getChildren (node, nodeResult) {
      const filterDev = node === tree &&
        (dev || development || /^dev(elopment)?$/.test(only))
      const filterProd = node === tree &&
        (prod || production || /^prod(uction)?$/.test(only))
      const filterLink = node === tree && link

      return (!(node instanceof Arborist.Node) || node[_depth] > depth)
        ? []
        : [...node.edgesOut.values()]
          .filter(edge =>
            (filterDev ? edge.dev : true) &&
            (filterProd ? (!edge.dev && !edge.peer && !edge.peerOptional) : true) &&
            (filterLink ? (edge.to && edge.to.isLink) : true)
          )
          .map(edgesToNodes)
          // append extraneous children since they won't be in edgesOut
          .concat([...node.children.values()]
            .filter(i => i.extraneous)
          )
          .map(i => {
            if (seen.has(i)) {
              i = {
                pkgid: i.pkgid,
                package: i.package,
                [_dedupe]: true
              }
            }
            i[_parent] = nodeResult
            i[_include] =
              filterByPositionalArgs(args, i, { parseable })
            i[_depth] = node[_depth] + 1
            return i
          })
          .sort((a, b) => a.pkgid.localeCompare(b.pkgid))
    }
  })

  if (!result.nodes.length) {
    result.nodes = ['(empty)']

    // if filtering items, should exit with error code on no results
    if (args.length) {
      process.exitCode = 1
    }
  }

  if (parseable) {
    let out = ''
    for (const dep of seen) {
      if (dep.path && dep[_include]) {
        out += dep.path
        if (long) {
          out += `:${dep.pkgid}`
          out += dep.path !== dep.realpath ? `:${dep.realpath}` : ''
          out += dep.extraneous ? ':EXTRANEOUS' : ''
          out += dep.errors.length && dep.path !== resolve(npm.globalDir, '..') ? ':ERROR' : ''
          out += dep[_invalid] ? ':INVALID' : ''
        }
        out += EOL
      }
    }
    output(out.trim())
  } else {
    output(archy(result, '', { unicode }))
  }

  const [rootError] = tree.errors.filter(e =>
    e.code === 'EJSONPARSE' && e.path === resolve(path, 'package.json'))

  if (rootError) {
    throw Object.assign(
      new Error('Failed to parse root package.json'),
      { code: 'EJSONPARSE' }
    )
  }

  if (problems.size) {
    throw Object.assign(
      new Error([...problems].join(EOL)),
      { code: 'ELSPROBLEMS' }
    )
  }
}

module.exports = Object.assign(cmd, { usage, completion })
