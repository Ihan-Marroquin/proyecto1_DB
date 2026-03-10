const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId } = require('mongodb');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const VALID_STATUSES = ['pending', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];

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

router.get('/admin-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { db } = await connect();
    const [users, restaurants, orders] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('restaurants').countDocuments(),
      db.collection('orders').countDocuments()
    ]);
    return res.json({ users, restaurants, orders });
  } catch (err) {
    console.error('Admin stats error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/restaurant-orders-summary', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const requester = req.auth;
    let restaurantId = req.query.restaurant_id;
    if (requester.role === 'staff') {
      const myRestaurant = await db.collection('restaurants').findOne({ owner_id: new ObjectId(requester.sub) });
      if (!myRestaurant) return res.json({ byStatus: {}, byDay: [] });
      restaurantId = myRestaurant._id.toString();
    } else if (requester.role !== 'admin' || !restaurantId || !ObjectId.isValid(restaurantId)) {
      return res.status(400).json({ error: 'restaurant_id required for admin' });
    }
    const matchRestaurant = { restaurant_id: new ObjectId(restaurantId) };
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);

    const byStatusPipeline = [
      { $match: matchRestaurant },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ];
    const byDayPipeline = [
      { $match: matchRestaurant },
      {
        $addFields: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': -1 } },
      { $limit: days * 5 }
    ];

    const [byStatusResult, byDayResult] = await Promise.all([
      db.collection('orders').aggregate(byStatusPipeline).toArray(),
      db.collection('orders').aggregate(byDayPipeline).toArray()
    ]);

    const byStatus = {};
    VALID_STATUSES.forEach(s => { byStatus[s] = 0; });
    byStatusResult.forEach((r) => { byStatus[r._id] = r.count; });

    const dayMap = {};
    byDayResult.forEach((r) => {
      const d = r._id.date;
      const st = r._id.status;
      if (!dayMap[d]) {
        dayMap[d] = { date: d, total: 0, byStatus: {} };
        VALID_STATUSES.forEach(s => { dayMap[d].byStatus[s] = 0; });
      }
      dayMap[d].total += r.count;
      dayMap[d].byStatus[st] = (dayMap[d].byStatus[st] || 0) + r.count;
    });
    const byDay = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ byStatus, byDay });
  } catch (err) {
    console.error('Restaurant orders summary error', err);
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
      result = await db.command({
        aggregate: 'orders',
        pipeline,
        cursor: {},
        explain: true
      });
    } else if (queryName === 'top_dishes') {
      const pipeline = [
        { $match: { status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.menu_item_id', totalQuantity: { $sum: '$items.quantity' } } },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 }
      ];
      result = await db.command({
        aggregate: 'orders',
        pipeline,
        cursor: {},
        explain: true
      });
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
