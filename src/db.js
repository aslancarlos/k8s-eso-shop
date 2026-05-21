const mysql = require('mysql2/promise')

let pool

async function getPool() {
  if (pool) return pool

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'myappDB',
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10000,
  })

  await migrate(pool)
  return pool
}

async function migrate(pool) {
  const conn = await pool.getConnection()
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        category VARCHAR(100),
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status ENUM('pending','processing','shipped','delivered') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `)

    const [rows] = await conn.execute('SELECT COUNT(*) AS cnt FROM products')
    if (parseInt(rows[0].cnt) === 0) {
      await conn.execute(`
        INSERT INTO products (name, description, price, stock, category, image_url) VALUES
        ('Laptop Pro 15"', 'High-performance laptop with 16GB RAM and 512GB SSD', 1299.99, 15, 'Electronics', 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400'),
        ('Wireless Headphones', 'Noise-canceling Bluetooth headphones with 30h battery', 249.99, 42, 'Electronics', 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400'),
        ('Running Shoes', 'Lightweight trail running shoes, sizes 36-46', 119.99, 78, 'Sports', 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400'),
        ('Mechanical Keyboard', 'RGB backlit mechanical keyboard, Cherry MX Blue switches', 89.99, 31, 'Electronics', 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400'),
        ('Yoga Mat Premium', 'Non-slip 6mm thick yoga mat with carry strap', 49.99, 55, 'Sports', 'https://images.unsplash.com/photo-1601925228046-38b3f28e2e42?w=400'),
        ('Clean Code Book', 'A Handbook of Agile Software Craftsmanship by Robert C. Martin', 34.99, 20, 'Books', 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=400'),
        ('Camping Tent 4-Person', 'Waterproof dome tent, easy setup, 3 seasons', 189.99, 12, 'Outdoors', 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=400'),
        ('Smart Watch Series X', 'GPS, heart rate monitor, 7-day battery life', 399.99, 28, 'Electronics', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'),
        ('The Pragmatic Programmer', 'From Journeyman to Master — 20th Anniversary Edition', 39.99, 17, 'Books', 'https://images.unsplash.com/photo-1589998059171-988d887df646?w=400'),
        ('Dumbbell Set 20kg', 'Adjustable rubber-coated dumbbell set with rack', 159.99, 8, 'Sports', 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400'),
        ('Backpack 40L', 'Waterproof hiking backpack with laptop compartment', 79.99, 36, 'Outdoors', 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=400'),
        ('USB-C Hub 7-in-1', 'HDMI 4K, USB 3.0 x3, SD card, 100W PD charging', 59.99, 63, 'Electronics', 'https://images.unsplash.com/photo-1625480860249-be231806c8f7?w=400')
      `)

      await conn.execute(`
        INSERT INTO orders (customer_name, customer_email, total, status) VALUES
        ('Ana Costa', 'ana.costa@example.com', 1549.98, 'delivered'),
        ('Bruno Alves', 'bruno.alves@example.com', 299.97, 'shipped'),
        ('Carla Souza', 'carla.souza@example.com', 229.98, 'processing')
      `)

      const [orders] = await conn.execute('SELECT id FROM orders ORDER BY id')
      const [products] = await conn.execute('SELECT id, price FROM products ORDER BY id')
      const p = Object.fromEntries(products.map(r => [r.id, r.price]))

      const items = [
        [orders[0].id, 1,  1, p[1]],
        [orders[0].id, 2,  1, p[2]],
        [orders[1].id, 3,  1, p[3]],
        [orders[1].id, 5,  1, p[5]],
        [orders[1].id, 6,  1, p[6]],
        [orders[1].id, 9,  1, p[9]],
        [orders[2].id, 11, 1, p[11]],
        [orders[2].id, 4,  1, p[4]],
        [orders[2].id, 12, 1, p[12]],
      ]
      for (const [oid, pid, qty, price] of items) {
        await conn.execute(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)',
          [oid, pid, qty, price]
        )
      }
      console.log('Database seeded with sample data')
    }
    console.log('Database migration complete')
  } finally {
    conn.release()
  }
}

module.exports = { getPool }
