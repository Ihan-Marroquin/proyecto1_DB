const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId } = require('mongodb');
const { requireAuth, requireAdmin } = require('../middleware/auth');

function normalizeRestaurant(doc) {
  if (!doc) return null;
  const d = { ...doc };
  if (d._id) d._id = d._id.toString();
  if (d.owner_id) d.owner_id = d.owner_id.toString();
  if (d.rating) {
    d.rating = {
      avg: typeof d.rating.avg === 'number' ? d.rating.avg : (d.rating.avg && typeof d.rating.avg.toNumber === 'function' ? d.rating.avg.toNumber() : 0),
      count: typeof d.rating.count === 'number' ? d.rating.count : (d.rating.count != null ? Number(d.rating.count) : 0)
    };
  }
  return d;
}

router.get('/top-restaurants', async (req, res) => {
  try {
    const { db } = await connect();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const pipeline = [
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$restaurant_id', orderCount: { $sum: 1 } } },
      { $sort: { orderCount: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'restaurants',
          localField: '_id',
          foreignField: '_id',
          as: 'restaurant'
        }
      },
      { $unwind: { path: '$restaurant', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          _id: '$restaurant._id',
          name: '$restaurant.name',
          description: '$restaurant.description',
          location: '$restaurant.location',
          address: '$restaurant.address',
          categories: '$restaurant.categories',
          phone: '$restaurant.phone',
          hours: '$restaurant.hours',
          images: '$restaurant.images',
          rating: '$restaurant.rating',
          createdAt: '$restaurant.createdAt',
          updatedAt: '$restaurant.updatedAt',
          orderCount: 1
        }
      }
    ];
    const result = await db.collection('orders').aggregate(pipeline).toArray();
    const list = result.map((r) => ({
      ...normalizeRestaurant(r),
      orderCount: r.orderCount
    }));
    return res.json(list);
  } catch (err) {
    console.error('Top restaurants report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/top-dishes', async (req, res) => {
  try {
    const { db } = await connect();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const pipeline = [
      { $match: { status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.menu_item_id',
          totalQuantity: { $sum: '$items.quantity' },
          name: { $first: '$items.name' }
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'menu_items',
          localField: '_id',
          foreignField: '_id',
          as: 'menuItem'
        }
      },
      { $unwind: { path: '$menuItem', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          menu_item_id: '$_id',
          name: { $ifNull: ['$menuItem.name', '$name'] },
          totalQuantity: 1,
          price: '$menuItem.price',
          restaurant_id: '$menuItem.restaurant_id'
        }
      }
    ];
    const result = await db.collection('orders').aggregate(pipeline).toArray();
    const list = result.map((r) => ({
      menu_item_id: r.menu_item_id && r.menu_item_id.toString ? r.menu_item_id.toString() : String(r.menu_item_id),
      name: r.name,
      totalQuantity: r.totalQuantity,
      price: r.price != null && typeof r.price?.toNumber === 'function' ? r.price.toNumber() : Number(r.price || 0),
      restaurant_id: r.restaurant_id && r.restaurant_id.toString ? r.restaurant_id.toString() : (r.restaurant_id || null)
    }));
    return res.json(list);
  } catch (err) {
    console.error('Top dishes report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/explain', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { db } = await connect();
    const { query: queryName } = req.query;
    const allowed = ['top_restaurants', 'top_dishes', 'restaurants_list', 'orders_list'];
    if (!queryName || !allowed.includes(queryName)) {
      return res.status(400).json({
        error: 'query param required',
        allowed: allowed.join(', ')
      });
    }

    let result;
    if (queryName === 'top_restaurants') {
      const pipeline = [
        { $match: { status: { $ne: 'cancelled' } } },
        { $group: { _id: '$restaurant_id', orderCount: { $sum: 1 } } },
        { $sort: { orderCount: -1 } },
        { $limit: 10 }
      ];
      result = await db.collection('orders').aggregate(pipeline).explain('executionStats');
    } else if (queryName === 'top_dishes') {
      const pipeline = [
        { $match: { status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.menu_item_id', totalQuantity: { $sum: '$items.quantity' } } },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 }
      ];
      result = await db.collection('orders').aggregate(pipeline).explain('executionStats');
    } else if (queryName === 'restaurants_list') {
      const cursor = db.collection('restaurants').find({}).sort({ 'rating.avg': -1 }).limit(20);
      result = await cursor.explain('executionStats');
    } else if (queryName === 'orders_list') {
      const cursor = db.collection('orders').find({}).sort({ createdAt: -1 }).limit(20);
      result = await cursor.explain('executionStats');
    }

    return res.json({
      query: queryName,
      explain: result,
    });
  } catch (err) {
    console.error('Explain endpoint error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
