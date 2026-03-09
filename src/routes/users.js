// src/routes/users.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connect } = require('../db');
const { ObjectId } = require('mongodb');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function stripUser(user) {
  if (!user) return user;
  const u = { ...user };
  delete u.password_hash;
  return u;
}

function normalizeAddress(address) {
  if (!address) return undefined;
  if (typeof address === 'string') return { street: address };
  if (typeof address === 'object') return address;
  return undefined;
}

/* ---------------------------
   Test endpoint 
   --------------------------- */
router.get('/test', async (req, res) => {
  try {
    const { email, id } = req.query;
    if (!email && !id) return res.status(400).json({ error: 'Provide ?email= or ?id=' });

    const { db } = await connect();
    let user;
    if (email) user = await db.collection('users').findOne({ email: email.toLowerCase() });
    else {
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
      user = await db.collection('users').findOne({ _id: new ObjectId(id) });
    }

    if (!user) return res.status(404).json({ error: 'User not found' });
    delete user.password_hash;
    return res.json(user);
  } catch (err) {
    console.error('Test endpoint error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   Register regular customer
   --------------------------- */
router.post('/register', async (req, res) => {
  try {
    console.log("REGISTER body:", req.body);
    let { name, email, password, phone, address } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    email = email.toLowerCase();
    address = normalizeAddress(address);

    const { db } = await connect();

    const role = 'customer';

    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);

    const doc = {
      name,
      email,
      password_hash,
      role,
      phone: phone || null,
      ...(address ? { address } : {}),
      preferences: { favorite_cuisines: [] },
      createdAt: new Date()
    };

    const r = await db.collection('users').insertOne(doc);

    const user = await db.collection('users').findOne({ _id: r.insertedId }, { projection: { password_hash: 0 } });

    const token = jwt.sign({ sub: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error', err);
    if (err.code === 11000) return res.status(409).json({ error: 'Email already registered (duplicate)' });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   Register staff 
   --------------------------- */
router.post('/register/staff', async (req, res) => {
  try {
    console.log("REGISTER STAFF body:", req.body);
    let { name, email, password, phone, address } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    email = email.toLowerCase();
    address = normalizeAddress(address);

    const { db } = await connect();

    const role = 'staff';

    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);

    const doc = {
      name,
      email,
      password_hash,
      role,
      phone: phone || null,
      ...(address ? { address } : {}),
      preferences: { favorite_cuisines: [] },
      createdAt: new Date()
    };

    const r = await db.collection('users').insertOne(doc);

    const user = await db.collection('users').findOne({ _id: r.insertedId }, { projection: { password_hash: 0 } });

    const token = jwt.sign({ sub: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register staff error', err);
    if (err.code === 11000) return res.status(409).json({ error: 'Email already registered (duplicate)' });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   Login 
   --------------------------- */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const { db } = await connect();
    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ sub: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ user: stripUser(user), token });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   GET / - list users 
   --------------------------- */
router.get('/', requireAuth, async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.split(' ')[1];
    let isAdmin = false;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      isAdmin = payload.role === 'admin';
    } catch (e) {
    }

    const { db } = await connect();
    if (!isAdmin) {
      const payload = jwt.verify(token, JWT_SECRET);
      const u = await db.collection('users').findOne({ _id: new ObjectId(payload.sub) });
      return res.json([stripUser(u)]);
    } else {
      const users = await db.collection('users').find().project({ password_hash: 0 }).toArray();
      return res.json(users);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   GET /:id 
   --------------------------- */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const targetId = req.params.id;
    const payload = jwt.verify((req.headers.authorization||'').split(' ')[1], JWT_SECRET);
    const requesterId = payload.sub;
    const requesterRole = payload.role;

    if (requesterRole !== 'admin' && requesterId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const user = await db.collection('users').findOne({ _id: new ObjectId(targetId) }, { projection: { password_hash: 0 } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: 'Bad request' });
  }
});

/* ---------------------------
   PUT /:id 
   --------------------------- */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const targetId = req.params.id;
    const payload = jwt.verify((req.headers.authorization||'').split(' ')[1], JWT_SECRET);
    const requesterId = payload.sub;
    const requesterRole = payload.role;

    if (requesterRole !== 'admin' && requesterId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const update = { ...req.body };
    delete update.role;
    if (update.password) {
      update.password_hash = await bcrypt.hash(update.password, 10);
      delete update.password;
    }
    if (update.address && typeof update.address === 'string') {
      update.address = { street: update.address };
    }
    update.updatedAt = new Date();

    await db.collection('users').updateOne({ _id: new ObjectId(targetId) }, { $set: update });
    const user = await db.collection('users').findOne({ _id: new ObjectId(targetId) }, { projection: { password_hash: 0 } });
    return res.json(user);
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: 'Bad request' });
  }
});

/* ---------------------------
   DELETE /:id
   --------------------------- */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { db } = await connect();
    const targetId = req.params.id;
    const payload = jwt.verify((req.headers.authorization||'').split(' ')[1], JWT_SECRET);
    const requesterId = payload.sub;
    const requesterRole = payload.role;

    if (requesterRole !== 'admin' && requesterId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.collection('users').deleteOne({ _id: new ObjectId(targetId) });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: 'Bad request' });
  }
});

/* ---------------------------
   PUT /:id/role
   --------------------------- */
router.put('/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    const valid = ['customer', 'staff', 'admin'];
    if (!role || !valid.includes(role)) return res.status(400).json({ error: 'role is required and must be one of: customer, staff, admin' });

    const { db } = await connect();
    const targetId = req.params.id;
    await db.collection('users').updateOne({ _id: new ObjectId(targetId) }, { $set: { role, updatedAt: new Date() } });
    const user = await db.collection('users').findOne({ _id: new ObjectId(targetId) }, { projection: { password_hash: 0 } });
    return res.json(user);
  } catch (err) {
    console.error('Set role error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;