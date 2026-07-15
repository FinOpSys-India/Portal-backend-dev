'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./config');
const routes = require('./routes');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// Core middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Portal backend API' });
});
app.use('/', routes);

// 404 + error handling (must be last)
app.use(notFound);
app.use(errorHandler);

module.exports = app;



/**
 * Build and configure the Express application. Kept separate from server
 * startup so it can be imported directly in tests.
 */