const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId, Double, Int32 } = require('mongodb');
const { requireAuth } = require('../middleware/auth');
const { requireIndex } = require('../lib/requireIndex');

function toDouble(value) {
  const n = Number(value ?? 0);
  return new Double(Number.isFinite(n) ? n : 0.0);
}

function generateOrderNumber() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${date}-${rand}`;
}

const VALID_STATUSES = ['pending', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
const TAX_RATE = 0.07;

function orderToJson(order) {
  if (!order) return null;
  const toNum = (v) => (v != null && typeof v.toNumber === 'function' ? v.toNumber() : Number(v || 0));
  const toStr = (v) => (v != null ? v.toString() : null);
  const items = (order.items || []).map((it) => ({
    menu_item_id: toStr(it.menu_item_id),
    name: it.name,
    quantity: typeof it.quantity === 'number' ? it.quantity : (it.quantity != null && typeof it.quantity.valueOf === 'function' ? it.quantity.valueOf() : parseInt(it.quantity, 10) || 0),
    price: toNum(it.price),
    subtotal: toNum(it.subtotal),
    notes: it.notes || ''
  }));
  return {
    _id: toStr(order._id),
    order_number: order.order_number,
    user_id: toStr(order.user_id),
    restaurant_id: toStr(order.restaurant_id),
    items,
    subtotal: toNum(order.subtotal),
    tax: toNum(order.tax),
    total: toNum(order.total),
    status: order.status,
    notes: order.notes || '',
    delivery: order.delivery || { address: '', eta: null },
    reviewed: !!order.reviewed,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

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
      const itemSubtotal = itemPrice * qty;
      resolvedItems.push({
        menu_item_id: new ObjectId(it.menu_item_id),
        name: String(menuItem.name),
        quantity: new Int32(qty),
        price: toDouble(itemPrice),
        subtotal: toDouble(itemSubtotal),
        notes: String(it.notes || '')
      });
    }
    const subtotalNum = resolvedItems.reduce((acc, i) => acc + (typeof i.subtotal?.toNumber === 'function' ? i.subtotal.toNumber() : Number(i.subtotal || 0)), 0);
    const taxNum = parseFloat((subtotalNum * TAX_RATE).toFixed(2));
    const totalNum = parseFloat((subtotalNum + taxNum).toFixed(2));

    const doc = {
        order_number: generateOrderNumber(),
        user_id: new ObjectId(requester.sub),
        restaurant_id: new ObjectId(restaurant_id),
        items: resolvedItems,
        subtotal: toDouble(subtotalNum),
        tax: toDouble(taxNum),
        total: toDouble(totalNum),
        status: 'pending',
        notes,
        delivery: delivery
            ? { address: delivery.address || '', eta: delivery.eta ? new Date(delivery.eta) : null }
            : { address: '', eta: null },
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
    return res.status(201).json(orderToJson(order));
  } catch (err) {
    console.error('Create order error', err);
    if (err.code === 121) return res.status(400).json({ error: 'Validation failed', details: err.errInfo?.details });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const requester = req.auth;
    const { restaurant_id, status, date, skip = 0, limit = 20, sortBy = 'createdAt' } = req.query;
    const query = {};
    if (requester.role === 'customer') {
      query.user_id = new ObjectId(requester.sub);
    } else if (requester.role === 'staff') {
      const myRestaurant = await db.collection('restaurants').findOne({ owner_id: new ObjectId(requester.sub) });
      if (!myRestaurant) return res.json([]);
      query.restaurant_id = myRestaurant._id;
    }
    if (restaurant_id && requester.role === 'admin') {
      if (!ObjectId.isValid(restaurant_id)) return res.status(400).json({ error: 'Invalid restaurant_id' });
      query.restaurant_id = new ObjectId(restaurant_id);
    }
    if (status) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status` });
      query.status = status;
    }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const start = new Date(date + 'T00:00:00.000Z');
      const end = new Date(date + 'T23:59:59.999Z');
      query.createdAt = { $gte: start, $lte: end };
    }
    const sorter = sortBy === 'total' ? { total: -1 } : { createdAt: -1 };
    const coll = db.collection('orders');
    const skipNum = parseInt(skip, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    await requireIndex(coll, query, { sort: sorter, skip: skipNum, limit: limitNum });
    const orders = await coll
      .find(query).sort(sorter)
      .skip(skipNum)
      .limit(limitNum)
      .toArray();
    return res.json(orders.map(orderToJson));
  } catch (err) {
    if (err.code === 'NO_INDEX') {
      return res.status(503).json({ error: err.message, code: 'NO_INDEX' });
    }
    console.error('List orders error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const requester = req.auth;
    const order = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (requester.role === 'customer' && order.user_id.toString() !== requester.sub) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (requester.role === 'staff') {
      const myRestaurant = await db.collection('restaurants').findOne({ owner_id: new ObjectId(requester.sub) });
      if (!myRestaurant || myRestaurant._id.toString() !== order.restaurant_id.toString()) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    return res.json(orderToJson(order));
  } catch (err) {
    console.error('Get order error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/status', requireAuth, async (req, res) => {
  const { client, db } = await connect();
  const session = client.startSession();
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const requester = req.auth;
    if (requester.role === 'customer') return res.status(403).json({ error: 'Customers cannot update order status' });
    const { status } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const order = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'delivered' || order.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot change status of a ${order.status} order` });
    }
    if (requester.role === 'staff') {
      const myRestaurant = await db.collection('restaurants').findOne({ owner_id: new ObjectId(requester.sub) });
      if (!myRestaurant || myRestaurant._id.toString() !== order.restaurant_id.toString()) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    const updateFields = { status, updatedAt: new Date() };
    if (status === 'delivered') updateFields.deliveredAt = new Date();
    await session.withTransaction(async () => {
      await db.collection('orders').updateOne(
        { _id: new ObjectId(id) },
        { $set: updateFields },
        { session }
      );
    });
    const updated = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    return res.json(orderToJson(updated));
  } catch (err) {
    console.error('Update order status error', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { client, db } = await connect();
  const session = client.startSession();
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const requester = req.auth;
    const order = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const isAdmin = requester.role === 'admin';
    const isOwnerCustomer = requester.role === 'customer' && order.user_id.toString() === requester.sub;
    let isStaffOfRestaurant = false;
    if (requester.role === 'staff') {
      const myRestaurant = await db.collection('restaurants').findOne({ owner_id: new ObjectId(requester.sub) });
      isStaffOfRestaurant = myRestaurant && myRestaurant._id.toString() === order.restaurant_id.toString();
    }
    if (!isAdmin && !isOwnerCustomer && !isStaffOfRestaurant) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['pending', 'preparing'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel an order with status '${order.status}'` });
    }
    await session.withTransaction(async () => {
      await db.collection('orders').updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() } },
        { session }
      );
    });
    const cancelled = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    return res.json(orderToJson(cancelled));
  } catch (err) {
    console.error('Cancel order error', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

module.exports = router;