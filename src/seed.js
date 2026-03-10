require('dotenv').config();
const { MongoClient, ObjectId, Double, Int32 } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('Define MONGO_URI in .env');
const client = new MongoClient(uri);

const CUISINES = ['mexican','italian','japanese','chinese','american','french','indian','thai','mediterranean','peruvian'];
const CITIES = ['Guatemala City','Mixco','Villa Nueva','Petapa','Amatitlan','Escuintla','Quetzaltenango','Antigua','Cobán','Huehuetenango'];
const STATUSES = ['pending','preparing','out_for_delivery','delivered','cancelled','paid'];
const INGREDIENTS_POOL = ['chicken','beef','pork','fish','shrimp','onion','tomato','cheese','lettuce','rice','beans','pepper','garlic','oil','salt','lemon','avocado','corn','mushroom','spinach','carrot','potato','egg','cream','butter'];
const TAGS_POOL = ['spicy','popular','vegan','vegetarian','gluten-free','new','recommended','fast','seasonal','chef-special'];
const REVIEW_WORDS = ['rápido','servicio','excelente','malo','lento','delicioso','increíble','recomendado','pésimo','bueno','regular','fantástico','terrible','fresco','caliente'];
const DISH_PREFIXES = ['Grilled','Fried','Baked','Steamed','Roasted','Spicy','Crispy','Classic','Special','House','Chef','Fresh','Traditional','Signature','Premium'];
const DISH_MAINS = ['Chicken','Beef','Pork','Fish','Shrimp','Pasta','Rice','Burger','Tacos','Pizza','Soup','Salad','Wrap','Steak','Bowl'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return parseFloat((Math.random() * (max - min) + min).toFixed(2)); }
function pick(arr, n) { const s = [...arr].sort(() => 0.5 - Math.random()); return s.slice(0, Math.min(n, s.length)); }
function randCoords() { return [parseFloat((-90.6 + Math.random() * 0.4).toFixed(6)), parseFloat((14.5 + Math.random() * 0.3).toFixed(6))]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

async function insertInBatches(collection, docs, batchSize = 1000) {
  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    try {
      const r = await collection.insertMany(docs.slice(i, i + batchSize), { ordered: false });
      inserted += r.insertedCount;
    } catch (e) {
      if (e.code === 121 || e.name === 'MongoBulkWriteError') {
        inserted += e.result?.insertedCount || 0;
        failed   += (docs.slice(i, i + batchSize).length) - (e.result?.insertedCount || 0);
      } else {
        throw e;
      }
    }
    process.stdout.write(`\r    OK: ${inserted}  Rechazados: ${failed}  Total procesado: ${i + Math.min(batchSize, docs.length - i)}/${docs.length}`);
  }
  console.log('');
  if (failed > 0) console.log(`   ⚠️  ${failed} documentos rechazados por validación de esquema en Atlas`);
  return inserted;
}

