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
      avg: typeof d.rating.avg === 'number' ? d.rating.avg
        : (d.rating.avg && typeof d.rating.avg.toNumber === 'function' ? d.rating.avg.toNumber() : 0),
      count: typeof d.rating.count === 'number' ? d.rating.count
        : (d.rating.count != null ? Number(d.rating.count) : 0)
    };
  }
  return d;
}

// ── 1. Top restaurantes por RATING PROMEDIO (mín. 5 reseñas) ──────────────────
router.get('/top-restaurants', async (req, res) => {
  try {
    const { db } = await connect();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const pipeline = [
      { $match: { rating: { $exists: true } } },
      {
        $group: {
          _id: '$restaurant_id',
          avgRating: { $avg: '$rating' },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gte: 5 } } },
      { $sort: { avgRating: -1, count: -1 } },
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
          createdAt: '$restaurant.createdAt',
          avgRating: { $round: ['$avgRating', 2] },
          reviewCount: '$count'
        }
      }
    ];
    const result = await db.collection('reviews').aggregate(pipeline).toArray();
    const list = result.map(r => ({
      ...normalizeRestaurant(r),
      avgRating: r.avgRating,
      reviewCount: r.reviewCount
    }));
    return res.json(list);
  } catch (err) {
    console.error('Top restaurants report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 2. Platos más vendidos ────────────────────────────────────────────────────
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
    const list = result.map(r => ({
      menu_item_id: r.menu_item_id?.toString?.() ?? String(r.menu_item_id),
      name: r.name,
      totalQuantity: r.totalQuantity,
      price: r.price != null && typeof r.price?.toNumber === 'function'
        ? r.price.toNumber() : Number(r.price || 0),
      restaurant_id: r.restaurant_id?.toString?.() ?? (r.restaurant_id || null)
    }));
    return res.json(list);
  } catch (err) {
    console.error('Top dishes report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 3. Ingresos diarios por restaurante — últimos 30 días ─────────────────────
router.get('/daily-revenue', async (req, res) => {
  try {
    const { db } = await connect();
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const pipeline = [
      { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            restaurant: '$restaurant_id'
          },
          dailyRevenue: { $sum: '$total' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { '_id.day': -1 } },
      {
        $lookup: {
          from: 'restaurants',
          localField: '_id.restaurant',
          foreignField: '_id',
          as: 'restaurant'
        }
      },
      { $unwind: '$restaurant' },
      {
        $project: {
          _id: 0,
          day: '$_id.day',
          restaurant_id: '$_id.restaurant',
          restaurant: '$restaurant.name',
          dailyRevenue: { $round: ['$dailyRevenue', 2] },
          orders: 1
        }
      }
    ];

    const result = await db.collection('orders').aggregate(pipeline).toArray();
    const list = result.map(r => ({
      ...r,
      restaurant_id: r.restaurant_id?.toString?.() ?? String(r.restaurant_id)
    }));
    return res.json(list);
  } catch (err) {
    console.error('Daily revenue report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 4. Reseñas con mayor helpful_count + text search ─────────────────────────
router.get('/top-reviews', async (req, res) => {
  try {
    const { db } = await connect();
    const { q, limit: limitQ = 10 } = req.query;
    const limit = Math.min(parseInt(limitQ, 10) || 10, 50);

    const matchStage = {};
    if (q) matchStage.$text = { $search: String(q) };

    const pipeline = [
      ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
      { $sort: { helpful_count: -1, createdAt: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          rating: 1,
          title: 1,
          comment: 1,
          helpful_count: 1,
          createdAt: 1,
          restaurant_id: 1,
          order_id: 1,
          'user.name': 1,
          'user._id': 1
        }
      }
    ];

    const result = await db.collection('reviews').aggregate(pipeline).toArray();
    return res.json(result);
  } catch (err) {
    console.error('Top reviews report error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
router.get('/admin-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { db } = await connect();
    const countPipeline = [{ $count: 'total' }];
    const [usersRes, restaurantsRes, ordersRes] = await Promise.all([
      db.collection('users').aggregate(countPipeline).toArray(),
      db.collection('restaurants').aggregate(countPipeline).toArray(),
      db.collection('orders').aggregate(countPipeline).toArray(),
    ]);
    const users = usersRes[0]?.total ?? 0;
    const restaurants = restaurantsRes[0]?.total ?? 0;
    const orders = ordersRes[0]?.total ?? 0;
    return res.json({ users, restaurants, orders });
  } catch (err) {
    console.error('Admin stats error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 6. Explain (admin only) ───────────────────────────────────────────────────
router.get('/explain', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { db } = await connect();
    const { query: queryName } = req.query;
    const allowed = ['top_restaurants', 'top_dishes', 'daily_revenue', 'top_reviews', 'restaurants_list', 'orders_list'];
    if (!queryName || !allowed.includes(queryName)) {
      return res.status(400).json({ error: 'query param required', allowed: allowed.join(', ') });
    }

    let result;
    if (queryName === 'top_restaurants') {
      const pipeline = [
        { $match: { rating: { $exists: true } } },
        { $group: { _id: '$restaurant_id', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
        { $match: { count: { $gte: 5 } } },
        { $sort: { avgRating: -1 } },
        { $limit: 10 }
      ];
      result = await db.collection('reviews').aggregate(pipeline).explain('executionStats');
    } else if (queryName === 'top_dishes') {
      const pipeline = [
        { $match: { status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.menu_item_id', totalQuantity: { $sum: '$items.quantity' } } },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 }
      ];
      result = await db.collection('orders').aggregate(pipeline).explain('executionStats');
    } else if (queryName === 'daily_revenue') {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const pipeline = [
        { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },
        { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, restaurant: '$restaurant_id' }, dailyRevenue: { $sum: '$total' }, orders: { $sum: 1 } } },
        { $sort: { '_id.day': -1 } }
      ];
      result = await db.collection('orders').aggregate(pipeline).explain('executionStats');
    } else if (queryName === 'top_reviews') {
      const cursor = db.collection('reviews').find({}).sort({ helpful_count: -1, createdAt: -1 }).limit(10);
      result = await cursor.explain('executionStats');
    } else if (queryName === 'restaurants_list') {
      const cursor = db.collection('restaurants').find({}).sort({ 'rating.avg': -1 }).limit(20);
      result = await cursor.explain('executionStats');
    } else if (queryName === 'orders_list') {
      const cursor = db.collection('orders').find({}).sort({ createdAt: -1 }).limit(20);
      result = await cursor.explain('executionStats');
    }

    return res.json({ query: queryName, explain: result });
  } catch (err) {
    console.error('Explain endpoint error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;