require('dotenv').config();
const { MongoClient, ObjectId, Double, Int32 } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('Define MONGO_URI in .env');
const client = new MongoClient(uri);

const CUISINES = ['mexican','italian','japanese','chinese','american','french','indian','thai','mediterranean','peruvian'];
const CITIES = ['Guatemala City','Mixco','Villa Nueva','Petapa','Amatitlan', 'Carretera'];
const STATUSES = ['pending','preparing','out_for_delivery','delivered','cancelled','paid'];
const INGREDIENTS_POOL = ['chicken','beef','pork','fish','onion','tomato','cheese','lettuce','rice','beans','pepper','garlic','oil','salt','lemon'];
const TAGS_POOL = ['spicy','popular','vegan','vegetarian','gluten-free','new','recommended','fast'];
const REVIEW_WORDS = ['rápido','servicio','excelente','malo','lento','delicioso','feo','increíble','recomendado','pésimo'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return parseFloat((Math.random() * (max - min) + min).toFixed(2)); }
function pick(arr, n) { const s = [...arr].sort(() => 0.5 - Math.random()); return s.slice(0, Math.min(n, s.length)); }
function randCoords() { return [parseFloat((-90.6 + Math.random() * 0.4).toFixed(6)), parseFloat((14.5 + Math.random() * 0.3).toFixed(6))]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

// Inserta en lotes para no saturar memoria
async function insertInBatches(collection, docs, batchSize = 500) {
  let inserted = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await collection.insertMany(batch, { ordered: false });
    inserted += batch.length;
    process.stdout.write(`\r    ${inserted}/${docs.length}`);
  }
  console.log('');
}

