// src/routes/reviews.js
const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId, Double, Int32 } = require('mongodb');
const { requireAuth } = require('../middleware/auth');

router.post('/', requireAuth, async (req, res) => {
  const { client, db } = await connect();
  const session = client.startSession();
  try {
    const requester = req.auth;
    if (!requester) return res.status(401).json({ error: 'Not authenticated' });
    if (requester.role !== 'customer' && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Only customers can write reviews' });
    }
    const body = req.body || {};
    const { restaurant_id, order_id, rating, title, comment, images } = body;
    if (!restaurant_id || !ObjectId.isValid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id is required and must be valid' });
    }
    const ratingNum = Number(rating);
    if (!rating || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'rating is required and must be between 1 and 5' });
    }
    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(restaurant_id) });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const existing = await db.collection('reviews').findOne({
      user_id: new ObjectId(requester.sub),
      restaurant_id: new ObjectId(restaurant_id)
    });
    if (existing) return res.status(409).json({ error: 'You have already reviewed this restaurant' });
    let orderObjectId = null;
    if (order_id) {
      if (!ObjectId.isValid(order_id)) return res.status(400).json({ error: 'Invalid order_id' });
      const order = await db.collection('orders').findOne({ _id: new ObjectId(order_id) });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.user_id.toString() !== requester.sub) return res.status(403).json({ error: 'That order does not belong to you' });
      if (order.status !== 'delivered') return res.status(400).json({ error: 'Can only review a delivered order' });
      if (order.reviewed) return res.status(409).json({ error: 'This order has already been reviewed' });
      orderObjectId = new ObjectId(order_id);
    }
    const doc = {
      user_id: new ObjectId(requester.sub),
      restaurant_id: new ObjectId(restaurant_id),
      order_id: orderObjectId,
      rating: ratingNum,
      title: title ? String(title) : '',
      comment: comment ? String(comment) : '',
      images: Array.isArray(images) ? images : [],
      helpful_count: 0,
      editedAt: null,
      createdAt: new Date()
    };
    let insertedId;
    await session.withTransaction(async () => {
      const r = await db.collection('reviews').insertOne(doc, { session });
      insertedId = r.insertedId;
      const currentAvg = typeof restaurant.rating?.avg?.toNumber === 'function'
        ? restaurant.rating.avg.toNumber() : Number(restaurant.rating?.avg || 0);
      const currentCount = Number(restaurant.rating?.count || 0);
      const newCount = currentCount + 1;
      const newAvg = parseFloat(((currentAvg * currentCount + ratingNum) / newCount).toFixed(2));
      await db.collection('restaurants').updateOne(
        { _id: new ObjectId(restaurant_id) },
        { $set: { 'rating.avg': new Double(newAvg), 'rating.count': new Int32(newCount), updatedAt: new Date() } },
        { session }
      );
      if (orderObjectId) {
        await db.collection('orders').updateOne(
          { _id: orderObjectId },
          { $set: { reviewed: true, updatedAt: new Date() } },
          { session }
        );
      }
    });
    const review = await db.collection('reviews').findOne({ _id: insertedId });
    return res.status(201).json(review);
  } catch (err) {
    console.error('Create review error', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

module.exports = router;