async function seed() {
  await client.connect();
  const db = client.db();
  console.log('✅ Connected to MongoDB\n');

  // ── Limpiar seed anterior ────────────────────────────────────────────────────
  console.log('🧹 Limpiando datos de seed anteriores...');
  await Promise.all([
    db.collection('users').deleteMany({ email: /seed\.com/ }),
    db.collection('restaurants').deleteMany({ name: /^Restaurant \d/ }),
    db.collection('menu_items').deleteMany({ name: /^(Grilled|Fried|Baked|Steamed|Roasted|Spicy|Crispy|Classic|Special|House|Chef|Fresh|Traditional|Signature|Premium)/ }),
    db.collection('orders').deleteMany({ order_number: /^ORD-SEED/ }),
    db.collection('reviews').deleteMany({ title: /ORD-SEED/ }),
    db.collection('payments').deleteMany({ order_id: { $exists: true }, createdAt: { $exists: true } })
  ]);
  console.log('   Listo\n');

  // ── 1. Users: 5,000 (1,000 staff + 4,000 customers) ─────────────────────────
  console.log(' Insertando 5,000 usuarios...');
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const userDocs = Array.from({ length: 5000 }, (_, i) => ({
    name: `User Seed ${i + 1}`,
    email: `user${i + 1}@seed.com`,
    password_hash: passwordHash,
    role: i < 1000 ? 'staff' : 'customer',
    phone: `+502-${String(randInt(10000000, 99999999))}`,
    address: {
      street: `Calle ${randInt(1, 30)} #${randInt(1, 100)}`,
      city: rand(CITIES),
      zip: `0${randInt(1000, 9999)}`
    },
    preferences: { favorite_cuisines: pick(CUISINES, randInt(1, 3)) },
    createdAt: daysAgo(randInt(0, 730))
  }));
  await insertInBatches(db.collection('users'), userDocs, 1000);
  const allUsers      = await db.collection('users').find({ email: /seed\.com/ }).toArray();
  const staffUsers    = allUsers.filter(u => u.role === 'staff');
  const customerUsers = allUsers.filter(u => u.role === 'customer');
  console.log(`   ${allUsers.length} usuarios OK\n`);

  // ── 2. Restaurants: 500 ──────────────────────────────────────────────────────
  console.log('  Insertando 500 restaurantes...');
  const restaurantDocs = Array.from({ length: 500 }, (_, i) => {
    const owner = staffUsers[i % staffUsers.length];
    const cats  = pick(CUISINES, randInt(1, 3));
    return {
      name: `Restaurant ${i + 1} ${cats[0]}`,
      description: `Authentic ${cats[0]} cuisine. Fast service and great atmosphere in ${rand(CITIES)}.`,
      location: { type: 'Point', coordinates: randCoords() },
      address: {
        street: `Avenida ${randInt(1, 30)} #${randInt(1, 200)}`,
        city: rand(CITIES),
        zip: `0${randInt(1000, 9999)}`
      },
      categories: cats,
      phone: `+502-${String(randInt(10000000, 99999999))}`,
      hours: { mon:'8-22', tue:'8-22', wed:'8-22', thu:'8-22', fri:'8-23', sat:'9-23', sun:'10-20' },
      images: [],
      owner_id: owner._id,
      rating: { avg: new Double(0.0), count: new Int32(0) },
      createdAt: daysAgo(randInt(30, 1000)),
      updatedAt: new Date()
    };
  });
  await insertInBatches(db.collection('restaurants'), restaurantDocs, 500);
  const allRestaurants = await db.collection('restaurants').find({ name: /^Restaurant \d/ }).toArray();
  console.log(`   ${allRestaurants.length} restaurantes OK\n`);

  // ── 3. Menu Items: 5,000 (10 por restaurante garantizados) ───────────────────
  console.log(' Insertando 5,000 menu items...');
  const menuDocs = [];

  function makeMenuItem(restaurant, idx) {
    const dishName = `${rand(DISH_PREFIXES)} ${rand(DISH_MAINS)} #${idx + 1}`;
    return {
      restaurant_id: restaurant._id,
      name: dishName,
      description: `${dishName} — prepared fresh daily with the finest ingredients`,
      price: new Double(randFloat(15, 300)),
      currency: 'GTQ',
      categories: pick(CUISINES, 1),
      tags: pick(TAGS_POOL, randInt(1, 4)),
      ingredients: pick(INGREDIENTS_POOL, randInt(3, 10)),
      available: Math.random() > 0.05,
      images: [],
      createdAt: daysAgo(randInt(0, 400))
    };
  }

  // 10 items garantizados por cada restaurante
  for (const restaurant of allRestaurants) {
    for (let j = 0; j < 10; j++) {
      menuDocs.push(makeMenuItem(restaurant, menuDocs.length));
    }
  }
  // Rellenar hasta 5,000
  while (menuDocs.length < 5000) {
    menuDocs.push(makeMenuItem(rand(allRestaurants), menuDocs.length));
  }

  await insertInBatches(db.collection('menu_items'), menuDocs, 1000);
  const allMenuItems = await db.collection('menu_items')
    .find({ name: { $regex: /^(Grilled|Fried|Baked|Steamed|Roasted|Spicy|Crispy|Classic|Special|House|Chef|Fresh|Traditional|Signature|Premium)/ } })
    .toArray();

  // Índice rápido por restaurante en memoria
  const menuByRestaurant = {};
  for (const item of allMenuItems) {
    const key = item.restaurant_id.toString();
    if (!menuByRestaurant[key]) menuByRestaurant[key] = [];
    menuByRestaurant[key].push(item);
  }
  console.log(`   ${allMenuItems.length} menu items OK\n`);

  // ── 4. Orders: 65,000 ────────────────────────────────────────────────────────
  console.log(' Insertando 65,000 órdenes (puede tomar 2-3 min)...');
  const TAX = 0.07;
  const orderDocs = [];

  for (let i = 0; i < 65000; i++) {
    const customer   = customerUsers[i % customerUsers.length];
    const restaurant = allRestaurants[i % allRestaurants.length];
    const pool       = menuByRestaurant[restaurant._id.toString()] || allMenuItems.slice(0, 10);

    const items = pick(pool, randInt(1, 5)).map(m => {
      const qty   = randInt(1, 5);
        const price = typeof m.price?.toNumber === 'function' ? m.price.toNumber() : Number(m.price);
        return {
          menu_item_id: m._id,
          name: String(m.name),
          quantity: qty,                                        // número plano, no Int32
          price: parseFloat(price.toFixed(2)),                  // número plano, no Double
          subtotal: parseFloat((price * qty).toFixed(2)),
          notes: ''
        };
    });

    const subtotalNum = parseFloat(items.reduce((s, it) => s + (typeof it.subtotal?.toNumber === 'function' ? it.subtotal.toNumber() : Number(it.subtotal)), 0).toFixed(2));
    const taxNum      = parseFloat((subtotalNum * TAX).toFixed(2));
    const totalNum    = parseFloat((subtotalNum + taxNum).toFixed(2));

    // 45% delivered para que haya suficientes reviews
    const status    = i % 20 < 9 ? 'delivered' : rand(STATUSES);
    const createdAt = daysAgo(randInt(0, 90));

    orderDocs.push({
      order_number: `ORD-SEED-${String(i + 1).padStart(6, '0')}`,
      user_id: customer._id,
      restaurant_id: restaurant._id,
      items,
      subtotal: subtotalNum,
      tax: taxNum,
      total: totalNum,
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

  // ── 5. Reviews: hasta 20,000 ─────────────────────────────────────────────────
  console.log(' Insertando reviews (hasta 20,000)...');
  const deliveredOrders = await db.collection('orders')
    .find({ status: 'delivered', order_number: /^ORD-SEED/ })
    .toArray();

  const reviewDocs    = [];
  const reviewedPairs = new Set();

  for (const order of deliveredOrders) {
    if (reviewDocs.length >= 20000) break;
    const key = `${order.user_id}-${order.restaurant_id}`;
    if (reviewedPairs.has(key)) continue;
    reviewedPairs.add(key);

    const rating = randInt(1, 5);
    const word1  = rand(REVIEW_WORDS);
    const word2  = rand(REVIEW_WORDS);
    reviewDocs.push({
      user_id: order.user_id,
      restaurant_id: order.restaurant_id,
      order_id: order._id,
      rating,
      title: `Review ${word1} - orden ${order.order_number}`,
      comment: `El servicio fue ${word1} y ${word2}. La comida estuvo ${rating >= 4 ? 'excelente, rápido y delicioso' : rating === 3 ? 'aceptable, servicio normal y fresco' : 'decepcionante, lento y malo'}. ${rand(REVIEW_WORDS)} experiencia en general.`,
      images: [],
      helpful_count: randInt(0, 200),
      editedAt: null,
      createdAt: new Date(order.createdAt.getTime() + randInt(1, 48) * 3600000)
    });
  }

  await insertInBatches(db.collection('reviews'), reviewDocs, 1000);

  // Actualizar rating.avg y rating.count por restaurante
  console.log('\n   Recalculando ratings...');
  const ratingMap = {};
  for (const r of reviewDocs) {
    const key = r.restaurant_id.toString();
    if (!ratingMap[key]) ratingMap[key] = { sum: 0, count: 0, id: r.restaurant_id };
    ratingMap[key].sum   += r.rating;
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
  if (bulkOps.length) await db.collection('restaurants').bulkWrite(bulkOps);
  console.log(`   ${reviewDocs.length} reviews OK, ratings actualizados en ${bulkOps.length} restaurantes\n`);

  // ── 6. Payments (para órdenes paid) ─────────────────────────────────────────
  console.log(' Insertando payments para órdenes paid...');
  const paidOrders = await db.collection('orders')
    .find({ status: 'paid', order_number: /^ORD-SEED/ })
    .limit(15000)
    .toArray();
  console.log(`   Órdenes paid encontradas en DB: ${paidOrders.length}`);

  const paymentMethods = ['card','cash','transfer','digital_wallet'];
  const paymentDocs = paidOrders.map(order => ({
    order_id: order._id,
    user_id: order.user_id,
    amount: order.total,
    payment_method: rand(paymentMethods),
    reference: `REF-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    status: 'confirmed',
    createdAt: new Date(order.createdAt.getTime() + randInt(1, 30) * 60000)
  }));

  // ── 7. Categories ────────────────────────────────────────────────────────────
  console.log('  Insertando categories...');
  const categoryDocs = CUISINES.map(c => ({
    name: c.charAt(0).toUpperCase() + c.slice(1),
    description: `${c.charAt(0).toUpperCase() + c.slice(1)} cuisine category`,
    id: c,
    createdAt: new Date()
  }));
  try {
    await db.collection('categories').insertMany(categoryDocs, { ordered: false });
    console.log(`   ${categoryDocs.length} categories OK\n`);
  } catch(e) {
    // pueden ya existir algunas
    console.log(`   Categories: algunas ya existían, OK\n`);
  }

  if (paymentDocs.length) await insertInBatches(db.collection('payments'), paymentDocs, 1000);
  console.log(`   ${paymentDocs.length} payments OK\n`);

  // ── Resumen ───────────────────────────────────────────────────────────────────
  const restsWithEnoughReviews = Object.values(ratingMap).filter(r => r.count >= 5).length;
  const counts = {
    users:       await db.collection('users').countDocuments({ email: /seed\.com/ }),
    restaurants: await db.collection('restaurants').countDocuments({ name: /^Restaurant \d/ }),
    menu_items:  await db.collection('menu_items').countDocuments({ name: /^(Grilled|Fried|Baked|Steamed|Roasted|Spicy|Crispy|Classic|Special|House|Chef|Fresh|Traditional|Signature|Premium)/ }),
    orders:      await db.collection('orders').countDocuments({ order_number: /^ORD-SEED/ }),
    reviews:     await db.collection('reviews').countDocuments({ title: /ORD-SEED/ }),
    payments:    await db.collection('payments').countDocuments({ reference: /^REF-/ })
  };

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SEED COMPLETO');
  console.log(`     Users:                    ${counts.users.toLocaleString()}`);
  console.log(`      Restaurants:              ${counts.restaurants.toLocaleString()}`);
  console.log(`     Menu items:               ${counts.menu_items.toLocaleString()}`);
  console.log(`     Orders:                   ${counts.orders.toLocaleString()}`);
  console.log(`     Reviews:                  ${counts.reviews.toLocaleString()}`);
  console.log(`     Payments:                 ${counts.payments.toLocaleString()}`);
  console.log(`     Rests con ≥5 reviews:     ${restsWithEnoughReviews}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await client.close();
}

seed().catch(err => {
  console.error('❌ Seed error:', err);
  client.close();
  process.exit(1);
});