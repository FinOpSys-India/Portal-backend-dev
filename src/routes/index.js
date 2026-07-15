'use strict';

const express = require('express');
const invitationRoutes = require('./invitationRoutes');
const router = express.Router();


// 1st step : calling the invitation routes
router.use("/invitations", invitationRoutes
);


module.exports = router;

/**
 * API route aggregator. Mount feature routers here, e.g.:
 *   const userRoutes = require('./user.routes');
 *   router.use('/users', userRoutes);
 */


// 1. Frontend form
//       ↓
// 2. Route
//       ↓
// 3. Controller
//       ↓
// 4. Database