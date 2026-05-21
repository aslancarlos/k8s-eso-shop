const express = require('express')
const path = require('path')
const http = require('http')
const cookieParser = require('cookie-parser')
const { getPool } = require('./db')
const i18n = require('./i18n')

const app = express()
const PORT         = process.env.PORT || 3000
const BASE         = (process.env.BASE_PATH || '').replace(/\/$/, '')
const OPERATOR_URL = process.env.OPERATOR_URL || 'http://eso-shop-operator:8080'

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.locals.base = BASE

// Simple in-memory rate limiter — max requests per window per IP
function makeRateLimiter(maxReq, windowMs) {
  const counts = new Map()
  setInterval(() => counts.clear(), windowMs).unref()
  return (req, res, next) => {
    const ip = req.ip
    const n = (counts.get(ip) || 0) + 1
    counts.set(ip, n)
    if (n > maxReq) return res.status(429).json({ error: 'Too many requests' })
    next()
  }
}
const orderLimiter = makeRateLimiter(10, 60_000) // 10 orders/min per IP

const router = express.Router()

router.use(express.static(path.join(__dirname, '..', 'public')))
router.use(express.json())
router.use(express.urlencoded({ extended: true }))
router.use(cookieParser())
router.use(i18n.middleware)

// Security headers
router.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'"
  )
  next()
})

router.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

router.get('/', async (req, res) => {
  try {
    const pool = await getPool()
    const [products] = await pool.execute('SELECT * FROM products ORDER BY category, name')
    const categories = [...new Set(products.map(p => p.category))].sort()
    res.render('index', { products, categories, error: null })
  } catch (err) {
    console.error(err)
    res.render('index', { products: [], categories: [], error: err.message })
  }
})

router.get('/products', async (req, res) => {
  try {
    const pool = await getPool()
    const cat = req.query.category
    const q = cat
      ? ['SELECT * FROM products WHERE category = ? ORDER BY name', [cat]]
      : ['SELECT * FROM products ORDER BY category, name', []]
    const [products] = await pool.execute(...q)
    const [allProds] = await pool.execute('SELECT DISTINCT category FROM products ORDER BY category')
    res.render('products', {
      products,
      categories: allProds.map(r => r.category),
      activeCategory: cat || null,
      error: null,
    })
  } catch (err) {
    console.error(err)
    res.render('products', { products: [], categories: [], activeCategory: null, error: err.message })
  }
})

router.get('/orders', async (req, res) => {
  try {
    const pool = await getPool()
    const [orders] = await pool.execute(`
      SELECT o.*, COUNT(oi.id) AS item_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `)
    res.render('orders', { orders, error: null })
  } catch (err) {
    console.error(err)
    res.render('orders', { orders: [], error: err.message })
  }
})

router.get('/orders/:id', async (req, res) => {
  try {
    const pool = await getPool()
    const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id])
    if (!order) return res.status(404).send('Not found')
    const [items] = await pool.execute(`
      SELECT oi.*, p.name, p.image_url, p.category
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `, [req.params.id])
    res.render('order-detail', { order, items, error: null })
  } catch (err) {
    console.error(err)
    res.status(500).render('order-detail', { order: null, items: [], error: err.message })
  }
})

router.post('/orders', orderLimiter, async (req, res) => {
  const { customer_name, customer_email, items } = req.body
  if (!customer_name || !customer_email || !items) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  try {
    const pool = await getPool()
    const parsed = typeof items === 'string' ? JSON.parse(items) : items
    // Validate all products exist and fetch prices in one pass
    const productIds = [...new Set(parsed.map(i => i.product_id))]
    const placeholders = productIds.map(() => '?').join(',')
    const [prods] = await pool.execute(
      `SELECT id, price, stock FROM products WHERE id IN (${placeholders})`,
      productIds
    )
    const prodMap = Object.fromEntries(prods.map(p => [p.id, p]))
    let total = 0
    for (const item of parsed) {
      const prod = prodMap[item.product_id]
      if (!prod) return res.status(400).json({ error: 'Invalid product' })
      if (item.quantity < 1) return res.status(400).json({ error: 'Invalid quantity' })
      total += prod.price * item.quantity
    }
    const [result] = await pool.execute(
      'INSERT INTO orders (customer_name, customer_email, total) VALUES (?,?,?)',
      [customer_name, customer_email, total.toFixed(2)]
    )
    const orderId = result.insertId
    for (const item of parsed) {
      const prod = prodMap[item.product_id]
      await pool.execute(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)',
        [orderId, item.product_id, item.quantity, prod.price]
      )
      // Atomic: only decrement if stock is sufficient — prevents negative stock
      const [upd] = await pool.execute(
        'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
        [item.quantity, item.product_id, item.quantity]
      )
      if (upd.affectedRows === 0) {
        console.warn('Stock insufficient for product %d during order %d', item.product_id, orderId)
      }
    }
    res.redirect(BASE + '/orders/' + orderId)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Order could not be processed' })
  }
})

router.get('/secrets-info', async (req, res) => {
  try {
    const pool = await getPool()
    const [[result]] = await pool.execute('SELECT NOW() AS db_time')
    res.render('secrets-info', {
      dbConnected: true,
      dbTime: result.db_time,
      dbHost: process.env.DB_HOST,
      dbUser: process.env.DB_USER,
      dbPass: process.env.DB_PASS ? '••••••••' : 'not set',
      dbName: process.env.DB_NAME || 'myappDB',
      secretName: process.env.SECRET_NAME || 'eso-shop-db-creds',
      esoNamespace: process.env.POD_NAMESPACE || 'eso-shop',
    })
  } catch (err) {
    res.render('secrets-info', {
      dbConnected: false,
      dbTime: null,
      dbHost: process.env.DB_HOST || 'not set',
      dbUser: process.env.DB_USER || 'not set',
      dbPass: '••••••••',
      dbName: process.env.DB_NAME || 'myappDB',
      secretName: process.env.SECRET_NAME || 'eso-shop-db-creds',
      esoNamespace: process.env.POD_NAMESPACE || 'eso-shop',
      error: err.message,
    })
  }
})

// Proxy do status do operador para evitar CORS no browser
function fetchOperatorStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL('/status', OPERATOR_URL)
    http.get(url.toString(), (res) => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve(JSON.parse(d)) }
        catch { reject(new Error('Invalid operator response')) }
      })
    }).on('error', reject)
  })
}

router.get('/dashboard', (req, res) => res.render('dashboard'))

router.get('/api/dashboard', async (req, res) => {
  const [opStatus, dbOk] = await Promise.all([
    fetchOperatorStatus().catch(e => ({ error: e.message })),
    getPool().then(p => p.execute('SELECT 1')).then(() => true).catch(() => false),
  ])
  res.json({ ...opStatus, dbConnected: dbOk })
})

app.use(BASE || '/', router)
// Fallback for root when BASE_PATH is set
if (BASE) app.use('/', router)

app.listen(PORT, () => {
  console.log(`k8s-eso-shop running on :${PORT} (base: ${BASE || '/'})`)
  console.log(`DB_HOST=${process.env.DB_HOST || '(not set)'}`)
  console.log(`DB_USER=${process.env.DB_USER || '(not set)'}`)
})
