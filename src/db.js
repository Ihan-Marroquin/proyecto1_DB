const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI;
if (!uri) throw new Error("Define MONGO_URI in .env");

const client = new MongoClient(uri, { useUnifiedTopology: true });

let db = null;

async function connect() {
  if (!db) {
    await client.connect();
    db = client.db();
    console.log("Connected to MongoDB");
    await ensureIndexes(db);
  }
  return { client, db };
}

async function ensureIndexes(database) {
  try {
    await database.collection('restaurants').createIndex({ owner_id: 1 });
    await database.collection('restaurants').createIndex({ 'rating.avg': -1 });
    await database.collection('restaurants').createIndex({ categories: 1 });
    await database.collection('restaurants').createIndex({ location: '2dsphere' });
    await database.collection('orders').createIndex({ restaurant_id: 1 });
    await database.collection('orders').createIndex({ user_id: 1 });
    await database.collection('orders').createIndex({ status: 1 });
    await database.collection('orders').createIndex({ createdAt: -1 });
    await database.collection('reviews').createIndex({ restaurant_id: 1 });
    await database.collection('reviews').createIndex({ user_id: 1 });
    await database.collection('users').createIndex({ email: 1 }, { unique: true });
    await database.collection('menu_items').createIndex({ restaurant_id: 1 });
    await database.collection('categories').createIndex({ name: 1 });
    console.log("Indexes ensured");
  } catch (e) {
    console.warn("ensureIndexes warning:", e.message);
  }
}

module.exports = { connect, client };