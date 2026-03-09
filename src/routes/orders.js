// src/routes/orders.js
const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId } = require('mongodb');
const { requireAuth } = require('../middleware/auth');

function generateOrderNumber() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${date}-${rand}`;
}

const VALID_STATUSES = ['pending', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
const TAX_RATE = 0.07;

router.post('/', requireAuth, async (req, res) => {
  const { client, db } = await connect();
  const session = client.startSession();
  try {
    const requester = req.auth;
    if (!requester) return res.status(401).json({ error: 'Not authenticated' });
    if (requester.role !== 'customer' && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Only customers can place orders' });
    }
    const body = req.body || {};
    const { restaurant_id, items, delivery } = body;
    const notes = body.notes || '';
    if (!restaurant_id || !ObjectId.isValid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id is required and must be valid' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }
    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(restaurant_id) });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const resolvedItems = [];
    for (const it of items) {
      if (!it.menu_item_id || !ObjectId.isValid(it.menu_item_id)) {
        return res.status(400).json({ error: `Invalid menu_item_id: ${it.menu_item_id}` });
      }
      const qty = parseInt(it.quantity, 10);
      if (!qty || qty < 1) {
        return res.status(400).json({ error: `quantity must be >= 1 for item ${it.menu_item_id}` });
      }
      const menuItem = await db.collection('menu_items').findOne({ _id: new ObjectId(it.menu_item_id) });
      if (!menuItem) return res.status(404).json({ error: `Menu item not found: ${it.menu_item_id}` });
      if (!menuItem.available) return res.status(400).json({ error: `Menu item not available: ${menuItem.name}` });
      const itemPrice = typeof menuItem.price?.toNumber === 'function'
        ? menuItem.price.toNumber() : Number(menuItem.price || 0);
      resolvedItems.push({
        menu_item_id: new ObjectId(it.menu_item_id),
        name: menuItem.name,
        quantity: qty,
        price: itemPrice,
        subtotal: itemPrice * qty,
        notes: it.notes || ''
      });
    }
    const subtotal = resolvedItems.reduce((acc, i) => acc + i.subtotal, 0);
    const tax = parseFloat((subtotal * TAX_RATE).toFixed(2));
    const total = parseFloat((subtotal + tax).toFixed(2));
    const doc = {
      order_number: generateOrderNumber(),
      user_id: new ObjectId(requester.sub),
      restaurant_id: new ObjectId(restaurant_id),
      items: resolvedItems,
      subtotal, tax, total,
      status: 'pending',
      notes,
      delivery: delivery ? { address: delivery.address || '', eta: delivery.eta ? new Date(delivery.eta) : null } : null,
      reviewed: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    let insertedId;
    await session.withTransaction(async () => {
      const r = await db.collection('orders').insertOne(doc, { session });
      insertedId = r.insertedId;
    });
    const order = await db.collection('orders').findOne({ _id: insertedId });
    return res.status(201).json(order);
  } catch (err) {
    console.error('Create order error', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

module.exports = router;