// src/routes/categories.js
const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');

/* ---------------------------
   GET /api/categories
   Lista todas las categorías.
   Soporta ?q= para búsqueda por nombre (case-insensitive).
   --------------------------- */
router.get('/', async (req, res) => {
  try {
    const { db } = await connect();
    const { q } = req.query;

    const query = {};
    if (q) {
      query.name = { $regex: String(q), $options: 'i' };
    }

    const categories = await db
      .collection('categories')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    return res.json(categories);
  } catch (err) {
    console.error('List categories error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   POST /api/categories
   Crea una nueva categoría.
   Sólo staff/admin pueden crear.
   --------------------------- */
router.post('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const { db } = await connect();
    const body = req.body || {};
    let { name, description, id } = body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    name = String(name).trim();
    description = description ? String(description) : '';

    // si no viene un id explícito, generar un slug simple a partir del nombre
    if (!id) {
      id = name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // quitar acentos
        .replace(/[^a-z0-9]+/g, '_')     // no alfanum -> _
        .replace(/^_+|_+$/g, '');        // trim _
    }

    // validar unicidad por name o id
    const existing = await db.collection('categories').findOne({
      $or: [{ name }, { id }],
    });
    if (existing) {
      return res.status(409).json({ error: 'Category already exists' });
    }

    const doc = {
      name,
      description,
      id, // usamos un campo id legible además del _id de Mongo
      createdAt: new Date(),
    };

    const r = await db.collection('categories').insertOne(doc);
    const created = await db
      .collection('categories')
      .findOne({ _id: r.insertedId });

    return res.status(201).json(created);
  } catch (err) {
    console.error('Create category error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

// src/routes/categories.js
const express = require('express');
const router = express.Router();
const { connect } = require('../db');
const { ObjectId } = require('mongodb');
const { requireAuth, requireStaff } = require('../middleware/auth');

/* ---------------------------
   GET /api/categories
   Lista todas las categorías.
   Soporta ?q= para búsqueda por nombre (case-insensitive).
   --------------------------- */
router.get('/', async (req, res) => {
  try {
    const { db } = await connect();
    const { q } = req.query;

    const query = {};
    if (q) {
      query.name = { $regex: String(q), $options: 'i' };
    }

    const categories = await db
      .collection('categories')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    return res.json(categories);
  } catch (err) {
    console.error('List categories error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ---------------------------
   POST /api/categories
   Crea una nueva categoría.
   Sólo staff/admin pueden crear.
   --------------------------- */
router.post('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const { db } = await connect();
    const body = req.body || {};
    let { name, description, id } = body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    name = String(name).trim();
    description = description ? String(description) : '';

    // si no viene un id explícito, generar un slug simple a partir del nombre
    if (!id) {
      id = name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // quitar acentos
        .replace(/[^a-z0-9]+/g, '_')     // no alfanum -> _
        .replace(/^_+|_+$/g, '');        // trim _
    }

    // validar unicidad por name o id
    const existing = await db.collection('categories').findOne({
      $or: [{ name }, { id }],
    });
    if (existing) {
      return res.status(409).json({ error: 'Category already exists' });
    }

    const doc = {
      name,
      description,
      id, // usamos un campo id legible además del _id de Mongo
      createdAt: new Date(),
    };

    const r = await db.collection('categories').insertOne(doc);
    const created = await db
      .collection('categories')
      .findOne({ _id: r.insertedId });

    return res.status(201).json(created);
  } catch (err) {
    console.error('Create category error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

