const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId, Double, Int32 } = require('mongodb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireIndex } = require('../lib/requireIndex');

router.post('/', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const requester = req.auth;

    if (!requester || !requester.role) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (requester.role !== 'staff' && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Staff or Admin required to create restaurants' });
    }

    const body = req.body || {};
    const { name, description, location, address, categories, phone, hours, images } = body;
    const ownerIdFromBody = body.owner_id;

    if (!name || !location || !address) {
      return res.status(400).json({ error: 'name, location and address are required' });
    }

    if (typeof location !== 'object' || location.type !== 'Point' || !Array.isArray(location.coordinates) || location.coordinates.length < 2) {
      return res.status(400).json({ error: 'location must be GeoJSON Point with coordinates [lng, lat]' });
    }
    const lng = Number(location.coordinates[0]);
    const lat = Number(location.coordinates[1]);
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      return res.status(400).json({ error: 'location.coordinates must be numeric [lng, lat]' });
    }
    const normalizedLocation = { type: 'Point', coordinates: [lng, lat] };

    if (typeof address !== 'object') {
      return res.status(400).json({ error: 'address must be an object with street, city, zip' });
    }
    if (!address.street || !address.city || !address.zip) {
      return res.status(400).json({ error: 'address.street, address.city and address.zip are required' });
    }

    let owner_id;
    if (requester.role === 'staff') {
      owner_id = requester.sub;
    } else {
      if (!ownerIdFromBody) return res.status(400).json({ error: 'owner_id is required when creating a restaurant as admin' });
      if (!ObjectId.isValid(ownerIdFromBody)) return res.status(400).json({ error: 'Invalid owner_id' });

      const ownerUser = await db.collection('users').findOne({ _id: new ObjectId(ownerIdFromBody) });
      if (!ownerUser) return res.status(404).json({ error: 'Owner user not found' });
      if (ownerUser.role !== 'staff') return res.status(400).json({ error: 'Owner user must be of role staff' });
      owner_id = ownerIdFromBody;
    }

    const doc = {
      name,
      description: description || '',
      location: normalizedLocation,
      address: {
        street: String(address.street),
        city: String(address.city),
        zip: String(address.zip)
      },
      categories: Array.isArray(categories) ? categories : (categories ? [categories] : []),
      phone: phone ? String(phone) : null,
      hours: typeof hours === 'object' ? hours : {},
      images: Array.isArray(images) ? images : [],
      owner_id: new ObjectId(owner_id),
      rating: { avg: new Double(0.0), count: new Int32(0) },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const r = await db.collection('restaurants').insertOne(doc);
    const restaurant = await db.collection('restaurants').findOne({ _id: r.insertedId });

    if (restaurant && restaurant.rating) {
      const avg = restaurant.rating.avg;
      restaurant.rating.avg = (typeof avg === 'number') ? avg
        : (avg && typeof avg.toNumber === 'function') ? avg.toNumber()
        : (avg && typeof avg.valueOf === 'function') ? avg.valueOf()
        : Number(avg);
      restaurant.rating.count = Number(restaurant.rating.count || 0);
    }

    return res.status(201).json(restaurant);
  } catch (err) {
    console.error('Create restaurant error', err);

    if (err && err.code === 121 && err.errInfo && err.errInfo.details) {
      const details = err.errInfo.details;
      const rules = details.schemaRulesNotSatisfied || [];
      const rulesMessages = rules.map(r => ({
        operatorName: r.operatorName,
        details: r.details || null
      }));
      return res.status(400).json({
        error: 'Document failed validation against collection schema',
        schemaErrors: rulesMessages,
        rawErr: err.errInfo
      });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { db } = await connect();
    const {
      q, category, lat, lng, maxDistance, skip = 0, limit = 20, sortBy = 'rating'
    } = req.query;

    const query = {};

    if (q) {
      query.$text = { $search: q };
    }

    if (category) {
      query.categories = category;
    }

    if (lat && lng) {
      const coords = [ parseFloat(lng), parseFloat(lat) ];
      const distance = maxDistance ? parseInt(maxDistance, 10) : 2000;
      query.location = {
        $near: {
          $geometry: { type: "Point", coordinates: coords },
          $maxDistance: distance
        }
      };
    }

    const projection = { };

    const sorter = {};
    if (sortBy === 'rating') sorter['rating.avg'] = -1;
    else if (sortBy === 'createdAt') sorter['createdAt'] = -1;

    const coll = db.collection('restaurants');
    const skipNum = parseInt(skip, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    await requireIndex(coll, query, { projection, sort: sorter, skip: skipNum, limit: limitNum });

    const restaurants = await coll
      .find(query)
      .project(projection)
      .sort(sorter)
      .skip(skipNum)
      .limit(limitNum)
      .toArray();

    return res.json(restaurants);
  } catch (err) {
    if (err.code === 'NO_INDEX') {
      return res.status(503).json({ error: err.message, code: 'NO_INDEX' });
    }
    console.error('List restaurants error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(id) });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    return res.json(restaurant);
  } catch (err) {
    console.error('Get restaurant error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const auth = req.headers.authorization || '';
    const token = auth.split(' ')[1];
    const requester = req.auth;

    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(id) });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const isAdmin = requester.role === 'admin';
    const isOwnerStaff = requester.role === 'staff' && restaurant.owner_id && restaurant.owner_id.toString() === requester.sub;

    if (!isAdmin && !isOwnerStaff) return res.status(403).json({ error: 'Forbidden' });

    const allowed = ['name','description','location','address','categories','phone','hours','images','owner_id'];
    const update = {};
    for (const k of allowed) {
      if (k in req.body) update[k] = req.body[k];
    }

    if (update.owner_id) {
      if (!ObjectId.isValid(update.owner_id)) return res.status(400).json({ error: 'Invalid owner_id' });
      const owner = await db.collection('users').findOne({ _id: new ObjectId(update.owner_id) });
      if (!owner) return res.status(404).json({ error: 'Owner user not found' });
      if (owner.role !== 'staff') return res.status(400).json({ error: 'Owner user must be of role staff' });
      update.owner_id = new ObjectId(update.owner_id);
    }

    update.updatedAt = new Date();

    await db.collection('restaurants').updateOne({ _id: new ObjectId(id) }, { $set: update });
    const updated = await db.collection('restaurants').findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (err) {
    console.error('Update restaurant error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    await db.collection('restaurants').deleteOne({ _id: new ObjectId(id) });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete restaurant error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;