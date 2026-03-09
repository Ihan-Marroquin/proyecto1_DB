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
  }
  return { client, db };
}

module.exports = { connect, client };