async function seed() {
  await client.connect();
  const db = client.db();
  console.log('✅ Connected to MongoDB\n');

  // ── Limpiar datos de seed anteriores ────────────────────────────────────────
  console.log('🧹 Limpiando datos de seed anteriores...');
  await db.collection('users').deleteMany({ email: /seed\.com/ });
  await db.collection('restaurants').deleteMany({ name: /^Restaurant \d/ });
  await db.collection('menu_items').deleteMany({ name: /^Dish \d/ });
  await db.collection('orders').deleteMany({ order_number: /^ORD-SEED/ });
  await db.collection('reviews').deleteMany({ title: /^Review for order ORD-SEED/ });
  console.log('   Listo\n');

  // ── 1. Users: 600 (100 staff + 500 customers) ───────────────────────────────
  console.log('👤 Insertando 600 usuarios...');
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const userDocs = Array.from({ length: 600 }, (_, i) => ({
    name: `User Seed ${i + 1}`,
    email: `user${i + 1}@seed.com`,
    password_hash: passwordHash,
    role: i < 100 ? 'staff' : 'customer',
    phone: `+502-${String(randInt(10000000, 99999999))}`,
    address: { street: `Calle ${randInt(1,20)} #${randInt(1,50)}`, city: rand(CITIES), zip: `0${randInt(1000,9999)}` },
    preferences: { favorite_cuisines: pick(CUISINES, 2) },
    createdAt: daysAgo(randInt(0, 365))
  }));
  await insertInBatches(db.collection('users'), userDocs);
  const allUsers = await db.collection('users').find({ email: /seed\.com/ }).toArray();
  const staffUsers = allUsers.filter(u => u.role === 'staff');
  const customerUsers = allUsers.filter(u => u.role === 'customer');
  console.log(`   ${allUsers.length} usuarios OK\n`);

  // ── 2. Restaurants: 100 ─────────────────────────────────────────────────────
  console.log('🍽️  Insertando 100 restaurantes...');
  const restaurantDocs = Array.from({ length: 100 }, (_, i) => {
    const owner = staffUsers[i % staffUsers.length];
    const cats = pick(CUISINES, randInt(1, 3));
    return {
      name: `Restaurant ${i + 1} ${cats[0]}`,
      description: `Authentic ${cats[0]} cuisine. Fast service and great atmosphere.`,
      location: { type: 'Point', coordinates: randCoords() },
      address: { street: `Avenida ${randInt(1,20)} #${randInt(1,100)}`, city: rand(CITIES), zip: `0${randInt(1000,9999)}` },
      categories: cats,
      phone: `+502-${String(randInt(10000000, 99999999))}`,
      hours: { mon:'8-22', tue:'8-22', wed:'8-22', thu:'8-22', fri:'8-23', sat:'9-23', sun:'10-20' },
      images: [],
      owner_id: owner._id,
      rating: { avg: new Double(0.0), count: new Int32(0) },
      createdAt: daysAgo(randInt(30, 730)),
      updatedAt: new Date()
    };
  });
  await insertInBatches(db.collection('restaurants'), restaurantDocs);
  const allRestaurants = await db.collection('restaurants').find({ name: /^Restaurant \d/ }).toArray();
  console.log(`   ${allRestaurants.length} restaurantes OK\n`);

  // ── 3. Menu Items: 500 ──────────────────────────────────────────────────────
  console.log('🍜 Insertando 500 menu items...');
  const menuDocs = [];
  // Al menos 5 items por restaurante garantizados
  for (let i = 0; i < allRestaurants.length; i++) {
    for (let j = 0; j < 5; j++) {
      menuDocs.push(makeMenuItem(allRestaurants[i], menuDocs.length));
    }
  }
  // Rellenar hasta 500
  while (menuDocs.length < 500) {
    menuDocs.push(makeMenuItem(rand(allRestaurants), menuDocs.length));
  }
  function makeMenuItem(restaurant, idx) {
    return {
      restaurant_id: restaurant._id,
      name: `Dish ${idx + 1}`,
      description: `Delicious dish number ${idx + 1} with amazing flavor`,
      price: new Double(randFloat(15, 250)),
      currency: 'GTQ',
      categories: pick(CUISINES, 1),
      tags: pick(TAGS_POOL, randInt(1, 3)),
      ingredients: pick(INGREDIENTS_POOL, randInt(3, 8)),
      available: Math.random() > 0.05,
      images: [],
      createdAt: daysAgo(randInt(0, 300))
    };
  }
  await insertInBatches(db.collection('menu_items'), menuDocs);
  const allMenuItems = await db.collection('menu_items').find({ name: /^Dish \d/ }).toArray();
  // Mapear items por restaurante para mayor eficiencia
  const menuByRestaurant = {};
  for (const item of allMenuItems) {
    const key = item.restaurant_id.toString();
    if (!menuByRestaurant[key]) menuByRestaurant[key] = [];
    menuByRestaurant[key].push(item);
  }
  console.log(`   ${allMenuItems.length} menu items OK\n`);

  // ── 4. Orders: 55,000 ──────────────────────────────────────────────────────
  console.log('📦 Insertando 55,000 órdenes (esto toma ~1-2 min)...');
  const TAX = 0.07;
  const orderDocs = [];

  for (let i = 0; i < 55000; i++) {
    const customer = customerUsers[i % customerUsers.length];
    const restaurant = allRestaurants[i % allRestaurants.length];
    const pool = menuByRestaurant[restaurant._id.toString()] || allMenuItems;
    const items = pick(pool, randInt(1, 4)).map(m => {
      const qty = randInt(1, 4);
      const price = typeof m.price?.toNumber === 'function' ? m.price.toNumber() : Number(m.price);
      const subtotal = parseFloat((price * qty).toFixed(2));
      return {
        menu_item_id: m._id,
        name: m.name,
        quantity: new Int32(qty),
        price: new Double(price),
        subtotal: new Double(subtotal),
        notes: ''
      };
    });
    const subtotal = items.reduce((s, it) => s + (typeof it.subtotal?.toNumber === 'function' ? it.subtotal.toNumber() : Number(it.subtotal)), 0);
    const tax = parseFloat((subtotal * TAX).toFixed(2));
    const total = parseFloat((subtotal + tax).toFixed(2));
    // 40% delivered para que haya suficientes reviews
    const status = i % 10 < 4 ? 'delivered' : rand(STATUSES);
    const createdAt = daysAgo(randInt(0, 60));
    orderDocs.push({
      order_number: `ORD-SEED-${String(i + 1).padStart(6, '0')}`,
      user_id: customer._id,
      restaurant_id: restaurant._id,
      items,
      subtotal: new Double(parseFloat(subtotal.toFixed(2))),
      tax: new Double(tax),
      total: new Double(total),
      status,
      notes: '',
      delivery: { address: customer.address?.street || '', eta: null },
      reviewed: false,
      createdAt,
      updatedAt: createdAt
    });
  }
  await insertInBatches(db.collection('orders'), orderDocs, 1000);
  console.log(`   55,000 órdenes OK\n`);

  // ── 5. Reviews: mínimo 10 por restaurante, total ~5,000 ────────────────────
  console.log('⭐ Insertando reviews...');
  const deliveredOrders = await db.collection('orders')
    .find({ status: 'delivered', order_number: /^ORD-SEED/ })
    .toArray();

  const reviewDocs = [];
  const reviewedPairs = new Set(); // user+restaurant únicos

  for (const order of deliveredOrders) {
    if (reviewDocs.length >= 6000) break;
    const key = `${order.user_id}-${order.restaurant_id}`;
    if (reviewedPairs.has(key)) continue;
    reviewedPairs.add(key);

    const rating = randInt(1, 5);
    const word = rand(REVIEW_WORDS);
    reviewDocs.push({
      user_id: order.user_id,
      restaurant_id: order.restaurant_id,
      order_id: order._id,
      rating,
      title: `Review ${word} - orden ${order.order_number}`,
      comment: `El servicio fue ${word}. La comida estuvo ${rating >= 4 ? 'excelente y rápido' : rating === 3 ? 'aceptable, servicio normal' : 'decepcionante y lento'}. ${rand(REVIEW_WORDS)} experiencia.`,
      images: [],
      helpful_count: randInt(0, 100),
      editedAt: null,
      createdAt: new Date(order.createdAt.getTime() + 3600000)
    });
  }

  await insertInBatches(db.collection('reviews'), reviewDocs);

  // Actualizar rating.avg y rating.count en cada restaurante
  console.log('\n   Calculando ratings de restaurantes...');
  const ratingMap = {};
  for (const r of reviewDocs) {
    const key = r.restaurant_id.toString();
    if (!ratingMap[key]) ratingMap[key] = { sum: 0, count: 0, id: r.restaurant_id };
    ratingMap[key].sum += r.rating;
    ratingMap[key].count += 1;
  }
  const bulkOps = Object.values(ratingMap).map(({ sum, count, id }) => ({
    updateOne: {
      filter: { _id: id },
      update: {
        $set: {
          'rating.avg': new Double(parseFloat((sum / count).toFixed(2))),
          'rating.count': new Int32(count),
          updatedAt: new Date()
        }
      }
    }
  }));
  if (bulkOps.length > 0) await db.collection('restaurants').bulkWrite(bulkOps);
  console.log(`   ${reviewDocs.length} reviews OK, ratings actualizados en ${bulkOps.length} restaurantes\n`);

  // ── Resumen final ────────────────────────────────────────────────────────────
  const counts = {
    users: await db.collection('users').countDocuments({ email: /seed\.com/ }),
    restaurants: await db.collection('restaurants').countDocuments({ name: /^Restaurant \d/ }),
    menu_items: await db.collection('menu_items').countDocuments({ name: /^Dish \d/ }),
    orders: await db.collection('orders').countDocuments({ order_number: /^ORD-SEED/ }),
    reviews: await db.collection('reviews').countDocuments({ title: /ORD-SEED/ })
  };

  const restsWithEnoughReviews = Object.values(ratingMap).filter(r => r.count >= 5).length;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ SEED COMPLETO');
  console.log(`   👤 Users:        ${counts.users}`);
  console.log(`   🍽️  Restaurants:  ${counts.restaurants}`);
  console.log(`   🍜 Menu items:   ${counts.menu_items}`);
  console.log(`   📦 Orders:       ${counts.orders}`);
  console.log(`   ⭐ Reviews:      ${counts.reviews}`);
  console.log(`   📊 Rests con ≥5 reviews (para top-restaurants): ${restsWithEnoughReviews}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await client.close();
}

seed().catch(err => {
  console.error('❌ Seed error:', err);
  client.close();
  process.exit(1);
});