// The engine is a Workflow script, not a module: it has a top-level `return`, reads the
// `args` global and calls runtime hooks (agent, log, phase). Its pure helpers are still
// plain functions, so the tests pull them out of the source by name and evaluate them
// with a stub `log`. Keep every helper a top-level `function name(...) { ... }`.
'use strict'
const fs = require('fs')
const path = require('path')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'build-verify-patch.js'), 'utf8')

function grab(name) {
  const at = SRC.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('helper not found in engine: ' + name)
  let depth = 0
  for (let j = at; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function grabConst(name) {
  const m = new RegExp('^const ' + name + ' = ([^\\n]*(?:\\n(?!\\n)[^\\n]*)*?)\\n(?=\\n|const |function |\\/\\/)', 'm').exec(SRC)
  if (!m) throw new Error('const not found in engine: ' + name)
  return 'const ' + name + ' = ' + m[1]
}

function loadHelpers(names, opts) {
  const logs = []
  const code = [
    'const log = (m) => logs.push(String(m))',
    ...(opts && opts.consts ? opts.consts.map(grabConst) : []),
    ...names.map(grab),
    'return { ' + names.join(', ') + (opts && opts.consts ? ', ' + opts.consts.join(', ') : '') + ' }',
  ].join('\n')
  const out = new Function('logs', code)(logs)
  out.logs = logs
  return out
}

module.exports = { loadHelpers, SRC }
