const jwt = require('jsonwebtoken');
const { connect } = require('../db');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn("Warning: JWT_SECRET not set in .env");
}

async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { db } = await connect();
    const user = await db.collection('users').findOne({ _id: new ObjectId(payload.sub) });
    if (!user) return null;
    delete user.password_hash;
    return user;
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function attachUser(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return next();
  const token = auth.split(' ')[1];
  try {
    const user = await getUserFromToken(token);
    if (user) req.user = user;
  } catch (err) {}
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  return next();
}

function requireStaff(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
  if (req.auth.role !== 'staff' && req.auth.role !== 'admin') return res.status(403).json({ error: 'Staff or Admin required' });
  return next();
}

module.exports = { requireAuth, requireAdmin, attachUser, getUserFromToken, requireStaff };