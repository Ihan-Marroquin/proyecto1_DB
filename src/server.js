require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connect } = require('./db');

const usersRoutes = require('./routes/users');
const restaurantsRoutes = require('./routes/restaurants');
const menuItemsRoutes = require('./routes/menu_items');
const ordersRoutes = require('./routes/orders');
const reviewsRoutes = require('./routes/reviews');
const categoriesRoutes = require('./routes/categories');
const reportsRoutes = require('./routes/reports');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

async function start() {
  await connect();
  app.use('/api/users', usersRoutes);
  app.use('/api/restaurants', restaurantsRoutes);
  app.use('/api/restaurants/:restaurantId/menu_items', menuItemsRoutes);
  app.use('/api/menu_items', menuItemsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/orders', ordersRoutes);
  app.use('/api/reviews', reviewsRoutes);
  app.use('/api/reports', reportsRoutes);
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
}

start().catch(err => {
  console.error("Failed to start", err);
  process.exit(1);
});