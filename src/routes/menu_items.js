const express = require('express');
const router = express.Router({ mergeParams: true });
const { connect } = require('../db');
const { ObjectId, Double } = require('mongodb');
const { requireAuth, requireAdmin } = require('../middleware/auth');

function toDouble(value) {
  const n = Number(value || 0);
  return new Double(Number.isFinite(n) ? n : 0.0);
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const requester = req.auth;

    if (!requester || !requester.role) return res.status(401).json({ error: 'Not authenticated' });

    const body = req.body || {};

    const restaurantIdFromUrl = req.params.restaurantId;
    let restaurant_id = restaurantIdFromUrl || body.restaurant_id;

    const { name, description, price, currency, categories, tags, ingredients, available, images } = body;

    if ((!restaurant_id || !ObjectId.isValid(restaurant_id)) && requester.role === 'staff') {
      const myRestaurant = await db
        .collection('restaurants')
        .findOne({ owner_id: new ObjectId(requester.sub) });

      if (myRestaurant) {
        restaurant_id = myRestaurant._id.toString();
      }
    }

    if (!restaurant_id || !ObjectId.isValid(restaurant_id)) {
      return res.status(400).json({
        error: 'restaurant_id is required and must be valid (or be resolved for this staff user)'
      });
    }
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (price === undefined || price === null) return res.status(400).json({ error: 'price is required' });
    if (!currency) return res.status(400).json({ error: 'currency is required' });

    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(restaurant_id) });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    if (requester.role === 'staff') {
      if (!restaurant.owner_id || restaurant.owner_id.toString() !== requester.sub) {
        return res.status(403).json({ error: 'Staff can only manage menu items of their own restaurant' });
      }
    } else if (requester.role !== 'admin') {
      return res.status(403).json({ error: 'Only staff (owner) or admin can create menu items' });
    }

    const doc = {
      restaurant_id: new ObjectId(restaurant_id),
      name: String(name),
      description: description ? String(description) : '',
      price: toDouble(price),
      currency: String(currency),
      categories: Array.isArray(categories) ? categories : (categories ? [String(categories)] : []),
      tags: Array.isArray(tags) ? tags : (tags ? [String(tags)] : []),
      ingredients: Array.isArray(ingredients) ? ingredients : (ingredients ? [String(ingredients)] : []),
      available: typeof available === 'boolean' ? available : true,
      images: Array.isArray(images) ? images : [],
      createdAt: new Date()
    };

    const r = await db.collection('menu_items').insertOne(doc);
    const item = await db.collection('menu_items').findOne({ _id: r.insertedId });
    if (item && item.price && typeof item.price.toNumber === 'function') {
      item.price = item.price.toNumber();
    } else {
      item.price = Number(item.price || 0);
    }

    return res.status(201).json(item);
  } catch (err) {
    console.error('Create menu_item error', err);
    if (err && err.code === 121 && err.errInfo) {
      return res.status(400).json({ error: 'Document failed validation', rawErr: err.errInfo });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const { restaurant_id: restaurantIdQuery, q, category, available, skip = 0, limit = 50, sortBy = 'name' } = req.query;

    const restaurantIdFromUrl = req.params.restaurantId;
    const restaurant_id = restaurantIdFromUrl || restaurantIdQuery;

    const query = {};
    if (restaurant_id) {
      if (!ObjectId.isValid(restaurant_id)) return res.status(400).json({ error: 'Invalid restaurant_id' });
      query.restaurant_id = new ObjectId(restaurant_id);
    }

    if (q) query.$text = { $search: q };
    if (category) query.categories = category;
    if (available !== undefined) query.available = (available === 'true' || available === true);

    const sorter = sortBy === 'price' ? { price: 1 } : { name: 1 };

    const cursor = db.collection('menu_items').find(query).sort(sorter)
      .skip(parseInt(skip, 10)).limit(Math.min(parseInt(limit, 10), 200));
    const items = await cursor.toArray();
    for (const it of items) {
      if (it.price && typeof it.price.toNumber === 'function') it.price = it.price.toNumber();
      else it.price = Number(it.price || 0);
    }

    return res.json(items);
  } catch (err) {
    console.error('List menu_items error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const { db } = await connect();
    const item = await db.collection('menu_items').findOne({ _id: new ObjectId(id) });
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    if (item.price && typeof item.price.toNumber === 'function') item.price = item.price.toNumber();
    else item.price = Number(item.price || 0);

    return res.json(item);
  } catch (err) {
    console.error('Get menu_item error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const requester = req.auth;
    if (!requester || !requester.role) return res.status(401).json({ error: 'Not authenticated' });

    const item = await db.collection('menu_items').findOne({ _id: new ObjectId(id) });
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(item.restaurant_id) });
    if (!restaurant) return res.status(404).json({ error: 'Parent restaurant not found' });

    const isAdmin = requester.role === 'admin';
    const isOwnerStaff = requester.role === 'staff' && restaurant.owner_id && restaurant.owner_id.toString() === requester.sub;
    if (!isAdmin && !isOwnerStaff) return res.status(403).json({ error: 'Forbidden' });

    const allowed = ['name','description','price','currency','categories','tags','ingredients','available','images'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];

    if ('price' in update) update.price = toDouble(update.price);
    if ('categories' in update && !Array.isArray(update.categories)) update.categories = [String(update.categories)];
    if ('tags' in update && !Array.isArray(update.tags)) update.tags = [String(update.tags)];
    if ('ingredients' in update && !Array.isArray(update.ingredients)) update.ingredients = [String(update.ingredients)];
    if ('available' in update) update.available = !!update.available;

    await db.collection('menu_items').updateOne({ _id: new ObjectId(id) }, { $set: update });
    const updated = await db.collection('menu_items').findOne({ _id: new ObjectId(id) });

    if (updated.price && typeof updated.price.toNumber === 'function') updated.price = updated.price.toNumber();
    else updated.price = Number(updated.price || 0);

    return res.json(updated);
  } catch (err) {
    console.error('Update menu_item error', err);
    if (err && err.code === 121 && err.errInfo) return res.status(400).json({ error: 'Document failed validation', rawErr: err.errInfo });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const requester = req.auth;
    const item = await db.collection('menu_items').findOne({ _id: new ObjectId(id) });
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(item.restaurant_id) });
    if (!restaurant) return res.status(404).json({ error: 'Parent restaurant not found' });

    const isAdmin = requester.role === 'admin';
    const isOwnerStaff = requester.role === 'staff' && restaurant.owner_id && restaurant.owner_id.toString() === requester.sub;
    if (!isAdmin && !isOwnerStaff) return res.status(403).json({ error: 'Forbidden' });

    await db.collection('menu_items').deleteOne({ _id: new ObjectId(id) });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete menu_item error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;