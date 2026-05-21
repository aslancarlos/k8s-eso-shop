const express = require('express')
const path = require('path')
const { getPool } = require('./db')

const app = express()
const PORT = process.env.PORT || 3000
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '')

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.locals.base = BASE

const router = express.Router()

router.use(express.static(path.join(__dirname, '..', 'public')))
router.use(express.json())
router.use(express.urlencoded({ extended: true }))

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    secretsSource: 'External Secrets Operator → Conjur Cloud',
    conjurPath: 'data/vault/dev-demo-aslan/dbuser_dual/{username,password,address}',
    dbHost: process.env.DB_HOST || 'not set',
    dbUser: process.env.DB_USER || 'not set',
  })
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

router.post('/orders', async (req, res) => {
  const { customer_name, customer_email, items } = req.body
  if (!customer_name || !customer_email || !items) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  try {
    const pool = await getPool()
    const parsed = typeof items === 'string' ? JSON.parse(items) : items
    let total = 0
    for (const item of parsed) {
      const [[prod]] = await pool.execute('SELECT price FROM products WHERE id = ?', [item.product_id])
      if (!prod) return res.status(400).json({ error: `Product ${item.product_id} not found` })
      total += prod.price * item.quantity
    }
    const [result] = await pool.execute(
      'INSERT INTO orders (customer_name, customer_email, total) VALUES (?,?,?)',
      [customer_name, customer_email, total.toFixed(2)]
    )
    const orderId = result.insertId
    for (const item of parsed) {
      const [[prod]] = await pool.execute('SELECT price FROM products WHERE id = ?', [item.product_id])
      await pool.execute(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)',
        [orderId, item.product_id, item.quantity, prod.price]
      )
      await pool.execute('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id])
    }
    res.redirect(BASE + '/orders/' + orderId)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
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

app.use(BASE || '/', router)
// Fallback for root when BASE_PATH is set
if (BASE) app.use('/', router)

app.listen(PORT, () => {
  console.log(`k8s-eso-shop running on :${PORT} (base: ${BASE || '/'})`)
  console.log(`DB_HOST=${process.env.DB_HOST || '(not set)'}`)
  console.log(`DB_USER=${process.env.DB_USER || '(not set)'}`)
})
