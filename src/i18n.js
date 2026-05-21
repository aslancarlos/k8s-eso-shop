const path = require('path')
const fs = require('fs')

const SUPPORTED = ['pt', 'en', 'es']
const DEFAULT = 'pt'

const translations = {}
for (const lang of SUPPORTED) {
  const file = path.join(__dirname, 'locales', `${lang}.json`)
  translations[lang] = JSON.parse(fs.readFileSync(file, 'utf8'))
}

function detect(req) {
  if (req.query.lang && SUPPORTED.includes(req.query.lang)) return req.query.lang
  const cookie = req.cookies?.eso_lang
  if (cookie && SUPPORTED.includes(cookie)) return cookie
  const header = (req.headers['accept-language'] || '').toLowerCase()
  for (const lang of SUPPORTED) {
    if (header.startsWith(lang) || header.includes(`${lang}-`) || header.includes(`,${lang}`)) return lang
  }
  return DEFAULT
}

function make_t(dict) {
  return function t(key, vars = {}) {
    const parts = key.split('.')
    let val = dict
    for (const p of parts) val = val?.[p]
    if (typeof val !== 'string') return key
    return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `{{${k}}}`))
  }
}

function middleware(req, res, next) {
  const lang = detect(req)
  if (req.query.lang && SUPPORTED.includes(req.query.lang)) {
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https'
    res.cookie('eso_lang', lang, {
      maxAge: 365 * 24 * 3600 * 1000,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
    })
  }
  res.locals.lang = lang
  res.locals.t = make_t(translations[lang] || translations[DEFAULT])
  next()
}

module.exports = { middleware, SUPPORTED }
