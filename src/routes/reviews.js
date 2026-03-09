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

router.get('/', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const { restaurant_id, user_id, rating, q, skip = 0, limit = 20, sortBy = 'createdAt' } = req.query;
    const query = {};
    if (restaurant_id) {
      if (!ObjectId.isValid(restaurant_id)) return res.status(400).json({ error: 'Invalid restaurant_id' });
      query.restaurant_id = new ObjectId(restaurant_id);
    }
    if (user_id) {
      if (!ObjectId.isValid(user_id)) return res.status(400).json({ error: 'Invalid user_id' });
      query.user_id = new ObjectId(user_id);
    }
    if (rating) {
      const r = parseInt(rating, 10);
      if (r < 1 || r > 5) return res.status(400).json({ error: 'rating filter must be 1-5' });
      query.rating = r;
    }
    if (q) query.$text = { $search: q };
    const sortOptions = {
      helpful_count: { helpful_count: -1, createdAt: -1 },
      rating: { rating: -1, createdAt: -1 },
      createdAt: { createdAt: -1 }
    };
    const sorter = sortOptions[sortBy] || sortOptions.createdAt;
    const reviews = await db.collection('reviews')
      .find(query).sort(sorter)
      .skip(parseInt(skip, 10))
      .limit(Math.min(parseInt(limit, 10), 100))
      .toArray();
    return res.json(reviews);
  } catch (err) {
    console.error('List reviews error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const review = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    return res.json(review);
  } catch (err) {
    console.error('Get review error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  const { client, db } = await connect();
  const session = client.startSession();
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const requester = req.auth;
    const review = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    const isAdmin = requester.role === 'admin';
    const isAuthor = review.user_id.toString() === requester.sub;
    if (!isAdmin && !isAuthor) return res.status(403).json({ error: 'Forbidden' });
    const body = req.body || {};
    const update = {};
    if ('title' in body) update.title = String(body.title);
    if ('comment' in body) update.comment = String(body.comment);
    if ('images' in body) update.images = Array.isArray(body.images) ? body.images : [];
    let newRating = null;
    if ('rating' in body) {
      newRating = Number(body.rating);
      if (newRating < 1 || newRating > 5) return res.status(400).json({ error: 'rating must be 1-5' });
      update.rating = newRating;
    }
    update.editedAt = new Date();
    await session.withTransaction(async () => {
      await db.collection('reviews').updateOne({ _id: new ObjectId(id) }, { $set: update }, { session });
      if (newRating !== null && newRating !== review.rating) {
        const restaurant = await db.collection('restaurants').findOne({ _id: review.restaurant_id }, { session });
        const currentAvg = typeof restaurant.rating?.avg?.toNumber === 'function'
          ? restaurant.rating.avg.toNumber() : Number(restaurant.rating?.avg || 0);
        const currentCount = Number(restaurant.rating?.count || 1);
        const newAvg = parseFloat(((currentAvg * currentCount - review.rating + newRating) / currentCount).toFixed(2));
        await db.collection('restaurants').updateOne(
          { _id: review.restaurant_id },
          { $set: { 'rating.avg': new Double(newAvg), updatedAt: new Date() } },
          { session }
        );
      }
    });
    const updated = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (err) {
    console.error('Update review error', err);
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
    const review = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    const isAdmin = requester.role === 'admin';
    const isAuthor = review.user_id.toString() === requester.sub;
    if (!isAdmin && !isAuthor) return res.status(403).json({ error: 'Forbidden' });
    await session.withTransaction(async () => {
      await db.collection('reviews').deleteOne({ _id: new ObjectId(id) }, { session });
      const restaurant = await db.collection('restaurants').findOne({ _id: review.restaurant_id }, { session });
      const currentCount = Number(restaurant.rating?.count || 1);
      const currentAvg = typeof restaurant.rating?.avg?.toNumber === 'function'
        ? restaurant.rating.avg.toNumber() : Number(restaurant.rating?.avg || 0);
      const newCount = Math.max(0, currentCount - 1);
      const newAvg = newCount === 0 ? 0.0
        : parseFloat(((currentAvg * currentCount - review.rating) / newCount).toFixed(2));
      await db.collection('restaurants').updateOne(
        { _id: review.restaurant_id },
        { $set: { 'rating.avg': new Double(newAvg), 'rating.count': new Int32(newCount), updatedAt: new Date() } },
        { session }
      );
      if (review.order_id) {
        await db.collection('orders').updateOne(
          { _id: review.order_id },
          { $set: { reviewed: false, updatedAt: new Date() } },
          { session }
        );
      }
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete review error', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    await session.endSession();
  }
});

router.post('/:id/helpful', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const requester = req.auth;
    const review = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.user_id.toString() === requester.sub) {
      return res.status(400).json({ error: 'You cannot mark your own review as helpful' });
    }
    await db.collection('reviews').updateOne(
      { _id: new ObjectId(id) },
      { $inc: { helpful_count: 1 } }
    );
    const updated = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (err) {
    console.error('Helpful review error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;